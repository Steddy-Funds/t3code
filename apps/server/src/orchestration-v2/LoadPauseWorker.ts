// @effect-diagnostics nodeBuiltinImport:off -- the server's own cgroup is one tiny file, read once.
import * as NodeFS from "node:fs";

import {
  effectiveThreadPriority,
  type OrchestrationV2LoadPausedContainer,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { parseUnifiedCgroupPath } from "@t3tools/shared/cgroup";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ProcessOwnership } from "../resourceTelemetry/ProcessOwnership.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import { ThreadResources } from "../resourceTelemetry/ThreadResources.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as LoadPauseDocker from "./LoadPauseDocker.ts";
import {
  LOAD_RESUME_GAP_MS,
  loadPauseContainers,
  loadPauseSetCommand,
  loadResumeCommands,
  selectLoadPauseVictims,
  type LoadPauseCandidate,
  type LoadPausedThread,
} from "./LoadPausePolicy.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const UNSETTLED_TASK_STATUSES = new Set(["pending", "running", "waiting"]);

const readServerCgroup = (platform: NodeJS.Platform): string | undefined => {
  if (platform !== "linux") return undefined;
  try {
    return parseUnifiedCgroupPath(NodeFS.readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * Pauses low-priority threads while the machine stays stressed, by interrupting them and later
 * sending "Continue where you left off.", plus `docker pause` of containers only they claim.
 * Off unless `machineResources.loadManagement.enabled`. Start, and turning it off, clear every
 * pause, so a crash never leaves anything paused.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettingsService;
  const host = yield* HostResources.HostResources;
  const threadResources = yield* ThreadResources;
  const ownership = yield* ProcessOwnership;
  const background = yield* BackgroundPolicy.BackgroundPolicy;
  const docker = yield* LoadPauseDocker.LoadPauseDocker;
  const serverCgroup = readServerCgroup(yield* HostProcess.Platform);

  // The Scheduler runs one sweep at a time, so this state needs no lock.
  let reconciled = false;
  let wasEnabled = false;
  let stressedSinceMs: number | null = null;
  let nextResumeAtMs = 0;
  /** Pauses this worker set, by thread, with their episode. */
  const paused = new Map<ThreadId, string>();
  const resumedAtMs = new Map<ThreadId, number>();

  const dispatch = (command: OrchestrationV2ServerCommand) =>
    orchestrator.dispatch(command).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("Load pause command failed", { type: command.type, cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  const clearEveryPause = Effect.gen(function* () {
    const snapshot = yield* projections.getShellSnapshot();
    const pausedThreads = [...snapshot.threads, ...snapshot.archivedThreads].flatMap(
      (thread): Array<LoadPausedThread> =>
        thread.loadPause == null ? [] : [{ threadId: thread.id, loadPause: thread.loadPause }],
    );
    const nowMs = yield* Clock.currentTimeMillis;
    for (const command of loadResumeCommands({
      mode: "all",
      paused: pausedThreads,
      verdict: null,
      nowMs,
      nextResumeAtMs: 0,
    })) {
      yield* dispatch(command);
    }
    paused.clear();
    stressedSinceMs = null;
  });

  /** Drops pauses that ended elsewhere (a user resume, archive, delete) and returns the rest. */
  const refreshPaused = Effect.fnUntraced(function* (nowMs: number) {
    const current: Array<LoadPausedThread> = [];
    for (const [threadId, episodeId] of paused) {
      const shell = yield* projections.getThreadShell(threadId);
      if (shell?.loadPause?.episodeId === episodeId) {
        current.push({ threadId, loadPause: shell.loadPause });
        continue;
      }
      paused.delete(threadId);
      resumedAtMs.set(threadId, nowMs);
    }
    return current;
  });

  const parentWaiting = Effect.fnUntraced(function* (shell: OrchestrationV2ThreadShell) {
    if (shell.delegatedFrom === undefined) return false;
    const parent = yield* projections.getThreadShell(shell.delegatedFrom.threadId);
    // A parent on another environment cannot be checked here, so the child is left running.
    if (parent === null) return true;
    return parent.blockedOnThreadWait === true || parent.activityRunStatus === "waiting";
  });

  const readCandidates = Effect.fnUntraced(function* () {
    const usage = yield* threadResources.byThread;
    const leases = (yield* background.snapshot).leases;
    const focused = new Set(
      leases.flatMap((lease) =>
        lease.scopes.flatMap((scope) => (scope.type === "thread" ? [scope.threadId] : [])),
      ),
    );
    const candidates: Array<LoadPauseCandidate> = [];
    for (const [threadId, totals] of usage) {
      const shell = yield* projections.getThreadShell(threadId);
      // Only low-priority threads can be paused; the rest skip the reads below.
      if (shell === null || effectiveThreadPriority(shell) !== "low") continue;
      const records = yield* projections.getThreadRecords(threadId, ["subagents"]);
      candidates.push({
        thread: shell,
        usage: totals,
        hasUnsettledDelegateChild: records.subagents.some(
          (task) => task.origin === "app_owned" && UNSETTLED_TASK_STATUSES.has(task.status),
        ),
        parentWaiting: yield* parentWaiting(shell),
        focusLease: focused.has(threadId),
        lastResumedAtMs: resumedAtMs.get(threadId),
      });
    }
    return candidates;
  });

  /** Re-read under the container's lock around `docker pause`; any change skips or undoes it. */
  const stillOnlyVictims = Effect.fnUntraced(function* (
    container: OrchestrationV2LoadPausedContainer,
    episodeId: string,
  ) {
    const claimants = (yield* ownership.resolvedClaims).filter(
      (resolved) =>
        resolved.claim.target.type === "container" &&
        resolved.containerId === container.id &&
        resolved.claim.target.dockerHost === container.dockerHost,
    );
    if (claimants.length === 0) return false;
    for (const threadId of new Set(claimants.map((resolved) => resolved.claim.threadId))) {
      const shell = yield* projections.getThreadShell(threadId);
      if (shell?.loadPause?.episodeId !== episodeId) return false;
    }
    return true;
  });

  const pauseVictims = Effect.fnUntraced(function* (nowMs: number) {
    const status = Option.getOrNull(yield* Stream.runHead(host.status));
    if (status?.verdict !== "stressed" || status.reason === null || status.totals === null) {
      stressedSinceMs = null;
      return;
    }
    const { pauseHoldSeconds } = (yield* settings.getSettings).machineResources.loadManagement;
    stressedSinceMs ??= nowMs;
    if (nowMs - stressedSinceMs < pauseHoldSeconds * 1000) return;
    const victims = selectLoadPauseVictims({
      reason: status.reason,
      totals: status.totals,
      candidates: yield* readCandidates(),
      nowMs,
    });
    if (victims.length === 0) return;
    // The next batch waits a fresh hold, so the verdict can show what these pauses freed.
    stressedSinceMs = nowMs;
    const episodeId = String(nowMs);
    const containers = loadPauseContainers({
      victims: new Set(victims.map((victim) => victim.threadId)),
      claims: yield* ownership.resolvedClaims,
      serverCgroup,
    });
    // The pause is recorded with its containers before any is paused, so none can leak.
    const toPause = new Map<string, OrchestrationV2LoadPausedContainer>();
    for (const victim of victims) {
      const containersPaused = containers.get(victim.threadId) ?? [];
      const set = yield* dispatch(
        loadPauseSetCommand({ victim, episodeId, reason: status.reason, containersPaused }),
      );
      if (!set) continue;
      paused.set(victim.threadId, episodeId);
      for (const container of containersPaused) {
        toPause.set(LoadPauseDocker.containerKey(container), container);
      }
    }
    for (const container of toPause.values()) {
      const stillWanted = stillOnlyVictims(container, episodeId).pipe(
        Effect.orElseSucceed(() => false),
      );
      yield* docker
        .pause(container, stillWanted)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not pause a load-paused thread's container", { error }),
          ),
        );
    }
  });

  const resumeOne = Effect.fnUntraced(function* (nowMs: number) {
    const pausedThreads = yield* refreshPaused(nowMs);
    if (pausedThreads.length === 0) return;
    const status = Option.getOrNull(yield* Stream.runHead(host.status));
    for (const command of loadResumeCommands({
      mode: "release",
      paused: pausedThreads,
      verdict: status?.verdict ?? null,
      nowMs,
      nextResumeAtMs,
    })) {
      // A failed clear keeps the thread tracked for the next gap; the gap still advances.
      nextResumeAtMs = nowMs + LOAD_RESUME_GAP_MS;
      if (!(yield* dispatch(command))) continue;
      paused.delete(command.threadId);
      resumedAtMs.set(command.threadId, nowMs);
    }
  });

  // Every 5 s for the server's lifetime; a span per tick would only add noise.
  const sweep = Effect.fnUntraced(function* () {
    const { enabled } = (yield* settings.getSettings).machineResources.loadManagement;
    if (!reconciled || (wasEnabled && !enabled)) {
      yield* clearEveryPause;
      reconciled = true;
    }
    wasEnabled = enabled;
    if (!enabled) return;
    const nowMs = yield* Clock.currentTimeMillis;
    yield* resumeOne(nowMs);
    yield* pauseVictims(nowMs);
  });

  return { sweep: sweep() };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { sweep } = yield* make;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("load-pause", sweep);
  }),
);
