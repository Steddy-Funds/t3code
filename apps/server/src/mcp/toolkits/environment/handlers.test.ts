import { describe, expect, it } from "@effect/vitest";
import {
  BucketEditedError,
  ClaimId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MACHINE_BUCKETS_THREAD_TAG,
  type MachineActor,
  type MachineBucket,
  MachineBucketId,
  type MachineStatusSnapshot,
  type ThreadResourceTotals,
  MachineClaimError,
  MACHINE_PROCESS_SNAPSHOT_MAX_LIMIT,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HostProcesses from "../../../resourceTelemetry/HostProcesses.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as ProcessOwnership from "../../../resourceTelemetry/ProcessOwnership.ts";
import * as ThreadResources from "../../../resourceTelemetry/ThreadResources.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");
const layerMachineRead = (
  fakes: {
    readonly hostProcesses?: Partial<HostProcesses.HostProcesses["Service"]>;
    readonly hostResources?: Partial<HostResources.HostResources["Service"]>;
  } = {},
) =>
  Layer.mergeAll(
    Layer.mock(HostProcesses.HostProcesses)(fakes.hostProcesses ?? {}),
    Layer.mock(HostResources.HostResources)(fakes.hostResources ?? {}),
  );
const layerMachineReadUnused = layerMachineRead();

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      layerMachineReadUnused,
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);

const ownerThreadId = ThreadId.make("thread:machine-owner");
const bucketId = MachineBucketId.make("bucket:dev");
const claimTarget = { type: "process" as const, pid: 4242, startTimeMs: 1_000 };
const at = DateTime.makeUnsafe(0);

interface MachineReadFakes {
  readonly hostProcesses?: Partial<HostProcesses.HostProcesses["Service"]>;
  readonly hostResources?: Partial<HostResources.HostResources["Service"]>;
  readonly threadResources?: Partial<ThreadResources.ThreadResourcesShape>;
  readonly client?: McpInvocationContext.McpClientCaller;
  /** Shells other than the caller's; a missing id reads as a live thread. */
  readonly shells?: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell | null | "fail">;
}

const machineHarness = (
  shell: OrchestrationV2ThreadShell,
  ownership: Partial<ProcessOwnership.ProcessOwnershipShape> = {},
  machine: MachineReadFakes = {},
) =>
  Effect.gen(function* () {
    const actors = yield* Ref.make<ReadonlyArray<{ readonly op: string; readonly actor: unknown }>>(
      [],
    );
    const record = (op: string, actor: unknown) =>
      Ref.update(actors, (all) => [...all, { op, actor }]);
    const fake: ProcessOwnership.ProcessOwnershipShape = {
      ...ProcessOwnership.ProcessOwnership.defaultValue(),
      claim: (input, actor) =>
        record("claim", { input, actor }).pipe(
          Effect.as({
            id: ClaimId.make("claim:1"),
            threadId: input.threadId,
            target: input.target,
            createdAt: at,
            createdBy: actor,
          }),
        ),
      upsertBucket: (input, actor) =>
        record("upsert", actor).pipe(
          Effect.as({
            ...input,
            provenance: { createdBy: actor, updatedBy: actor, updatedAt: at },
          } satisfies MachineBucket),
        ),
      ...ownership,
    };
    const dependencies = Layer.mergeAll(
      layerMachineRead(machine),
      Layer.succeed(ThreadResources.ThreadResources, {
        ...ThreadResources.ThreadResources.defaultValue(),
        ...machine.threadResources,
      }),
      ThreadCommandExecutor.layer,
      Layer.succeed(ProcessOwnership.ProcessOwnership, fake),
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => new Uint8Array(size).fill(7)),
      ),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:machine",
        thread:
          machine.client === undefined
            ? {
                threadId: shell.id,
                providerSessionId: "provider:machine",
                providerInstanceId: ProviderInstanceId.make("codex"),
              }
            : undefined,
        client: machine.client,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => {
          const other = machine.shells?.get(id);
          if (other === "fail")
            return Effect.fail(new Orchestrator.OrchestratorProjectionError({ threadId: id }));
          return Effect.succeed(
            id === shell.id ? shell : other === undefined ? liveThreadShell(id) : other,
          );
        },
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
    );
    const call = (
      name: "t3_machine_buckets" | "t3_resource_claim" | "t3_machine_read",
      params: object,
    ) =>
      Effect.gen(function* () {
        const toolkit = yield* EnvironmentToolkit;
        const handled = yield* toolkit
          .handle(name, params as never)
          .pipe(Stream.unwrap, Stream.runCollect);
        return handled.at(-1)?.result;
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
            Layer.provideMerge(dependencies),
          ),
        ),
      );
    return { call, actors: Ref.get(actors) };
  });

