import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2LoadPausedContainer,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

class Unpaused extends Context.Service<
  Unpaused,
  Ref.Ref<ReadonlyArray<ReadonlyArray<OrchestrationV2LoadPausedContainer>>>
>()("t3/orchestration-v2/Orchestrator.load-pause.test/Unpaused") {}

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerUnpaused = Layer.effect(
  Unpaused,
  Ref.make<ReadonlyArray<ReadonlyArray<OrchestrationV2LoadPausedContainer>>>([]),
);
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
        { name: "load-pause" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ).pipe(Layer.provide(layerCleanup)),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(layerUnpaused),
);

const containers = [{ id: "container:busy" }];
const reason = { rule: "loadPerCore", value: 4.2, threshold: 3, shareOfLoad: 0.8 };

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:load-pause"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const userSend = (
  threadId: ThreadId,
  text: string,
  type: "start_immediately" | "queue_after_active",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

const agentSend = (
  threadId: ThreadId,
  text: string,
  type: "start_immediately" | "queue_after_active" = "queue_after_active",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`agent-send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "agent",
      creationSource: "mcp",
    });
  });

/** Marks the latest run running with a live provider turn, so an interrupt waits on the provider. */
const makeRunLive = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
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
    return run.id;
  });

const settleRun = (threadId: ThreadId, runId: RunId, status: "interrupted" | "completed") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (candidate) => candidate.id === runId,
    )!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make(`event:${threadId}:${runId}:${status}`),
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status, completedAt: now },
    });
  });

const pause = (threadId: ThreadId, runId: RunId, episodeId = "episode:1") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.load-pause.set",
      commandId: CommandId.make(`pause:${threadId}:${episodeId}`),
      threadId,
      runId,
      episodeId,
      reason,
      containersPaused: containers,
    });
  });

const resume = (threadId: ThreadId, via: "thread.load-pause.clear" | "thread.metadata.update") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const commandId = CommandId.make(`resume:${threadId}`);
    yield* via === "thread.load-pause.clear"
      ? orchestrator.dispatch({ type: via, commandId, threadId, episodeId: "episode:1" })
      : orchestrator.dispatch({ type: via, commandId, threadId, loadPause: { resume: true } });
    return commandId;
  });

/** Run labels in ordinal order, plus queue fields for queued runs. */
const runState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const textOf = (messageId: MessageId) =>
      projection.messages.find((message) => message.id === messageId)?.text ?? "?";
    return projection.runs.map((run) =>
      run.status === "queued"
        ? `${textOf(run.userMessageId)}:queued${run.queueHeld === true ? ":held" : ""}`
        : `${textOf(run.userMessageId)}:${run.status}`,
    );
  });

/** Queued messages in the order the queue starts them. */
const queueOrder = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return projection.runs
      .filter((run) => run.status === "queued")
      .toSorted(
        (left, right) =>
          (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal),
      )
      .map((run) => projection.messages.find((message) => message.id === run.userMessageId)?.text);
  });

const outbox = (commandId: CommandId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ effect_type: string; payload_json: string }>`
      SELECT effect_type, payload_json FROM orchestration_v2_effect_outbox
      WHERE command_id = ${commandId}
    `;
    return rows.map((row) => ({ type: row.effect_type, payload: JSON.parse(row.payload_json) }));
  });

/** Runs only the load pause cleanup: provider effects have no provider in this harness. */
const drainCleanup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM orchestration_v2_effect_outbox WHERE effect_type != 'load-pause.cleanup'`;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  // The continuation can start a run, whose provider effects must stay queued.
  return yield* worker.drain(1);
});

const CONTINUE_TEXT = "Continue where you left off.";

