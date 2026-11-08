import { expect, it } from "@effect/vitest";
import {
  BucketEditedError,
  ClaimId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MACHINE_BUCKETS_THREAD_TAG,
  type MachineActor,
  type MachineBucket,
  MachineBucketId,
  MachineClaimError,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessOwnership from "../../../resourceTelemetry/ProcessOwnership.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
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

const machineHarness = (
  shell: OrchestrationV2ThreadShell,
  ownership: Partial<ProcessOwnership.ProcessOwnershipShape> = {},
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
      ThreadCommandExecutor.layer,
      Layer.succeed(ProcessOwnership.ProcessOwnership, fake),
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => new Uint8Array(size).fill(7)),
      ),
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:machine",
        thread: {
          threadId: shell.id,
          providerSessionId: "provider:machine",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(id === shell.id ? shell : liveThreadShell(id)),
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
    const call = (name: "t3_machine_buckets" | "t3_resource_claim", params: object) =>
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
