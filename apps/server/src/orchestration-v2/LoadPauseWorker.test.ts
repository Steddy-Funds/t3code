import { assert, describe, it } from "@effect/vitest";
import {
  ClaimId,
  CommandId,
  EnvironmentId,
  EventId,
  LOAD_PAUSE_MAX_MS,
  type MachineStatusSnapshot,
  type MachineTotalsSummary,
  MessageId,
  type OrchestrationV2LoadPausedContainer,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  ThreadId,
  type ThreadResourceTotals,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import { ProcessOwnership, type ResolvedClaim } from "../resourceTelemetry/ProcessOwnership.ts";
import { ThreadResources } from "../resourceTelemetry/ThreadResources.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventStore from "./EventStore.ts";
import {
  LOAD_PAUSE_FOCUS_WINDOW_MS,
  LOAD_PAUSE_REPAUSE_COOLDOWN_MS,
  LOAD_RESUME_GAP_MS,
} from "./LoadPausePolicy.ts";
import * as LoadPauseWorker from "./LoadPauseWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

class Unpaused extends Context.Service<
  Unpaused,
  Ref.Ref<ReadonlyArray<ReadonlyArray<OrchestrationV2LoadPausedContainer>>>
>()("t3/orchestration-v2/LoadPauseWorker.test/Unpaused") {}

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerCleanup = Layer.effect(
  ResourceCleanupService.ResourceCleanupService,
  Effect.gen(function* () {
    const base = yield* ResourceCleanupService.ResourceCleanupService;
    const unpaused = yield* Unpaused;
    return {
      ...base,
      unpauseLoadPausedContainers: (containers) =>
        Ref.update(unpaused, (calls) => [...calls, containers]),
    };
  }),
);
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "load-pause-worker" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ).pipe(Layer.provide(layerCleanup)),
    ),
  ),
  Layer.provideMerge(
    ServerSettings.layerTest({ machineResources: { loadManagement: { enabled: true } } }),
  ),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(
    Layer.effect(
      Unpaused,
      Ref.make<ReadonlyArray<ReadonlyArray<OrchestrationV2LoadPausedContainer>>>([]),
    ),
  ),
);

// 10 cores at 50%: 500 core-percent in use.
const totals: MachineTotalsSummary = {
  cpuUtilization: 0.5,
  cpuCount: 10,
  load: { one: 40, five: 30, fifteen: 20 },
  memoryTotalBytes: 16 * 2 ** 30,
  memoryAvailableBytes: 8 * 2 ** 30,
  swapTotalBytes: 0,
  swapUsedBytes: 0,
  memoryPressure: null,
};
const usage = (share: number): ThreadResourceTotals => ({
  cpuPercent: share * 500,
  memoryBytes: 2 ** 20,
  gpuUtilPercent: null,
  vramBytes: null,
  processCount: 2,
  sampleAgeMs: 1_000,
  source: "cgroup",
});
/** Load 4 per core over a threshold of 3: one thread with half the load is enough to pause. */
const stressed = (value = 4): MachineStatusSnapshot => ({
  sequence: 1,
  verdict: "stressed",
  verdictAgeMs: 0,
  reason: { rule: "load", value, threshold: 3, heldForMs: 60_000 },
  sampleAgeMs: 0,
  totals,
});
const calm: MachineStatusSnapshot = {
  sequence: 2,
  verdict: "ok",
  verdictAgeMs: 0,
  reason: null,
  sampleAgeMs: 0,
  totals,
};

const FULL_A = "a".repeat(64);
const FULL_B = "b".repeat(64);
const containerClaim = (threadId: ThreadId, containerId: string): ResolvedClaim => ({
  claim: {
    id: ClaimId.make(`claim:${threadId}:${containerId}`),
    threadId,
    target: { type: "container", id: containerId.slice(0, 12) },
    createdAt: DateTime.makeUnsafe(0),
    createdBy: { type: "user" },
  },
  containerId,
});

/** Everything outside the orchestrator the worker reads, owned by one test. */
interface World {
  status: MachineStatusSnapshot | null;
  usage: Map<ThreadId, ThreadResourceTotals>;
  claims: Array<ResolvedClaim>;
  focus: Array<ThreadId>;
  failSet: Set<ThreadId>;
  dockerFails: boolean;
  /** Runs right after a load pause set commits, before the worker re-checks claims. */
  afterSet: (threadId: ThreadId) => Effect.Effect<void>;
  /** The worker's committed commands and docker calls, in order. */
  log: Array<string>;
}