it.effect("claims for the calling thread as its agent, and buckets as auto when tagged", () =>
  Effect.gen(function* () {
    const plain = yield* machineHarness(liveThreadShell(ownerThreadId));
    yield* plain.call("t3_resource_claim", { action: "claim", target: claimTarget });
    yield* plain.call("t3_machine_buckets", {
      action: "upsert",
      bucket: { id: bucketId, name: "Dev", rules: [] },
    });
    const agent: MachineActor = { type: "agent", threadId: ownerThreadId };
    expect(yield* plain.actors).toEqual([
      {
        op: "claim",
        actor: { input: { threadId: ownerThreadId, target: claimTarget }, actor: agent },
      },
      { op: "upsert", actor: agent },
    ]);

    const tagged = yield* machineHarness({
      ...liveThreadShell(ownerThreadId),
      tags: [MACHINE_BUCKETS_THREAD_TAG],
    });
    yield* tagged.call("t3_machine_buckets", {
      action: "upsert",
      bucket: { name: "Dev", rules: [] },
    });
    expect(yield* tagged.actors).toEqual([
      { op: "upsert", actor: { type: "auto", threadId: ownerThreadId } },
    ]);
  }),
);

it.effect("refuses claims and bucket writes from work a fenced link started, but lists", () =>
  Effect.gen(function* () {
    const linked = yield* machineHarness({
      ...liveThreadShell(ownerThreadId),
      linkOrigin: { sessionId: "session:laptop", label: "Laptop", access: "approval-required" },
    });
    const claim = yield* linked.call("t3_resource_claim", {
      action: "claim",
      target: claimTarget,
    });
    const release = yield* linked.call("t3_resource_claim", {
      action: "release",
      claimId: "claim:1",
    });
    const bucket = yield* linked.call("t3_machine_buckets", { action: "delete", bucketId });
    for (const result of [claim, release, bucket]) {
      expect(result).toMatchObject({
        code: "capability_denied",
        message: expect.stringContaining("Laptop"),
      });
    }
    expect(yield* linked.call("t3_resource_claim", { action: "list" })).toEqual({ claims: [] });
    expect(yield* linked.call("t3_machine_buckets", { action: "list" })).toEqual({ buckets: [] });
    expect(yield* linked.actors).toEqual([]);
  }),
);

it.effect("maps ownership errors to tool failures", () =>
  Effect.gen(function* () {
    const cases = [
      [new MachineClaimError({ reason: "refused", detail: "No." }), "capability_denied"],
      [new MachineClaimError({ reason: "not-found", detail: "Gone." }), "invalid_request"],
    ] as const;
    for (const [error, code] of cases) {
      const harness = yield* machineHarness(liveThreadShell(ownerThreadId), {
        claim: () => Effect.fail(error),
      });
      expect(
        yield* harness.call("t3_resource_claim", { action: "claim", target: claimTarget }),
      ).toMatchObject({ code, message: error.detail });
    }
    const edited = yield* machineHarness(liveThreadShell(ownerThreadId), {
      upsertBucket: () => Effect.fail(new BucketEditedError({ bucketId })),
    });
    expect(
      yield* edited.call("t3_machine_buckets", {
        action: "upsert",
        bucket: { id: bucketId, name: "Dev", rules: [] },
      }),
    ).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("someone else"),
    });
  }),
);

const stressedStatus: MachineStatusSnapshot = {
  sequence: 3,
  verdict: "stressed",
  verdictAgeMs: 4_000,
  reason: { rule: "load", value: 2.5, threshold: 2, heldForMs: 30_000 },
  sampleAgeMs: 1_200,
  totals: {
    cpuUtilization: 0.97,
    cpuCount: 2,
    load: { one: 5, five: 3, fifteen: 1 },
    memoryTotalBytes: 16_000,
    memoryAvailableBytes: 4_000,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
    memoryPressure: null,
  },
};
const usage: ThreadResourceTotals = {
  cpuPercent: 80,
  memoryBytes: 1_000,
  gpuUtilPercent: null,
  vramBytes: null,
  processCount: 3,
  sampleAgeMs: 500,
  source: "sample",
};
const busyThread = ThreadId.make("thread:busy");
const deletedThread = ThreadId.make("thread:deleted");
const goneThread = ThreadId.make("thread:gone");
const brokenThread = ThreadId.make("thread:broken");
const peerClient = {
  sessionId: "session:laptop",
  label: "Laptop",
  access: "full-access",
  linked: true,
} as const;

