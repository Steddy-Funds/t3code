import {
  CommandId,
  effectiveThreadPriority,
  LOAD_PAUSE_MAX_MS,
  ORCHESTRATOR_THREAD_TAG,
  type MachineTotalsSummary,
  type MachineVerdict,
  type MachineVerdictReason,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2LoadPause,
  type OrchestrationV2LoadPausedContainer,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
  type ThreadResourceTotals,
} from "@t3tools/contracts";
import { isCgroupWithin } from "@t3tools/shared/cgroup";
import * as DateTime from "effect/DateTime";

import type { ResolvedClaim } from "../resourceTelemetry/ProcessOwnership.ts";

export const LOAD_PAUSE_SHARE_THRESHOLD = 0.15;
export const LOAD_PAUSE_FOCUS_WINDOW_MS = 15 * 60_000;
/** A thread that just resumed is not paused again this soon, so it can finish some work. */
export const LOAD_PAUSE_REPAUSE_COOLDOWN_MS = 15 * 60_000;
/** Resumes go out one at a time, so the resumed work does not bring the load straight back. */
export const LOAD_RESUME_GAP_MS = 30_000;

export type LoadPauseSetCommand = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "thread.load-pause.set" }
>;
export type LoadPauseClearCommand = Extract<
  OrchestrationV2InternalCommand,
  { readonly type: "thread.load-pause.clear" }
>;

export interface LoadPauseCandidate {
  readonly thread: Pick<
    OrchestrationV2ThreadShell,
    | "id"
    | "tags"
    | "activeRunId"
    | "activityRunStatus"
    | "pendingRuntimeRequest"
    | "lastVisitedAt"
    | "loadPause"
    | "archivedAt"
    | "deletedAt"
    | "delegatedFrom"
  >;
  /** Owned plus claimed usage from the last ThreadResources rollup. */
  readonly usage: ThreadResourceTotals;
  /** From this thread's delegated-task records, so remote tasks count. */
  readonly hasUnsettledDelegateChild: boolean;
  /** True too when the parent is on another environment, where it cannot be checked. */
  readonly parentWaiting: boolean;
  /** A live `thread` focus lease from a client. */
  readonly focusLease: boolean;
  readonly lastResumedAtMs: number | undefined;
}

export interface LoadPauseVictim {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  /** 0 to 1 of the machine's use of the stressed resource. */
  readonly shareOfLoad: number;
}

/** The thread's share of what the stress rule measures; null for rules no rollup measures (GPU). */
function loadShareOf(
  rule: MachineVerdictReason["rule"],
  usage: ThreadResourceTotals,
  totals: MachineTotalsSummary,
): number | null {
  switch (rule) {
    case "load":
    case "cpu": {
      if (usage.cpuPercent === null || totals.cpuUtilization === null) return null;
      const usedCorePercent = totals.cpuUtilization * totals.cpuCount * 100;
      return usedCorePercent > 0 ? Math.min(1, usage.cpuPercent / usedCorePercent) : null;
    }
    case "memory":
    case "memoryPressure": {
      const used = totals.memoryTotalBytes - totals.memoryAvailableBytes;
      return used > 0 ? Math.min(1, usage.memoryBytes / used) : null;
    }
    case "gpuVram":
    case "gpuUtil":
      return null;
  }
}

const RUNNING_ACTIVITY = new Set(["preparing", "starting", "running"]);

function isPausable(candidate: LoadPauseCandidate, nowMs: number): boolean {
  const { thread } = candidate;
  if (thread.activeRunId === null || !RUNNING_ACTIVITY.has(thread.activityRunStatus ?? "")) {
    return false;
  }
  if (thread.loadPause != null || thread.archivedAt !== null || thread.deletedAt !== null) {
    return false;
  }
  if (thread.pendingRuntimeRequest !== null) return false;
  if (effectiveThreadPriority(thread) !== "low") return false;
  if (thread.tags?.includes(ORCHESTRATOR_THREAD_TAG)) return false;
  if (candidate.hasUnsettledDelegateChild) return false;
  if (thread.delegatedFrom !== undefined && candidate.parentWaiting) return false;
  if (candidate.focusLease) return false;
  if (
    thread.lastVisitedAt != null &&
    nowMs - DateTime.toEpochMillis(thread.lastVisitedAt) < LOAD_PAUSE_FOCUS_WINDOW_MS
  ) {
    return false;
  }
  return (
    candidate.lastResumedAtMs === undefined ||
    nowMs - candidate.lastResumedAtMs >= LOAD_PAUSE_REPAUSE_COOLDOWN_MS
  );
}

/**
 * Largest share first, each at least 15 %, until pausing them would bring the stressed value
 * under its threshold. The value is taken to fall in proportion to the paused share.
 */