const makeWorld = (): World => ({
  status: null,
  usage: new Map(),
  claims: [],
  focus: [],
  failSet: new Set(),
  dockerFails: false,
  afterSet: () => Effect.void,
  log: [],
});

const output = (stdout: string, code = 0, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr,
  code: code as ChildProcessSpawner.ExitCode,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** `make` with the real orchestrator wrapped, the rest stubbed from the world. */
const startWorker = (world: World) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const ownership = yield* ProcessOwnership;
    const threadResources = yield* ThreadResources;
    const containerState = new Map<string, string>();
    const runner: ProcessRunner.ProcessRunner["Service"] = {
      run: (input) =>
        Effect.sync(() => {
          const [action, ...rest] = input.args;
          const id = rest.at(-1)!;
          if (action === "inspect") {
            world.log.push(`docker inspect ${id}`);
            return output(`${id} ${containerState.get(id) ?? "running"} 4242`);
          }
          world.log.push(`docker ${action} ${id}`);
          if (world.dockerFails) return output("", 1, "permission denied");
          containerState.set(id, action === "pause" ? "paused" : "running");
          return output("");
        }),
    };
    return yield* LoadPauseWorker.make.pipe(
      Effect.provideService(Orchestrator.OrchestratorV2, {
        ...orchestrator,
        dispatch: (command) =>
          command.type === "thread.load-pause.set" && world.failSet.has(command.threadId)
            ? Effect.die("injected set failure")
            : orchestrator.dispatch(command).pipe(
                Effect.tap(() =>
                  Effect.sync(() =>
                    world.log.push(
                      command.type === "thread.load-pause.set" ||
                        command.type === "thread.load-pause.clear"
                        ? `${command.type} ${command.threadId}`
                        : command.type,
                    ),
                  ),
                ),
                Effect.tap(() =>
                  command.type === "thread.load-pause.set"
                    ? world.afterSet(command.threadId)
                    : Effect.void,
                ),
              ),
      }),
      Effect.provideService(HostResources.HostResources, {
        status: Stream.suspend(() =>
          world.status === null ? Stream.empty : Stream.make(world.status),
        ),
      } as never),
      Effect.provideService(ThreadResources, {
        ...threadResources,
        byThread: Effect.sync(() => world.usage),
      }),
      Effect.provideService(ProcessOwnership, {
        ...ownership,
        resolvedClaims: Effect.sync(() => [...world.claims]),
      }),
      Effect.provideService(BackgroundPolicy.BackgroundPolicy, {
        snapshot: Effect.sync(() => ({
          leases: [
            { scopes: world.focus.map((threadId) => ({ type: "thread" as const, threadId })) },
          ],
        })),
      } as never),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      // Skips reading this test process's own cgroup.
      Effect.provideService(HostProcess.Platform, "darwin"),
    );
  });

const setLane = (enabled: boolean) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* settings.updateSettings({ machineResources: { loadManagement: { enabled } } });
  });

const applyThread = (
  threadId: ThreadId,
  type: "thread.tags-updated" | "thread.metadata-updated",
  patch: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { thread } = yield* orchestrator.getThreadProjection(threadId);
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:${type}:${JSON.stringify(patch)}`),
      type,
      threadId,
      occurredAt: yield* DateTime.now,
      payload: { ...thread, ...patch },
    } as never);
  });

/** A thread with a live provider turn, tagged as given (low priority by default). */
const liveThread = (name: string, tags: ReadonlyArray<string> = ["priority:low"]) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:load-pause-worker"),
      title: name,
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}`),
      text: "work",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const run = projection.runs.at(-1)!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:session`),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: {
        ...projection.providerThreads.find((thread) => thread.id === run.providerThreadId)!,
        providerSessionId: ProviderSessionId.make(`session:${threadId}`),
      },
    });
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:turn`),
      type: "provider-turn.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: ProviderTurnId.make(`turn:${threadId}`),
        providerThreadId: run.providerThreadId!,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId!,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running",
        startedAt: now,
        completedAt: null,
      },
    });
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:running`),
      type: "run.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, status: "running", startedAt: now },
    });
    yield* applyThread(threadId, "thread.tags-updated", { tags });
    return threadId;
  });

/** Moves past the focus window a thread's creation opens. */
const pastFocusWindow = TestClock.adjust(LOAD_PAUSE_FOCUS_WINDOW_MS);

const loadPauseOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return (yield* projections.getThreadShell(threadId))?.loadPause ?? null;
  });

/** Runs only the load pause cleanups: provider effects have no provider in this harness. */
const drainCleanups = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  for (;;) {
    yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE effect_type != 'load-pause.cleanup'`;
    if ((yield* worker.drain(1)) === 0) return;
  }
});