/** A machine whose walk records the input it was given and lists one process. */
const machineReadHarness = (
  shell: OrchestrationV2ThreadShell,
  overrides: Omit<MachineReadFakes, "hostResources"> & {
    readonly status?: ReadonlyArray<MachineStatusSnapshot>;
    readonly walkFails?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const walks = yield* Ref.make<ReadonlyArray<HostProcesses.ProcessSnapshotInput>>([]);
    const harness = yield* machineHarness(
      shell,
      {},
      {
        shells: new Map<ThreadId, OrchestrationV2ThreadShell | null | "fail">([
          [deletedThread, { ...liveThreadShell(deletedThread), deletedAt: at }],
          [goneThread, null],
          [brokenThread, "fail"],
        ]),
        ...overrides,
        hostResources: {
          status: Stream.fromIterable(overrides.status ?? [stressedStatus]),
          samples: () => Effect.succeed(Stream.make({ perCore: [99.6, 12.2] })),
        },
        hostProcesses: {
          snapshot: (input) =>
            Ref.update(walks, (all) => [...all, input]).pipe(
              Effect.andThen(
                overrides.walkFails === true
                  ? Effect.fail(new HostProcesses.HostProcessesUnavailable())
                  : Effect.succeed(
                      HostProcesses.buildProcessSnapshot({
                        ...input,
                        rows: [
                          {
                            identity: "7:70",
                            pid: 7,
                            ppid: 1,
                            name: "node",
                            user: "dev",
                            command: "node build.js --token=PRIVATE",
                            cpuPercent: 90,
                            rssBytes: 500,
                            gpuUtilPercent: null,
                            vramBytes: null,
                          },
                        ],
                        owners: new Map([["7:70", { type: "bucket", bucketId }]]),
                        source: "host",
                        sampleAgeMs: 100,
                      }),
                    ),
              ),
            ),
        },
        threadResources: {
          byThread: Effect.succeed(
            new Map([
              [busyThread, usage],
              [deletedThread, usage],
              [goneThread, usage],
              [brokenThread, usage],
            ]),
          ),
          read: (id) =>
            Effect.succeed({
              current: id === busyThread ? usage : null,
              history: Array.from({ length: 30 }, (_, index) => ({
                ageMs: (30 - index) * 30_000,
                cpuPercent: index,
                memoryBytes: 1_000,
                gpuUtilPercent: null,
              })),
            }),
        },
      },
    );
    return { ...harness, walks: Ref.get(walks) };
  });

it.effect("reads the verdict, totals, per-core use, bucket totals and running threads", () =>
  Effect.gen(function* () {
    const harness = yield* machineReadHarness(liveThreadShell(ownerThreadId));
    const result = yield* harness.call("t3_machine_read", {});
    expect(result).toEqual({
      verdict: "stressed",
      reason: stressedStatus.reason,
      sampleAgeMs: 1_200,
      totals: stressedStatus.totals,
      perCore: [100, 12],
      buckets: [{ bucketId, name: bucketId, cpuPercent: 90, rssBytes: 500, count: 1 }],
      runningThreads: [{ threadId: busyThread, title: busyThread, usage }],
    });
    // Without `processes` it still walks for bucket totals, but lists none and skips GPUs.
    expect(yield* harness.walks).toEqual([
      expect.objectContaining({ limit: 0, groupBy: "none", commands: true }),
    ]);
  }),
);