it.effect.each([
  ["thread.load-pause.clear", "drain before settle"],
  ["thread.load-pause.clear", "settle before drain"],
  ["thread.metadata.update", "drain before settle"],
  ["thread.metadata.update", "settle before drain"],
] as const)(
  "a resume (%s) while the pause interrupt is in flight still owes the continuation, ahead of the held queue (%s)",
  ([via, order]) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make(`thread:load-pause-race:${via}:${order}`);
      yield* createThread(threadId);
      yield* userSend(threadId, "active", "start_immediately");
      const runId = yield* makeRunLive(threadId);
      yield* userSend(threadId, "user follow-up", "queue_after_active");
      yield* agentSend(threadId, "agent follow-up");

      yield* pause(threadId, runId);
      // The interrupt is requested but not settled: the run is still live.
      assert.deepEqual(yield* runState(threadId), [
        "active:running",
        "user follow-up:queued:held",
        "agent follow-up:queued:held",
      ]);

      const resumeId = yield* resume(threadId, via);
      assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.loadPause ?? null);
      // Held for the continuation, which goes first.
      assert.deepEqual(yield* runState(threadId), [
        "active:running",
        "user follow-up:queued:held",
        "agent follow-up:queued:held",
      ]);
      assert.deepEqual(yield* outbox(resumeId), [
        {
          type: "load-pause.cleanup",
          payload: {
            type: "load-pause.cleanup",
            containersPaused: containers,
            continuation: { runId, episodeId: "episode:1" },
          },
        },
      ]);

      if (order === "drain before settle") {
        assert.equal(yield* drainCleanup, 1);
        // The continuation is the durable record of what is owed: queued first, unheld.
        assert.deepEqual(yield* runState(threadId), [
          "active:running",
          "user follow-up:queued",
          "agent follow-up:queued",
          `${CONTINUE_TEXT}:queued`,
        ]);
        assert.deepEqual(yield* queueOrder(threadId), [
          CONTINUE_TEXT,
          "user follow-up",
          "agent follow-up",
        ]);
        yield* settleRun(threadId, runId, "interrupted");
        yield* orchestrator.resumeQueuedRuns;
      } else {
        yield* settleRun(threadId, runId, "interrupted");
        assert.equal(yield* drainCleanup, 1);
      }

      assert.deepEqual(yield* Ref.get(yield* Unpaused), [containers]);
      const final = yield* runState(threadId);
      assert.equal(final[0], "active:interrupted");
      assert.match(final[3]!, new RegExp(`^${CONTINUE_TEXT}:(preparing|starting|running)$`));
      assert.deepEqual(final.slice(1, 3), ["user follow-up:queued", "agent follow-up:queued"]);
      assert.deepEqual(yield* queueOrder(threadId), ["user follow-up", "agent follow-up"]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a continuation is dropped when another run is active beside its source, and the queue is released",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:load-pause-two-active");
      yield* createThread(threadId);
      yield* userSend(threadId, "older", "start_immediately");
      yield* userSend(threadId, "source", "queue_after_active");
      const runId = yield* makeRunLive(threadId);
      // An older run still waiting on output: active, but not the latest executed run.
      const older = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("event:load-pause-two-active:older"),
        type: "run.updated",
        threadId,
        runId: older.id,
        occurredAt: now,
        payload: { ...older, status: "waiting", startedAt: now },
      });
      yield* userSend(threadId, "user follow-up", "queue_after_active");
      yield* pause(threadId, runId);
      const resumeId = yield* resume(threadId, "thread.load-pause.clear");
      assert.deepNestedInclude((yield* outbox(resumeId))[0], {
        "payload.continuation": { runId, episodeId: "episode:1" },
      });
      assert.deepEqual(yield* runState(threadId), [
        "older:waiting",
        "source:running",
        "user follow-up:queued:held",
      ]);

      assert.equal(yield* drainCleanup, 1);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.isFalse(projection.messages.some((message) => message.text === CONTINUE_TEXT));
      assert.deepEqual(yield* runState(threadId), [
        "older:waiting",
        "source:running",
        "user follow-up:queued",
      ]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "a load pause interrupts the live run but keeps buffered wakes, queued messages and the snooze",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:load-pause-set");
      yield* createThread(threadId);
      yield* userSend(threadId, "active", "start_immediately");
      const runId = yield* makeRunLive(threadId);
      yield* userSend(threadId, "user follow-up", "queue_after_active");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("notification:load-pause"),
        threadId,
        messageId: MessageId.make("notification:load-pause"),
        text: "Background activity updated",
        attachments: [],
        createdBy: "agent",
        creationSource: "provider",
        notification: {
          source: { kind: "background_task" },
          outcome: "updated",
          summary: "Background activity updated",
        },
        dispatchMode: { type: "queue_after_active" },
      });
      const before = yield* orchestrator.getThreadProjection(threadId);

      yield* pause(threadId, runId);
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(yield* runState(threadId), [
        "active:running",
        "user follow-up:queued:held",
        "Background activity updated:queued:held",
      ]);
      assert.deepInclude(after.thread.loadPause!, {
        runId,
        episodeId: "episode:1",
        reason,
        containersPaused: containers,
      });
      assert.equal(after.thread.snoozedUntil, before.thread.snoozedUntil);
      const request = after.turnItems.find(
        (item) => item.type === "run_interrupt_request" && item.runId === runId,
      );
      assert.equal(
        request?.type === "run_interrupt_request" ? request.message : undefined,
        "Paused: this machine is under load",
      );

      // One pause at a time: a second set keeps the first.
      yield* pause(threadId, runId, "episode:2");
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).thread.loadPause?.episodeId,
        "episode:1",
      );
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(pause(threadId, RunId.make("run:unknown"), "episode:3"))),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("while paused the queue waits for the user; a user send resumes it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:load-pause-hold");
    yield* createThread(threadId);
    yield* userSend(threadId, "active", "start_immediately");
    const runId = yield* makeRunLive(threadId);
    yield* pause(threadId, runId);
    yield* settleRun(threadId, runId, "interrupted");

    // Nothing is running, yet even an agent's start_immediately waits, held.
    yield* agentSend(threadId, "agent nudge", "start_immediately");
    assert.deepEqual(yield* runState(threadId), ["active:interrupted", "agent nudge:queued:held"]);
    const resumeQueue = yield* Effect.exit(
      orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("queue-resume:load-pause"),
        threadId,
      }),
    );
    assert.isTrue(Exit.isFailure(resumeQueue));
    assert.include(String(resumeQueue), "Resume the paused thread before resuming its queue.");
    // Even an unheld queued run waits while the thread is paused.
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const nudge = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
    yield* projections.apply({
      id: EventId.make("event:load-pause-hold:unheld"),
      type: "run.updated",
      threadId,
      runId: nudge.id,
      occurredAt: yield* DateTime.now,
      payload: { ...nudge, queueHeld: false },
    });
    yield* orchestrator.resumeQueuedRuns;
    assert.deepEqual(yield* runState(threadId), ["active:interrupted", "agent nudge:queued"]);

    yield* userSend(threadId, "back", "start_immediately");
    const resumed = yield* orchestrator.getThreadProjection(threadId);
    assert.isNull(resumed.thread.loadPause ?? null);
    const state = yield* runState(threadId);
    assert.equal(state[1], "agent nudge:queued");
    assert.match(state[2]!, /^back:(preparing|starting|running)$/);
    assert.deepInclude(
      (yield* outbox(CommandId.make(`send:${threadId}:back`))).find(
        ({ type }) => type === "load-pause.cleanup",
      ),
      { payload: { type: "load-pause.cleanup", containersPaused: containers } },
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("clearing a pause whose run already ended releases the queue now, idempotently", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:load-pause-ended");
    yield* createThread(threadId);
    yield* userSend(threadId, "active", "start_immediately");
    const runId = yield* makeRunLive(threadId);
    yield* userSend(threadId, "user follow-up", "queue_after_active");
    yield* pause(threadId, runId);
    yield* settleRun(threadId, runId, "completed");

    const mismatch = CommandId.make("clear:load-pause-ended:other-episode");
    yield* orchestrator.dispatch({
      type: "thread.load-pause.clear",
      commandId: mismatch,
      threadId,
      episodeId: "episode:other",
    });
    assert.isNotNull((yield* orchestrator.getThreadProjection(threadId)).thread.loadPause ?? null);
    assert.deepEqual(yield* outbox(mismatch), []);

    const clearId = yield* resume(threadId, "thread.load-pause.clear");
    assert.deepEqual(yield* outbox(clearId), [
      {
        type: "load-pause.cleanup",
        payload: { type: "load-pause.cleanup", containersPaused: containers },
      },
    ]);
    const state = yield* runState(threadId);
    assert.equal(state[0], "active:completed");
    assert.match(state[1]!, /^user follow-up:(preparing|starting|running)$/);

    const again = CommandId.make("clear:load-pause-ended:again");
    yield* orchestrator.dispatch({ type: "thread.load-pause.clear", commandId: again, threadId });
    assert.deepEqual(yield* outbox(again), []);
    assert.deepEqual(yield* runState(threadId), state);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a set for a run that already ended is rejected and leaves the thread unpaused", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:load-pause-set-ended");
    yield* createThread(threadId);
    yield* userSend(threadId, "active", "start_immediately");
    const runId = yield* makeRunLive(threadId);
    yield* userSend(threadId, "user follow-up", "queue_after_active");
    yield* settleRun(threadId, runId, "completed");
    const before = yield* runState(threadId);

    assert.isTrue(Exit.isFailure(yield* Effect.exit(pause(threadId, runId))));
    assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.loadPause ?? null);
    assert.deepEqual(yield* runState(threadId), before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "archiving a paused thread ends the pause and unpauses its containers, without a continuation",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:load-pause-archive");
      yield* createThread(threadId);
      yield* userSend(threadId, "active", "start_immediately");
      const runId = yield* makeRunLive(threadId);
      yield* pause(threadId, runId);
      yield* settleRun(threadId, runId, "interrupted");
      const archiveId = CommandId.make("archive:load-pause");
      yield* orchestrator.dispatch({ type: "thread.archive", commandId: archiveId, threadId });
      const archived = yield* orchestrator.getThreadProjection(threadId);
      assert.isNotNull(archived.thread.archivedAt);
      assert.isNull(archived.thread.loadPause ?? null);
      assert.deepInclude(
        (yield* outbox(archiveId)).find(({ type }) => type === "load-pause.cleanup"),
        { payload: { type: "load-pause.cleanup", containersPaused: containers } },
      );
    }).pipe(Effect.provide(layerTest)),
);