/** Sweeps once stressed, then again once `pauseHoldSeconds` (60 s by default) has passed. */
const sweepThroughHold = <E, R>(sweep: Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    yield* sweep;
    yield* TestClock.adjust("60 seconds");
    yield* sweep;
  });

describe("LoadPauseWorker", () => {
  it.effect.each([[false], [true]] as const)(
    "the first sweep clears every persisted pause, archived threads too (lane on: %s), and the drain unpauses",
    ([enabled]) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* setLane(enabled);
        const live = yield* liveThread("left-paused");
        const archived = yield* liveThread("archived-paused");
        for (const [threadId, id] of [
          [live, FULL_A],
          [archived, FULL_B],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "thread.load-pause.set",
            commandId: CommandId.make(`crash:${threadId}`),
            threadId,
            runId: (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!.id,
            episodeId: "before-restart",
            reason: { rule: "load", value: 4, threshold: 3, shareOfLoad: 0.5 },
            containersPaused: [{ id }],
          });
        }
        // Archive normally clears the pause; this is a row a crash left behind.
        yield* applyThread(archived, "thread.metadata-updated", {
          archivedAt: yield* DateTime.now,
          loadPause: yield* loadPauseOf(archived),
        });
        assert.isNotNull(yield* loadPauseOf(archived));

        const world = makeWorld();
        const { sweep } = yield* startWorker(world);
        yield* sweep;
        assert.isNull(yield* loadPauseOf(live));
        assert.isNull(yield* loadPauseOf(archived));
        assert.sameMembers(world.log, [
          `thread.load-pause.clear ${live}`,
          `thread.load-pause.clear ${archived}`,
        ]);

        yield* drainCleanups;
        assert.sameDeepMembers(
          [...(yield* Ref.get(yield* Unpaused))],
          [[{ id: FULL_A }], [{ id: FULL_B }]],
        );

        // Reconcile is once per start: a later pause is not cleared on the next sweep.
        world.log.length = 0;
        yield* sweep;
        assert.deepEqual(world.log, []);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "turning the lane off clears every pause on the next sweep, and the drain unpauses",
    () =>
      Effect.gen(function* () {
        const threadId = yield* liveThread("lane-off");
        yield* pastFocusWindow;
        const world = makeWorld();
        world.status = stressed();
        world.usage.set(threadId, usage(0.5));
        world.claims = [containerClaim(threadId, FULL_A)];
        const { sweep } = yield* startWorker(world);
        yield* sweepThroughHold(sweep);
        assert.equal((yield* loadPauseOf(threadId))?.containersPaused[0]?.id, FULL_A);

        world.log.length = 0;
        yield* setLane(false);
        yield* sweep;
        assert.isNull(yield* loadPauseOf(threadId));
        assert.deepEqual(world.log, [`thread.load-pause.clear ${threadId}`]);
        yield* drainCleanups;
        assert.deepEqual(yield* Ref.get(yield* Unpaused), [[{ id: FULL_A }]]);

        // Off stays off, however long the stress lasts.
        world.log.length = 0;
        yield* TestClock.adjust(LOAD_PAUSE_REPAUSE_COOLDOWN_MS);
        yield* sweepThroughHold(sweep);
        assert.deepEqual(world.log, []);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("the lane off never pauses", () =>
    Effect.gen(function* () {
      yield* setLane(false);
      const threadId = yield* liveThread("never");
      yield* pastFocusWindow;
      const world = makeWorld();
      world.status = stressed();
      world.usage.set(threadId, usage(0.9));
      world.claims = [containerClaim(threadId, FULL_A)];
      const { sweep } = yield* startWorker(world);
      yield* sweepThroughHold(sweep);
      yield* TestClock.adjust("10 minutes");
      yield* sweep;
      assert.isNull(yield* loadPauseOf(threadId));
      assert.deepEqual(world.log, []);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "pauses only after pauseHoldSeconds of stress, and a calm sweep restarts the hold",
    () =>
      Effect.gen(function* () {
        const threadId = yield* liveThread("hold");
        yield* pastFocusWindow;
        const world = makeWorld();
        world.status = stressed();
        world.usage.set(threadId, usage(0.5));
        const { sweep } = yield* startWorker(world);

        yield* sweep;
        yield* TestClock.adjust("59 seconds");
        yield* sweep;
        assert.isNull(yield* loadPauseOf(threadId));

        // A calm sweep, then stress again: 60 s more is needed from here.
        world.status = calm;
        yield* sweep;
        world.status = stressed();
        yield* TestClock.adjust("1 second");
        yield* sweep;
        yield* TestClock.adjust("59 seconds");
        yield* sweep;
        assert.isNull(yield* loadPauseOf(threadId));
        // A stressed verdict without a reason is no stress either.
        world.status = { ...stressed(), reason: null };
        yield* sweep;
        world.status = stressed();
        yield* TestClock.adjust("1 second");
        yield* sweep;
        assert.isNull(yield* loadPauseOf(threadId));

        yield* TestClock.adjust("60 seconds");
        yield* sweep;
        assert.deepEqual(world.log, [`thread.load-pause.set ${threadId}`]);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("the next batch waits a fresh hold after a pause", () =>
    Effect.gen(function* () {
      const large = yield* liveThread("large");
      const medium = yield* liveThread("medium");
      yield* pastFocusWindow;
      const world = makeWorld();
      // 4 × (1 − 0.5) < 3: pausing the larger thread is enough for this batch.
      world.status = stressed();
      world.usage.set(large, usage(0.5)).set(medium, usage(0.4));
      const { sweep } = yield* startWorker(world);
      yield* sweepThroughHold(sweep);
      assert.deepEqual(world.log, [`thread.load-pause.set ${large}`]);

      yield* TestClock.adjust("59 seconds");
      yield* sweep;
      assert.isNull(yield* loadPauseOf(medium));
      yield* TestClock.adjust("1 second");
      yield* sweep;
      assert.deepEqual(world.log, [
        `thread.load-pause.set ${large}`,
        `thread.load-pause.set ${medium}`,
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "records the pause with its containers before docker, and leaves a container a running thread shares",
    () =>
      Effect.gen(function* () {
        const victim = yield* liveThread("victim");
        const bystander = yield* liveThread("bystander", ["priority:normal"]);
        yield* pastFocusWindow;
        const world = makeWorld();
        world.status = stressed();
        world.usage.set(victim, usage(0.5)).set(bystander, usage(0.4));
        world.claims = [
          containerClaim(victim, FULL_A),
          containerClaim(victim, FULL_B),
          containerClaim(bystander, FULL_B),
        ];
        const { sweep } = yield* startWorker(world);
        yield* sweepThroughHold(sweep);

        assert.deepEqual(world.log, [
          `thread.load-pause.set ${victim}`,
          `docker inspect ${FULL_A}`,
          `docker pause ${FULL_A}`,
        ]);
        assert.deepEqual((yield* loadPauseOf(victim))?.containersPaused, [{ id: FULL_A }]);
        assert.isNull(yield* loadPauseOf(bystander));
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([
    ["the set fails", "fail"],
    ["another thread claims the container after the set", "claim"],
    ["the user resumes before docker runs", "resume"],
  ] as const)("no docker pause when %s", ([_name, race]) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const victim = yield* liveThread("race");
      const other = ThreadId.make("thread:late-claimant");
      yield* pastFocusWindow;
      const world = makeWorld();
      world.status = stressed();
      world.usage.set(victim, usage(0.5));
      world.claims = [containerClaim(victim, FULL_A)];
      if (race === "fail") world.failSet.add(victim);
      if (race === "claim") {
        world.afterSet = () => Effect.sync(() => world.claims.push(containerClaim(other, FULL_A)));
      }
      if (race === "resume") {
        world.afterSet = (threadId) =>
          orchestrator
            .dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`user-resume:${threadId}`),
              threadId,
              loadPause: { resume: true },
            })
            .pipe(Effect.orDie, Effect.asVoid);
      }
      const { sweep } = yield* startWorker(world);
      yield* sweepThroughHold(sweep);
      assert.isFalse(world.log.some((line) => line.startsWith("docker")));
      if (race === "claim") assert.isNotNull(yield* loadPauseOf(victim));
      else assert.isNull(yield* loadPauseOf(victim));
      if (race === "fail") {
        // A set that never landed is no pause: the next batch retries it, with no cooldown.
        world.failSet.clear();
        yield* TestClock.adjust("60 seconds");
        yield* sweep;
        assert.isNotNull(yield* loadPauseOf(victim));
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a failed docker pause leaves the thread paused and the sweep going", () =>
    Effect.gen(function* () {
      const threadId = yield* liveThread("docker-refused");
      yield* pastFocusWindow;
      const world = makeWorld();
      world.status = stressed();
      world.dockerFails = true;
      world.usage.set(threadId, usage(0.5));
      world.claims = [containerClaim(threadId, FULL_A)];
      const { sweep } = yield* startWorker(world);
      yield* sweepThroughHold(sweep);
      assert.include(world.log, `docker pause ${FULL_A}`);
      assert.equal((yield* loadPauseOf(threadId))?.containersPaused[0]?.id, FULL_A);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([
    ["still stressed past the cap", "cap"],
    ["the verdict back to ok", "ok"],
  ] as const)("with %s, resumes one thread per gap, oldest pause first", ([_name, why]) =>
    Effect.gen(function* () {
      const first = yield* liveThread("first");
      const second = yield* liveThread("second");
      yield* pastFocusWindow;
      const world = makeWorld();
      world.status = stressed();
      world.usage.set(first, usage(0.5)).set(second, usage(0.4));
      const { sweep } = yield* startWorker(world);
      yield* sweepThroughHold(sweep);
      yield* TestClock.adjust("60 seconds");
      yield* sweep;
      assert.isNotNull(yield* loadPauseOf(second));

      if (why === "cap") {
        // The first pause is a minute older: just short of its cap, nothing resumes.
        yield* TestClock.adjust(LOAD_PAUSE_MAX_MS - 60_001);
        yield* sweep;
        assert.isNotNull(yield* loadPauseOf(first));
        yield* TestClock.adjust(60_001 + 60_000);
      } else {
        world.status = calm;
      }
      world.log.length = 0;
      yield* sweep;
      assert.deepEqual(world.log, [`thread.load-pause.clear ${first}`]);
      yield* TestClock.adjust(LOAD_RESUME_GAP_MS - 1);
      yield* sweep;
      assert.isNotNull(yield* loadPauseOf(second));
      yield* TestClock.adjust(1);
      yield* sweep;
      assert.deepEqual(world.log, [
        `thread.load-pause.clear ${first}`,
        `thread.load-pause.clear ${second}`,
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a user resume starts the re-pause cooldown", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* liveThread("cooldown");
      yield* pastFocusWindow;
      const world = makeWorld();
      world.status = stressed();
      world.usage.set(threadId, usage(0.5));
      const { sweep } = yield* startWorker(world);
      yield* sweepThroughHold(sweep);
      assert.isNotNull(yield* loadPauseOf(threadId));

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("user-resume"),
        threadId,
        loadPause: { resume: true },
      });
      world.log.length = 0;
      yield* sweep;
      yield* TestClock.adjust(LOAD_PAUSE_REPAUSE_COOLDOWN_MS - 1);
      yield* sweep;
      assert.deepEqual(world.log, []);
      yield* TestClock.adjust(1);
      yield* sweep;
      assert.deepEqual(world.log, [`thread.load-pause.set ${threadId}`]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([
    ["a client focuses it", "focus", false],
    ["its parent is on another environment", "remote-parent", false],
    ["its local parent is not waiting on it", "idle-parent", true],
    ["it is normal priority", "normal", false],
  ] as const)("when %s, paused: %s", ([_name, setup, pausedExpected]) =>
    Effect.gen(function* () {
      const threadId = yield* liveThread(`exempt:${setup}`, [
        setup === "normal" ? "priority:normal" : "priority:low",
      ]);
      const world = makeWorld();
      if (setup === "focus") world.focus.push(threadId);
      if (setup === "remote-parent" || setup === "idle-parent") {
        const parent =
          setup === "idle-parent"
            ? yield* liveThread("parent", [])
            : ThreadId.make("thread:elsewhere");
        yield* applyThread(threadId, "thread.metadata-updated", {
          delegatedFrom: {
            environmentId: EnvironmentId.make("environment:parent"),
            threadId: parent,
            title: "parent",
          },
        });
      }
      yield* pastFocusWindow;
      world.status = stressed();
      world.usage.set(threadId, usage(0.5));
      const { sweep } = yield* startWorker(world);
      yield* sweepThroughHold(sweep);
      assert.equal((yield* loadPauseOf(threadId)) !== null, pausedExpected);
    }).pipe(Effect.provide(layerTest)),
  );
});
