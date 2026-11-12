import { CodeIntelError, type CodeServerState } from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSettings from "../serverSettings.ts";
import type { LanguageContext, LanguageRow } from "./LanguageRegistry.ts";
import * as LanguageServerBinaries from "./LanguageServerBinaries.ts";
import * as LanguageServerProcess from "./LanguageServerProcess.ts";
import * as PythonEnvironment from "./PythonEnvironment.ts";
import * as ServerSession from "./ServerSession.ts";
import * as WorkspaceWatcher from "./WorkspaceWatcher.ts";

/** Counts servers that are starting or stopping too. */
const MAX_LIVE_SERVERS = 4;
/** Requests one server works on at a time; the rest wait inside their own deadline. */
const MAX_CONCURRENT_REQUESTS = 8;
const IDLE_TIMEOUT_MS = 15 * 60_000;
const CRASH_WINDOW_MS = 10 * 60_000;
const CRASH_LIMIT = 3;
const TIMEOUT_LIMIT = 3;
const START_BACKOFF_BASE_MS = 5_000;
const START_BACKOFF_MAX_MS = 60_000;

export type StopReason =
  | "idle"
  | "evicted"
  | "restart"
  | "dependencies"
  | "off"
  | "shutdown"
  | "timeouts";

export interface LiveServer {
  readonly key: string;
  readonly row: LanguageRow;
  readonly root: string;
  readonly context: LanguageContext;
  readonly server: LanguageServerProcess.RunningLanguageServer;
  readonly session: ServerSession.ServerSession;
  readonly gate: Semaphore.Semaphore;
  /** Why the pool stopped it; unset while it runs and after a crash. */
  stopReason: StopReason | undefined;
}

export interface ServerSnapshot {
  readonly row: LanguageRow;
  readonly name: string;
  readonly version: string | undefined;
  readonly state: CodeServerState;
  readonly message: string | undefined;
  /** The running server, for what only it knows (its environment, its watcher). */
  readonly live: LiveServer | undefined;
}

type Phase =
  | { readonly _tag: "stopped" }
  | {
      readonly _tag: "starting";
      readonly scope: Scope.Closeable;
      readonly ready: Deferred.Deferred<LiveServer, CodeIntelError>;
    }
  | { readonly _tag: "ready"; readonly scope: Scope.Closeable; readonly live: LiveServer }
  | { readonly _tag: "stopping"; readonly stopped: Deferred.Deferred<void> }
  | { readonly _tag: "failed"; readonly message: string };

interface Slot {
  readonly key: string;
  readonly row: LanguageRow;
  readonly root: string;
  phase: Phase;
  /** Starts the server, then waits for its exit; interrupted by every stop. */
  fiber: Fiber.Fiber<void> | undefined;
  /** Bumped by every start and stop, so a late callback cannot touch a newer run. */
  generation: number;
  lastUsedAt: number;
  crashTimes: Array<number>;
  /** Three crashes in ten minutes: stays `failed` until a restart or the off switch. */
  latched: boolean;
  startFailuresInARow: number;
  timeoutsInARow: number;
  /** The stop of a server evicted for this slot: requests that come meanwhile wait on it, not evict another. */
  evicting: Deferred.Deferred<void> | undefined;
}

type Decision =
  | { readonly _tag: "use"; readonly live: LiveServer }
  | { readonly _tag: "join"; readonly ready: Deferred.Deferred<LiveServer, CodeIntelError> }
  | { readonly _tag: "wait"; readonly stopped: Deferred.Deferred<void> }
  | { readonly _tag: "fail"; readonly error: CodeIntelError }
  | { readonly _tag: "start" };

const slotKey = (languageId: string, root: string) => `${languageId}\n${root}`;

const isAlive = (slot: Slot) =>
  slot.phase._tag === "starting" || slot.phase._tag === "ready" || slot.phase._tag === "stopping";

const unavailable = (message: string) =>
  new CodeIntelError({ reason: "server_unavailable", message });