export function selectLoadPauseVictims(input: {
  readonly reason: MachineVerdictReason;
  readonly totals: MachineTotalsSummary;
  readonly candidates: ReadonlyArray<LoadPauseCandidate>;
  readonly nowMs: number;
}): ReadonlyArray<LoadPauseVictim> {
  const ranked = input.candidates
    .filter((candidate) => isPausable(candidate, input.nowMs))
    .flatMap((candidate) => {
      const shareOfLoad = loadShareOf(input.reason.rule, candidate.usage, input.totals);
      return shareOfLoad === null || shareOfLoad < LOAD_PAUSE_SHARE_THRESHOLD
        ? []
        : [{ threadId: candidate.thread.id, runId: candidate.thread.activeRunId!, shareOfLoad }];
    })
    .toSorted((a, b) => b.shareOfLoad - a.shareOfLoad);
  const victims: Array<LoadPauseVictim> = [];
  let pausedShare = 0;
  for (const victim of ranked) {
    if (input.reason.value * (1 - pausedShare) < input.reason.threshold) break;
    victims.push(victim);
    pausedShare += victim.shareOfLoad;
  }
  return victims;
}

const isLocalDockerHost = (dockerHost: string | undefined) =>
  dockerHost === undefined || dockerHost.startsWith("unix://") || dockerHost.startsWith("npipe://");

/**
 * The containers each victim's pause stops: only containers every live claim of which belongs
 * to a victim, on a local daemon, and never one the server itself runs in. A container claimed by several victims
 * is recorded on each, so whichever resumes first unpauses it.
 */
export function loadPauseContainers(input: {
  readonly victims: ReadonlySet<ThreadId>;
  readonly claims: ReadonlyArray<ResolvedClaim>;
  readonly serverCgroup: string | undefined;
}): ReadonlyMap<ThreadId, ReadonlyArray<OrchestrationV2LoadPausedContainer>> {
  const claimsByContainer = new Map<string, Array<ResolvedClaim>>();
  for (const resolved of input.claims) {
    if (resolved.claim.target.type !== "container" || resolved.containerId === undefined) continue;
    // Stress here says nothing about another machine's daemon.
    if (!isLocalDockerHost(resolved.claim.target.dockerHost)) continue;
    const key = `${resolved.claim.target.dockerHost ?? ""}\u0000${resolved.containerId}`;
    claimsByContainer.set(key, [...(claimsByContainer.get(key) ?? []), resolved]);
  }
  const byThread = new Map<ThreadId, Array<OrchestrationV2LoadPausedContainer>>();
  for (const claims of claimsByContainer.values()) {
    if (!claims.every((resolved) => input.victims.has(resolved.claim.threadId))) continue;
    const first = claims[0]!;
    if (
      input.serverCgroup !== undefined &&
      first.cgroup !== undefined &&
      isCgroupWithin(input.serverCgroup, first.cgroup)
    ) {
      continue;
    }
    const target = first.claim.target;
    const container: OrchestrationV2LoadPausedContainer = {
      id: first.containerId!,
      ...(target.type === "container" && target.dockerHost !== undefined
        ? { dockerHost: target.dockerHost }
        : {}),
    };
    for (const threadId of new Set(claims.map((resolved) => resolved.claim.threadId))) {
      byThread.set(threadId, [...(byThread.get(threadId) ?? []), container]);
    }
  }
  return byThread;
}

export function loadPauseSetCommand(input: {
  readonly victim: LoadPauseVictim;
  readonly episodeId: string;
  readonly reason: MachineVerdictReason;
  readonly containersPaused: ReadonlyArray<OrchestrationV2LoadPausedContainer>;
}): LoadPauseSetCommand {
  const { victim, episodeId, reason } = input;
  return {
    type: "thread.load-pause.set",
    commandId: CommandId.make(`load-pause-set:${victim.threadId}:${episodeId}`),
    threadId: victim.threadId,
    runId: victim.runId,
    episodeId,
    reason: {
      rule: reason.rule,
      value: reason.value,
      threshold: reason.threshold,
      shareOfLoad: victim.shareOfLoad,
    },
    containersPaused: input.containersPaused,
  };
}

export interface LoadPausedThread {
  readonly threadId: ThreadId;
  readonly loadPause: OrchestrationV2LoadPause;
}

const clearCommand = ({ threadId, loadPause }: LoadPausedThread): LoadPauseClearCommand => ({
  type: "thread.load-pause.clear",
  commandId: CommandId.make(`load-pause-clear:${threadId}:${loadPause.episodeId}`),
  threadId,
  episodeId: loadPause.episodeId,
});

/**
 * `all` clears every pause at once (startup, or the lane turned off). `release` resumes at
 * most one thread per gap, oldest pause first: any once the verdict is `ok`, otherwise only
 * one past the 30 min cap.
 */
export function loadResumeCommands(input: {
  readonly mode: "all" | "release";
  readonly paused: ReadonlyArray<LoadPausedThread>;
  readonly verdict: MachineVerdict | null;
  readonly nowMs: number;
  readonly nextResumeAtMs: number;
}): ReadonlyArray<LoadPauseClearCommand> {
  if (input.mode === "all") return input.paused.map(clearCommand);
  if (input.nowMs < input.nextResumeAtMs) return [];
  const pausedAtMs = (thread: LoadPausedThread) => Date.parse(thread.loadPause.pausedAt);
  const due = input.paused
    .filter(
      (thread) => input.verdict === "ok" || !(input.nowMs - pausedAtMs(thread) < LOAD_PAUSE_MAX_MS),
    )
    .toSorted((a, b) => pausedAtMs(a) - pausedAtMs(b));
  return due.length === 0 ? [] : [clearCommand(due[0]!)];
}