it.effect("lists processes with command lines only for callers not on a peer link", () =>
  Effect.gen(function* () {
    const params = { processes: { groupBy: "owner" } };
    const local = yield* machineReadHarness(liveThreadShell(ownerThreadId));
    const localResult = yield* local.call("t3_machine_read", params);
    expect(localResult).toMatchObject({
      processes: {
        source: "host",
        processes: [{ pid: 7, name: "node", command: "node build.js --token=PRIVATE" }],
        groups: [{ label: bucketId, bucketId, count: 1 }],
      },
    });
    expect(yield* local.walks).toEqual([
      expect.objectContaining({ limit: 20, groupBy: "owner", commands: true }),
    ]);

    for (const linked of [
      yield* machineReadHarness(liveThreadShell(ownerThreadId), { client: peerClient }),
      yield* machineReadHarness({
        ...liveThreadShell(ownerThreadId),
        linkOrigin: { sessionId: "session:laptop", label: "Laptop", access: "full-access" },
      }),
    ]) {
      const result = yield* linked.call("t3_machine_read", params);
      expect(result).toMatchObject({
        processes: { processes: [{ pid: 7, name: "node", user: "dev", cpuPercent: 90 }] },
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      expect(yield* linked.walks).toEqual([expect.objectContaining({ commands: false })]);
    }
  }),
);

it.effect("passes every grouping and the largest limit through to the walk", () =>
  Effect.gen(function* () {
    const harness = yield* machineReadHarness(liveThreadShell(ownerThreadId));
    for (const groupBy of ["none", "owner", "bucket"] as const) {
      yield* harness.call("t3_machine_read", {
        processes: { groupBy, limit: MACHINE_PROCESS_SNAPSHOT_MAX_LIMIT },
      });
    }
    expect((yield* harness.walks).map(({ limit, groupBy }) => [limit, groupBy])).toEqual([
      [200, "none"],
      [200, "owner"],
      [200, "bucket"],
    ]);
  }),
);

describe("t3_machine_read parameters", () => {
  const decode = Schema.decodeUnknownExit(
    EnvironmentToolkit.tools.t3_machine_read.parametersSchema,
  );
  it.each([
    [{ processes: { limit: 1 } }],
    [{ processes: { limit: MACHINE_PROCESS_SNAPSHOT_MAX_LIMIT, groupBy: "bucket" } }],
    [{ processes: {} }],
    [{ show: true, threadId: "thread:1" }],
  ])("accepts %j", (params) => {
    expect(Exit.isSuccess(decode(params))).toBe(true);
  });
  it.each([
    [{ processes: { limit: MACHINE_PROCESS_SNAPSHOT_MAX_LIMIT + 1 } }],
    [{ processes: { limit: 0 } }],
    [{ processes: { limit: 2.5 } }],
    [{ processes: { groupBy: "thread" } }],
  ])("refuses %j", (params) => {
    expect(Exit.isFailure(decode(params))).toBe(true);
  });
});

it.effect("reports an unavailable walk only when processes were asked for", () =>
  Effect.gen(function* () {
    const harness = yield* machineReadHarness(liveThreadShell(ownerThreadId), { walkFails: true });
    const withProcesses = yield* harness.call("t3_machine_read", { processes: {} });
    expect(withProcesses).toMatchObject({
      verdict: "stressed",
      processesUnavailable: new HostProcesses.HostProcessesUnavailable().message,
    });
    expect(withProcesses).not.toHaveProperty("processes");
    expect(withProcesses).not.toHaveProperty("buckets");

    const plain = yield* harness.call("t3_machine_read", {});
    expect(plain).toMatchObject({ verdict: "stressed", runningThreads: expect.any(Array) });
    expect(plain).not.toHaveProperty("processesUnavailable");
    expect(plain).not.toHaveProperty("buckets");
  }),
);

it.effect("adds a thread's current use and its last twenty points", () =>
  Effect.gen(function* () {
    const harness = yield* machineReadHarness(liveThreadShell(ownerThreadId));
    const result = yield* harness.call("t3_machine_read", { threadId: busyThread });
    expect(result).toMatchObject({ thread: { threadId: busyThread, current: usage } });
    const recent = (result as { thread: { recent: ReadonlyArray<{ cpuPercent: number }> } }).thread
      .recent;
    expect(recent.map((point) => point.cpuPercent)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 10),
    );

    for (const missing of [deletedThread, goneThread]) {
      expect(yield* harness.call("t3_machine_read", { threadId: missing })).toMatchObject({
        code: "thread_not_found",
      });
    }
  }),
);

it.effect("adds a machine card with this server's id only when asked to show it", () =>
  Effect.gen(function* () {
    const harness = yield* machineReadHarness(liveThreadShell(ownerThreadId), {
      client: peerClient,
    });
    const shown = yield* harness.call("t3_machine_read", { show: true });
    expect(shown).toMatchObject({
      machineCard: {
        environmentId,
        snapshot: {
          verdict: "stressed",
          reason: stressedStatus.reason,
          totals: stressedStatus.totals,
        },
      },
    });
    expect(
      Object.keys((shown as { machineCard: { snapshot: object } }).machineCard.snapshot),
    ).toEqual(["verdict", "reason", "totals"]);
    expect(yield* harness.call("t3_machine_read", { show: false })).not.toHaveProperty(
      "machineCard",
    );
    expect(yield* harness.call("t3_machine_read", {})).not.toHaveProperty("machineCard");
  }),
);

it.effect("fails as unavailable when no status arrives, and reads an empty per-core sample", () =>
  Effect.gen(function* () {
    const silent = yield* machineReadHarness(liveThreadShell(ownerThreadId), { status: [] });
    expect(yield* silent.call("t3_machine_read", {})).toMatchObject({ code: expect.any(String) });
    expect(yield* silent.call("t3_machine_read", {})).not.toHaveProperty("verdict");

    const noSample = yield* machineHarness(
      liveThreadShell(ownerThreadId),
      {},
      {
        hostResources: {
          status: Stream.make(stressedStatus),
          samples: () => Effect.succeed(Stream.empty),
        },
        hostProcesses: {
          snapshot: () => Effect.fail(new HostProcesses.HostProcessesUnavailable()),
        },
      },
    );
    expect(yield* noSample.call("t3_machine_read", {})).toMatchObject({ perCore: [] });
  }),
);

describe("t3_machine_read unbucketed", () => {
  /** A machine whose unbucketed walk records its input and lists one process. */
  const unbucketedHarness = (client?: McpInvocationContext.McpClientCaller) =>
    Effect.gen(function* () {
      const walks = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const record = (kind: string) => (input: object) =>
        Ref.update(walks, (all) => [...all, { kind, ...input }]);
      const harness = yield* machineHarness(
        liveThreadShell(ownerThreadId),
        {},
        {
          ...(client === undefined ? {} : { client }),
          hostResources: {
            status: Stream.make(stressedStatus),
            samples: () => Effect.succeed(Stream.make({ perCore: [50] })),
          },
          hostProcesses: {
            snapshot: (input) =>
              record("snapshot")(input).pipe(
                Effect.as({
                  buckets: [],
                  snapshot: { source: "host", sampleAgeMs: 0, processes: [] },
                } as never),
              ),
            unbucketed: (input) =>
              record("unbucketed")(input).pipe(
                Effect.as({
                  sharePercent: 40,
                  sampleAgeMs: 100,
                  processes: [
                    {
                      pid: 7,
                      ppid: 1,
                      name: "postgres",
                      exe: "/usr/bin/postgres",
                      ...(input.commands
                        ? { command: "postgres --password=PRIVATE", cwd: "/srv/PRIVATE" }
                        : {}),
                      user: "dev",
                      cpuPercent: 30,
                      rssBytes: 500,
                    },
                  ],
                  truncated: 3,
                  buckets: [{ bucketId, name: "Builds", cpuPercent: 5, rssBytes: 10, count: 1 }],
                }),
              ),
          },
        },
      );
      return { ...harness, walks: Ref.get(walks) };
    });

  it.effect("returns the unbucketed processes and share in place of the process table", () =>
    Effect.gen(function* () {
      const harness = yield* unbucketedHarness();
      const result = yield* harness.call("t3_machine_read", {
        processes: { unbucketed: true, limit: 50 },
      });
      expect(result).toMatchObject({
        buckets: [{ bucketId, name: "Builds", count: 1 }],
        unbucketed: {
          sharePercent: 40,
          sampleAgeMs: 100,
          truncated: 3,
          processes: [{ pid: 7, name: "postgres", command: "postgres --password=PRIVATE" }],
        },
      });
      expect(result).not.toHaveProperty("processes");
      expect(result).not.toHaveProperty("unbucketed.buckets");
      expect(yield* harness.walks).toEqual([
        expect.objectContaining({ kind: "unbucketed", limit: 50, commands: true }),
      ]);
    }),
  );

  it.effect("gives a linked caller no command lines or working directories", () =>
    Effect.gen(function* () {
      const harness = yield* unbucketedHarness(peerClient);
      const result = yield* harness.call("t3_machine_read", {
        processes: { unbucketed: true },
      });
      expect(result).toMatchObject({ unbucketed: { processes: [{ pid: 7, name: "postgres" }] } });
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
      expect(yield* harness.walks).toEqual([
        expect.objectContaining({ kind: "unbucketed", limit: 20, commands: false }),
      ]);
    }),
  );
});