const failed = (message: string) => new CodeIntelError({ reason: "server_failed", message });

const withStderr = (message: string, excerpt: string | undefined) =>
  excerpt === undefined ? message : `${message} ${excerpt}`;

const describeExit = (exit: LanguageServerProcess.LanguageServerExit, memoryKilled: boolean) => {
  if (memoryKilled) return "The language server was stopped: it ran out of memory.";
  if (exit.connection !== undefined) {
    return `The language server's connection broke (${exit.connection}), so it was stopped.`;
  }
  return exit.signal === undefined
    ? `The language server exited (code ${exit.code ?? "unknown"}).`
    : `The language server exited (signal ${exit.signal}).`;
};

export class LanguageServerPool extends Context.Service<
  LanguageServerPool,
  {
    /** The running server for this language and root, started when there is none. */
    readonly acquire: (row: LanguageRow, root: string) => Effect.Effect<LiveServer, CodeIntelError>;
    /** Three timeouts in a row mean a hung server: it is killed and marked failed. */
    readonly reportOutcome: (
      live: LiveServer,
      outcome: "answered" | "timeout",
    ) => Effect.Effect<void>;
    /** `server_unavailable` while code intelligence is turned off in settings. */
    readonly assertEnabled: Effect.Effect<void, CodeIntelError>;
    /** Never starts anything. */
    readonly snapshot: (row: LanguageRow, root: string) => Effect.Effect<ServerSnapshot>;
    /** Stops this root's servers and forgets their failures; the next request starts them. */
    readonly restart: (root: string, languageId: string | undefined) => Effect.Effect<void>;
  }
>()("t3/codeIntel/LanguageServerPool") {}

const make = Effect.gen(function* () {
  const poolScope = yield* Effect.scope;
  const settings = yield* ServerSettings.ServerSettingsService;
  const binaries = yield* LanguageServerBinaries.LanguageServerBinaries;
  const pythonEnvironment = yield* PythonEnvironment.PythonEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const watcher = yield* WorkspaceWatcher.WorkspaceWatcher;
  const path = yield* Path.Path;
  const agentScope = yield* AgentScope;
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;
  const slots = new Map<string, Slot>();

  const isEnabled = settings.getSettings.pipe(
    Effect.map((current) => current.codeIntel.enabled),
    Effect.orElseSucceed(() => true),
  );
  const TURNED_OFF = "Code intelligence is turned off in settings.";
  const assertEnabled = Effect.flatMap(isEnabled, (enabled) =>
    enabled ? Effect.void : Effect.fail(unavailable(TURNED_OFF)),
  );

  const annotations = (slot: Slot) => ({ languageId: slot.row.id, root: slot.root });

  const forgetFailures = (slot: Slot) => {
    slot.crashTimes = [];
    slot.latched = false;
    slot.startFailuresInARow = 0;
    if (slot.phase._tag === "failed") slot.phase = { _tag: "stopped" };
  };

  /**
   * `starting | ready -> stopping -> stopped` (or `failed`). Marks the slot without yielding;
   * `finish` forks the kill into the pool's scope, so an interrupted request cannot leave a slot
   * stopping forever.
   */
  const markStop = (
    slot: Slot,
    reason: StopReason,
    after: Phase = { _tag: "stopped" },
  ):
    | { readonly stopped: Deferred.Deferred<void>; readonly finish: Effect.Effect<void> }
    | undefined => {
    const phase = slot.phase;
    if (phase._tag === "stopping") return { stopped: phase.stopped, finish: Effect.void };
    if (phase._tag !== "starting" && phase._tag !== "ready") return undefined;
    const stopped = Deferred.makeUnsafe<void>();
    const fiber = slot.fiber;
    slot.fiber = undefined;
    slot.generation += 1;
    slot.phase = { _tag: "stopping", stopped };
    if (phase._tag === "ready") phase.live.stopReason = reason;
    const finish = Effect.gen(function* () {
      // Interrupts a start, the backoff before one, or the wait for a running server's exit.
      if (fiber !== undefined) yield* Fiber.interrupt(fiber);
      yield* Scope.close(phase.scope, Exit.void);
      slot.phase = after;
      if (phase._tag === "starting") {
        yield* Deferred.fail(phase.ready, unavailable("The language server was stopped."));
      }
      yield* Deferred.succeed(stopped, undefined);
      yield* Effect.logInfo("Language server stopped", { ...annotations(slot), reason });
    }).pipe(Effect.forkIn(poolScope), Effect.asVoid);
    return { stopped, finish };
  };

  const beginStop = (
    slot: Slot,
    reason: StopReason,
    after?: Phase,
  ): Effect.Effect<Deferred.Deferred<void> | undefined> =>
    Effect.suspend(() => {
      const marked = markStop(slot, reason, after);
      return marked === undefined ? Effect.undefined : Effect.as(marked.finish, marked.stopped);
    }).pipe(Effect.uninterruptible);

  const stopMatching = Effect.fnUntraced(function* (
    reason: StopReason,
    matches: (slot: Slot) => boolean,
    forget: boolean,
  ) {
    const waits: Array<Deferred.Deferred<void>> = [];
    for (const slot of slots.values()) {
      if (!matches(slot)) continue;
      const stopped = yield* beginStop(slot, reason);
      if (stopped !== undefined) waits.push(stopped);
      if (forget) forgetFailures(slot);
    }
    yield* Effect.forEach(waits, (stopped) => Deferred.await(stopped), { discard: true });
  });

  // `-> failed`. The third crash in ten minutes latches the slot.
  const recordFailure = (slot: Slot, message: string, now: number) => {
    slot.crashTimes = [...slot.crashTimes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    if (slot.crashTimes.length >= CRASH_LIMIT) slot.latched = true;
    slot.phase = { _tag: "failed", message };
  };

  const locateContext = (row: LanguageRow, root: string) =>
    row.id === "python"
      ? Effect.map(pythonEnvironment.locate(root), (python): LanguageContext => ({ root, python }))
      : Effect.succeed<LanguageContext>({ root });

  const watchIdle = Effect.fnUntraced(function* (slot: Slot, generation: number) {
    for (;;) {
      const remaining = slot.lastUsedAt + IDLE_TIMEOUT_MS - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) {
        if (slot.generation === generation) yield* beginStop(slot, "idle");
        return;
      }
      yield* Effect.sleep(remaining);
    }
  });

  const run = Effect.fn("LanguageServerPool.run")(function* (
    slot: Slot,
    generation: number,
    spec: LanguageServerBinaries.LaunchSpec,
    scope: Scope.Closeable,
    ready: Deferred.Deferred<LiveServer, CodeIntelError>,
    backoffMs: number,
  ) {
    if (backoffMs > 0) yield* Effect.sleep(backoffMs);
    const context = yield* locateContext(slot.row, slot.root);
    const scopeKey = `code-intel:${slot.key}`;
    let spawned: LanguageServerProcess.SpawnedLanguageServer | undefined;
    const started = yield* LanguageServerProcess.spawn({
      row: slot.row,
      spec,
      context,
      scopeKey,
    }).pipe(
      Effect.tap((child) =>
        Effect.sync(() => {
          spawned = child;
        }),
      ),
      Effect.flatMap((child) => child.initialize),
      Effect.flatMap((server) =>
        ServerSession.make({
          server,
          row: slot.row,
          context,
          requestRestart: Effect.suspend(() =>
            slot.generation === generation
              ? Effect.asVoid(beginStop(slot, "dependencies"))
              : Effect.void,
          ),
        }).pipe(Effect.map((session) => ({ server, session }))),
      ),
      Scope.provide(scope),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(WorkspaceWatcher.WorkspaceWatcher, watcher),
      Effect.provideService(Path.Path, path),
      Effect.provideService(AgentScope, agentScope),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Environment, hostEnvironment),
      Effect.result,
    );
    if (slot.generation !== generation) return;

    if (started._tag === "Failure") {
      const error = started.failure;
      // The child is killed before the slot says `failed`.
      yield* Scope.close(scope, Exit.void);
      const excerpt = spawned === undefined ? undefined : yield* spawned.stderrExcerpt;
      if (slot.generation !== generation) return;
      const message = withStderr(error.message, excerpt);
      recordFailure(slot, message, yield* Clock.currentTimeMillis);
      slot.startFailuresInARow += 1;
      yield* Deferred.fail(ready, failed(message));
      yield* Effect.logWarning("Language server failed to start", {
        ...annotations(slot),
        stage: error.stage,
        exitCode: error.exitCode,
        signal: error.signal,
      });
      return;
    }

    const { server, session } = started.success;
    const live: LiveServer = {
      key: slot.key,
      row: slot.row,
      root: slot.root,
      context,
      server,
      session,
      gate: yield* Semaphore.make(MAX_CONCURRENT_REQUESTS),
      stopReason: undefined,
    };
    slot.phase = { _tag: "ready", scope, live };
    slot.startFailuresInARow = 0;
    slot.timeoutsInARow = 0;
    slot.lastUsedAt = yield* Clock.currentTimeMillis;
    yield* Deferred.succeed(ready, live);
    yield* Effect.logInfo("Language server started", {
      ...annotations(slot),
      pid: server.pid,
      name: server.name,
      version: server.version,
      environment: context.python?.source,
    });
    yield* watchIdle(slot, generation).pipe(Effect.forkIn(scope));

    const exit = yield* server.exited;
    if (slot.generation !== generation) return;
    // An exit nobody asked for: `ready -> stopping -> failed`. The slot keeps its place under
    // the cap, and its scope key, until the child is reaped.
    slot.generation += 1;
    slot.fiber = undefined;
    const stopped = Deferred.makeUnsafe<void>();
    slot.phase = { _tag: "stopping", stopped };
    yield* Effect.gen(function* () {
      const memoryKilled = yield* agentScope.oomKilled(scopeKey);
      const excerpt = yield* server.stderrExcerpt;
      yield* Scope.close(scope, Exit.void);
      recordFailure(
        slot,
        withStderr(describeExit(exit, memoryKilled), excerpt),
        yield* Clock.currentTimeMillis,
      );
      yield* Effect.logWarning("Language server exited", {
        ...annotations(slot),
        pid: server.pid,
        exitCode: exit.code,
        signal: exit.signal,
        connection: exit.connection,
        memoryKilled,
      });
      yield* Deferred.succeed(stopped, undefined);
    }).pipe(Effect.uninterruptible);
  });

  // The off switch stops live servers when it flips, not only when the next request reads it.
  // Subscribed now, so a flip between a request's check and its start is never missed.
  const settingsChanges = yield* settings.subscribeChanges;
  yield* settingsChanges.pipe(
    Stream.runForEach((current) =>
      current.codeIntel.enabled ? Effect.void : stopMatching("off", () => true, true),
    ),
    Effect.forkIn(poolScope),
  );

  const decide = (slot: Slot, now: number): Decision => {
    const phase = slot.phase;
    switch (phase._tag) {
      case "ready":
        slot.lastUsedAt = now;
        return { _tag: "use", live: phase.live };
      case "starting":
        return { _tag: "join", ready: phase.ready };
      case "stopping":
        return { _tag: "wait", stopped: phase.stopped };
      case "failed":
        return slot.latched
          ? {
              _tag: "fail",
              error: failed(
                `${phase.message} It stopped ${CRASH_LIMIT} times in ten minutes: restart language servers to try again.`,
              ),
            }
          : { _tag: "start" };
      case "stopped":
        return { _tag: "start" };
    }
  };

  /** Takes a place under the cap, stopping the least recently used server when there is none. */
  const claim = Effect.fnUntraced(function* (
    slot: Slot,
    spec: LanguageServerBinaries.LaunchSpec,
    now: number,
  ): Effect.fn.Return<Decision> {
    const again = decide(slot, now);
    if (again._tag !== "start") return again;
    if (slot.evicting !== undefined && !Deferred.isDoneUnsafe(slot.evicting)) {
      return { _tag: "wait", stopped: slot.evicting };
    }
    const alive = [...slots.values()].filter(isAlive);
    if (alive.length >= MAX_LIVE_SERVERS) {
      const victim = alive
        .filter((other) => other.phase._tag !== "stopping")
        .toSorted((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      // Marked before anything yields: a request that runs in between would stop a second server.
      const marked = victim === undefined ? undefined : markStop(victim, "evicted");
      if (marked !== undefined) {
        slot.evicting = marked.stopped;
        yield* marked.finish;
        return { _tag: "wait", stopped: marked.stopped };
      }
      const stopping = alive.find((other) => other.phase._tag === "stopping")?.phase;
      return stopping?._tag === "stopping"
        ? { _tag: "wait", stopped: stopping.stopped }
        : { _tag: "start" };
    }
    // From `decide` to here nothing yields: a request that runs in between would start a second server.
    const scope = Scope.forkUnsafe(poolScope, "sequential");
    const ready = Deferred.makeUnsafe<LiveServer, CodeIntelError>();
    // After two failed starts in a row the next one waits; a stop interrupts the wait.
    const backoffMs =
      slot.startFailuresInARow < 2
        ? 0
        : Math.min(
            START_BACKOFF_BASE_MS * 2 ** (slot.startFailuresInARow - 2),
            START_BACKOFF_MAX_MS,
          );
    slot.generation += 1;
    const generation = slot.generation;
    slot.lastUsedAt = now;
    slot.evicting = undefined;
    slot.phase = { _tag: "starting", scope, ready };
    const fiber = yield* run(slot, generation, spec, scope, ready, backoffMs).pipe(
      // A defect would leave the slot starting, and every request waiting on it, until a restart.
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause) && slot.generation === generation,
        (cause) =>
          Effect.gen(function* () {
            slot.generation += 1;
            slot.fiber = undefined;
            yield* Scope.close(scope, Exit.void);
            const message = "The language server stopped on an internal error.";
            recordFailure(slot, message, yield* Clock.currentTimeMillis);
            yield* Deferred.fail(ready, failed(message));
            yield* Effect.logError("Language server run failed", { ...annotations(slot), cause });
          }).pipe(Effect.uninterruptible),
      ),
      Effect.forkIn(poolScope),
    );
    // A stop that came before the fiber was recorded had nothing to interrupt.
    if (slot.generation === generation) slot.fiber = fiber;
    else yield* Fiber.interrupt(fiber);
    return { _tag: "join", ready };
  }, Effect.uninterruptible);

  const acquire: LanguageServerPool["Service"]["acquire"] = Effect.fn("LanguageServerPool.acquire")(
    function* (row, root) {
      if (!(yield* isEnabled)) {
        yield* stopMatching("off", () => true, true).pipe(Effect.forkIn(poolScope));
        return yield* unavailable(TURNED_OFF);
      }
      const key = slotKey(row.id, root);
      let slot = slots.get(key);
      if (slot === undefined) {
        slot = {
          key,
          row,
          root,
          phase: { _tag: "stopped" },
          fiber: undefined,
          generation: 0,
          lastUsedAt: 0,
          crashTimes: [],
          latched: false,
          startFailuresInARow: 0,
          timeoutsInARow: 0,
          evicting: undefined,
        };
        slots.set(key, slot);
      }
      for (;;) {
        const now = yield* Clock.currentTimeMillis;
        let decision = decide(slot, now);
        if (decision._tag === "start") {
          // Probed on every start: a binary installed since the last answer is found here.
          const spec = yield* binaries.resolve(row.id);
          if (spec._tag === "Unavailable") return yield* unavailable(spec.message);
          // The switch may have flipped during the lookup, after the settings stream stopped all.
          yield* assertEnabled;
          decision = yield* claim(slot, spec, now);
        }
        switch (decision._tag) {
          case "use":
            return decision.live;
          case "join":
            return yield* Deferred.await(decision.ready);
          case "fail":
            return yield* decision.error;
          case "wait":
            yield* Deferred.await(decision.stopped);
            break;
          case "start":
            break;
        }
      }
    },
  );

  const reportOutcome: LanguageServerPool["Service"]["reportOutcome"] = Effect.fnUntraced(
    function* (live, outcome) {
      const slot = slots.get(live.key);
      if (slot === undefined || slot.phase._tag !== "ready" || slot.phase.live !== live) return;
      const now = yield* Clock.currentTimeMillis;
      slot.lastUsedAt = now;
      if (outcome === "answered") {
        slot.timeoutsInARow = 0;
        return;
      }
      slot.timeoutsInARow += 1;
      if (slot.timeoutsInARow < TIMEOUT_LIMIT) return;
      // `ready -> failed`, killed first: `stopping` holds the slot until the child is gone.
      const message = `The language server stopped answering (${TIMEOUT_LIMIT} requests timed out).`;
      slot.crashTimes = [...slot.crashTimes.filter((at) => now - at < CRASH_WINDOW_MS), now];
      if (slot.crashTimes.length >= CRASH_LIMIT) slot.latched = true;
      yield* beginStop(slot, "timeouts", { _tag: "failed", message });
    },
  );

  const snapshot: LanguageServerPool["Service"]["snapshot"] = Effect.fn(
    "LanguageServerPool.snapshot",
  )(function* (row, root) {
    const phase = slots.get(slotKey(row.id, root))?.phase;
    const spec = yield* binaries.resolve(row.id);
    const identity = {
      row,
      name: spec.name,
      version: spec._tag === "LaunchSpec" ? spec.version : undefined,
      live: undefined,
    };
    if (!(yield* isEnabled)) {
      return {
        ...identity,
        state: "unavailable",
        message: TURNED_OFF,
      };
    }
    if (phase?._tag === "ready") {
      const live = phase.live;
      return {
        row,
        name: live.server.name,
        version: live.server.version,
        state: (yield* live.server.isLoading) ? "indexing" : "ready",
        message: undefined,
        live,
      };
    }
    if (phase?._tag === "starting") return { ...identity, state: "starting", message: undefined };
    if (phase?._tag === "failed") return { ...identity, state: "failed", message: phase.message };
    if (spec._tag === "LaunchSpec") return { ...identity, state: "stopped", message: undefined };
    const progress = yield* binaries.installProgress(row.id);
    const installing =
      progress === undefined
        ? undefined
        : progress.totalBytes === undefined || progress.totalBytes === 0
          ? `Installing ${spec.name}…`
          : `Installing ${spec.name}… ${Math.floor((progress.receivedBytes / progress.totalBytes) * 100)}%`;
    return { ...identity, state: "unavailable", message: installing ?? spec.message };
  });

  const restart: LanguageServerPool["Service"]["restart"] = (root, languageId) =>
    stopMatching(
      "restart",
      (slot) => slot.root === root && (languageId === undefined || slot.row.id === languageId),
      true,
    );

  // Child scopes close with the pool's; this covers a start that has no child yet, without
  // waiting on fibers of a scope that is already closing.
  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      [...slots.values()],
      (slot) => {
        const phase = slot.phase;
        const fiber = slot.fiber;
        slot.fiber = undefined;
        slot.generation += 1;
        if (phase._tag !== "starting" && phase._tag !== "ready") return Effect.void;
        if (phase._tag === "ready") phase.live.stopReason = "shutdown";
        return (fiber === undefined ? Effect.void : Fiber.interrupt(fiber)).pipe(
          Effect.andThen(Scope.close(phase.scope, Exit.void)),
        );
      },
      { concurrency: "unbounded", discard: true },
    ),
  );

  return LanguageServerPool.of({ acquire, reportOutcome, assertEnabled, snapshot, restart });
});

export const layer = Layer.effect(LanguageServerPool, make);
