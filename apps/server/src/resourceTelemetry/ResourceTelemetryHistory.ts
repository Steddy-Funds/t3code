import type {
  DesktopHostTelemetrySnapshot,
  ResourceMonitorSnapshotEvent,
  ResourceTelemetryHealth,
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryBucket,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessSummary,
  ThreadId,
  ThreadResourcePoint,
} from "@t3tools/contracts";
import { THREAD_RESOURCE_HISTORY_POINTS } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  emptyTelemetryCounters,
  mergeProcesses,
  processIdentityKey,
  type ProcessState,
} from "./Model.ts";

const MAX_HISTORY_WINDOW_MS = 60 * 60_000;

export function normalizeResourceTelemetryHistoryInput(input: {
  readonly windowMs: number;
  readonly bucketMs: number;
}): { readonly windowMs: number; readonly bucketMs: number } {
  const windowMs = Math.max(1_000, Math.min(MAX_HISTORY_WINDOW_MS, input.windowMs));
  return {
    windowMs,
    bucketMs: Math.max(1_000, Math.min(windowMs, input.bucketMs)),
  };
}

interface AggregateSample {
  readonly sampledAtMs: number;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly processCount: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
}

interface ProcessSample {
  readonly sampledAtMs: number;
  readonly process: ResourceTelemetryProcess;
  readonly cpuTimeMs: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
}

export interface BuildResourceTelemetryHistoryInput {
  readonly readAt: DateTime.Utc;
  readonly windowMs: number;
  readonly bucketMs: number;
  readonly sampleIntervalMs: number;
  readonly serverPid: number;
  readonly sidecarPid: Option.Option<number>;
  readonly desktopSnapshot: Option.Option<DesktopHostTelemetrySnapshot>;
  readonly snapshots: ReadonlyArray<ResourceMonitorSnapshotEvent>;
  readonly health: ResourceTelemetryHealth;
}

export type ResourceTelemetryHistoryWithLegacyBuckets = ResourceTelemetryHistory & {
  readonly legacyBackendBuckets?: ReadonlyArray<ResourceTelemetryHistoryBucket>;
};

function summarizeProcesses(
  samples: ReadonlyArray<ProcessSample>,
): ReadonlyArray<ResourceTelemetryProcessSummary> {
  const groups = new Map<string, ProcessSample[]>();
  for (const sample of samples) {
    const identityKey = processIdentityKey(
      sample.process.identity.pid,
      sample.process.identity.startTimeMs,
    );
    const current = groups.get(identityKey) ?? [];
    current.push(sample);
    groups.set(identityKey, current);
  }

  return [...groups.values()]
    .map((processSamples): ResourceTelemetryProcessSummary => {
      const sorted = processSamples.toSorted((left, right) => left.sampledAtMs - right.sampledAtMs);
      const first = sorted[0]!;
      const latest = sorted[sorted.length - 1]!;
      const cpuTotal = sorted.reduce((total, sample) => total + sample.process.cpuPercent, 0);
      return {
        identity: latest.process.identity,
        ppid: latest.process.ppid,
        depth: latest.process.depth,
        name: latest.process.name,
        command: latest.process.command,
        category: latest.process.category,
        firstSeenAt: first.process.firstSeenAt,
        lastSeenAt: latest.process.lastSeenAt,
        currentCpuPercent: latest.process.cpuPercent,
        avgCpuPercent: cpuTotal / sorted.length,
        maxCpuPercent: Math.max(...sorted.map((sample) => sample.process.cpuPercent)),
        cpuTimeMs: sorted.reduce((total, sample) => total + sample.cpuTimeMs, 0),
        currentRssBytes: latest.process.residentBytes,
        peakRssBytes: Math.max(...sorted.map((sample) => sample.process.residentBytes)),
        ioReadBytes: sorted.reduce((total, sample) => total + sample.ioReadBytes, 0),
        ioWriteBytes: sorted.reduce((total, sample) => total + sample.ioWriteBytes, 0),
        ioSemantics: latest.process.ioSemantics,
        sampleCount: sorted.length,
      };
    })
    .toSorted(
      (left, right) => right.cpuTimeMs - left.cpuTimeMs || right.peakRssBytes - left.peakRssBytes,
    );
}

function buildBuckets(input: {
  readonly samples: ReadonlyArray<AggregateSample>;
  readonly nowMs: number;
  readonly windowMs: number;
  readonly bucketMs: number;
}): ReadonlyArray<ResourceTelemetryHistoryBucket> {
  const windowStartMs = input.nowMs - input.windowMs;
  const buckets: ResourceTelemetryHistoryBucket[] = [];
  for (let startedAtMs = windowStartMs; startedAtMs < input.nowMs; startedAtMs += input.bucketMs) {
    const endedAtMs = Math.min(input.nowMs, startedAtMs + input.bucketMs);
    const samples = input.samples.filter(
      (sample) =>
        sample.sampledAtMs >= startedAtMs &&
        (endedAtMs === input.nowMs
          ? sample.sampledAtMs <= endedAtMs
          : sample.sampledAtMs < endedAtMs),
    );
    const cpuTotal = samples.reduce((total, sample) => total + sample.cpuPercent, 0);
    buckets.push({
      startedAt: DateTime.makeUnsafe(startedAtMs),
      endedAt: DateTime.makeUnsafe(endedAtMs),
      avgCpuPercent: samples.length === 0 ? 0 : cpuTotal / samples.length,
      maxCpuPercent:
        samples.length === 0 ? 0 : Math.max(...samples.map((sample) => sample.cpuPercent)),
      maxRssBytes: samples.length === 0 ? 0 : Math.max(...samples.map((sample) => sample.rssBytes)),
      ioReadBytes: samples.reduce((total, sample) => total + sample.ioReadBytes, 0),
      ioWriteBytes: samples.reduce((total, sample) => total + sample.ioWriteBytes, 0),
      maxProcessCount:
        samples.length === 0 ? 0 : Math.max(...samples.map((sample) => sample.processCount)),
    });
  }
  return buckets;
}

export function buildResourceTelemetryHistory(
  input: BuildResourceTelemetryHistoryInput,
): ResourceTelemetryHistoryWithLegacyBuckets & {
  readonly legacyBackendBuckets: ReadonlyArray<ResourceTelemetryHistoryBucket>;
} {
  const readAtMs = DateTime.toEpochMillis(input.readAt);
  const { windowMs, bucketMs } = normalizeResourceTelemetryHistoryInput(input);
  const windowStartMs = readAtMs - windowMs;
  const eligibleSnapshots = input.snapshots
    .filter((snapshot) => snapshot.sampledAtUnixMs <= readAtMs)
    .toSorted((left, right) => left.sampledAtUnixMs - right.sampledAtUnixMs);
  const snapshotsInWindow = eligibleSnapshots.filter(
    (snapshot) => snapshot.sampledAtUnixMs >= windowStartMs,
  );
  const precedingSnapshot = eligibleSnapshots.findLast(
    (snapshot) => snapshot.sampledAtUnixMs < windowStartMs,
  );
  const snapshots = precedingSnapshot
    ? [precedingSnapshot, ...snapshotsInWindow]
    : snapshotsInWindow;
  const aggregateSamples: AggregateSample[] = [];
  const legacyBackendAggregateSamples: AggregateSample[] = [];
  const processSamples: ProcessSample[] = [];
  const previous = new Map<string, ProcessState>();
  const counters = emptyTelemetryCounters();
  let previousSnapshotAtMs: number | undefined;

  for (const snapshot of snapshots) {
    const deltaWindowFraction =
      previousSnapshotAtMs !== undefined &&
      previousSnapshotAtMs < windowStartMs &&
      snapshot.sampledAtUnixMs > previousSnapshotAtMs
        ? Math.max(
            0,
            Math.min(
              1,
              (snapshot.sampledAtUnixMs - windowStartMs) /
                (snapshot.sampledAtUnixMs - previousSnapshotAtMs),
            ),
          )
        : 1;
    previousSnapshotAtMs = snapshot.sampledAtUnixMs;
    const recordedExternalProcesses =
      snapshot.externalProcesses ??
      Option.match(input.desktopSnapshot, {
        onNone: () => [],
        onSome: (desktopSnapshot) => [
          {
            pid: desktopSnapshot.electronPid,
            startTimeMs: desktopSnapshot.electronProcesses.find(
              (metric) => metric.pid === desktopSnapshot.electronPid,
            )?.creationTimeMs,
          },
        ],
      });
    const electronRootPids = new Set(recordedExternalProcesses.map((process) => process.pid));
    const electronRootStartTimes = new Map(
      recordedExternalProcesses.flatMap((process) =>
        process.startTimeMs === undefined ? [] : [[process.pid, process.startTimeMs] as const],
      ),
    );
    const merged = mergeProcesses({
      serverPid: input.serverPid,
      sidecarPid: input.sidecarPid,
      fallbackSampledAtMs: snapshot.sampledAtUnixMs,
      nativeSnapshot: Option.some(snapshot),
      desktopSnapshot: Option.none(),
      electronRootPids,
      electronRootStartTimes,
      previous,
      counters,
      updatePrevious: true,
      accumulateCounters: false,
    });
    // Keep absent identities' baselines without copying every exited process on each sample.
    for (const [identityKey, state] of merged.previous) {
      previous.set(identityKey, state);
    }
    if (snapshot.sampledAtUnixMs < windowStartMs) {
      continue;
    }
    const deltas =
      deltaWindowFraction === 1
        ? merged.deltas
        : merged.deltas.map((delta) => ({
            ...delta,
            cpuTimeMs: Math.round(delta.cpuTimeMs * deltaWindowFraction),
            ioReadBytes: Math.round(delta.ioReadBytes * deltaWindowFraction),
            ioWriteBytes: Math.round(delta.ioWriteBytes * deltaWindowFraction),
          }));
    const deltasByIdentity = new Map(
      deltas.map((processDelta) => [processDelta.identityKey, processDelta]),
    );
    aggregateSamples.push({
      sampledAtMs: snapshot.sampledAtUnixMs,
      cpuPercent: merged.groups.allT3.currentCpuPercent,
      rssBytes: merged.groups.allT3.currentRssBytes,
      processCount: merged.groups.allT3.processCount,
      ioReadBytes: deltas.reduce((total, process) => total + process.ioReadBytes, 0),
      ioWriteBytes: deltas.reduce((total, process) => total + process.ioWriteBytes, 0),
    });
    const backendDeltas = deltas.filter(
      (processDelta) =>
        processDelta.category === "server" ||
        processDelta.category === "server-child" ||
        processDelta.category === "provider-root" ||
        processDelta.category === "terminal-root",
    );
    legacyBackendAggregateSamples.push({
      sampledAtMs: snapshot.sampledAtUnixMs,
      cpuPercent: merged.groups.backend.currentCpuPercent,
      rssBytes: merged.groups.backend.currentRssBytes,
      processCount: merged.groups.backend.processCount,
      ioReadBytes: backendDeltas.reduce((total, process) => total + process.ioReadBytes, 0),
      ioWriteBytes: backendDeltas.reduce((total, process) => total + process.ioWriteBytes, 0),
    });
    for (const process of merged.processes) {
      const processDelta = deltasByIdentity.get(
        processIdentityKey(process.identity.pid, process.identity.startTimeMs),
      );
      processSamples.push({
        sampledAtMs: snapshot.sampledAtUnixMs,
        process,
        cpuTimeMs: processDelta?.cpuTimeMs ?? 0,
        ioReadBytes: processDelta?.ioReadBytes ?? 0,
        ioWriteBytes: processDelta?.ioWriteBytes ?? 0,
      });
    }
  }

  return {
    readAt: input.readAt,
    windowMs,
    bucketMs,
    sampleIntervalMs: input.sampleIntervalMs,
    retainedSampleCount: aggregateSamples.length + processSamples.length,
    buckets: buildBuckets({ samples: aggregateSamples, nowMs: readAtMs, windowMs, bucketMs }),
    legacyBackendBuckets: buildBuckets({
      samples: legacyBackendAggregateSamples,
      nowMs: readAtMs,
      windowMs,
      bucketMs,
    }),
    topProcesses: summarizeProcesses(processSamples),
    health: input.health,
  };
}

/** One thread history point per window. */
export const THREAD_HISTORY_STEP_MS = 30_000;
/** Threads with history; those whose newest point is oldest go first. */
export const THREAD_HISTORY_MAX_THREADS = 200;

export interface ThreadUsage {
  readonly cpuPercent: number;
  readonly memoryBytes: number;
}

/** A fixed ring of (at, cpu, memory) triples, oldest overwritten first. */
class ThreadRing {
  private readonly values = new Float64Array(THREAD_RESOURCE_HISTORY_POINTS * 3);
  private head = 0;
  count = 0;
  lastAtMs = 0;

  push(atMs: number, cpuPercent: number, memoryBytes: number): void {
    const slot = this.head * 3;
    this.values[slot] = atMs;
    this.values[slot + 1] = cpuPercent;
    this.values[slot + 2] = memoryBytes;
    this.head = (this.head + 1) % THREAD_RESOURCE_HISTORY_POINTS;
    this.count = Math.min(this.count + 1, THREAD_RESOURCE_HISTORY_POINTS);
    this.lastAtMs = atMs;
  }

  read(nowMs: number): Array<ThreadResourcePoint> {
    const points: Array<ThreadResourcePoint> = [];
    for (let index = 0; index < this.count; index++) {
      const slot =
        ((this.head - this.count + index + THREAD_RESOURCE_HISTORY_POINTS) %
          THREAD_RESOURCE_HISTORY_POINTS) *
        3;
      points.push({
        ageMs: Math.max(0, Math.round(nowMs - this.values[slot]!)),
        cpuPercent: this.values[slot + 1]!,
        memoryBytes: this.values[slot + 2]!,
        gpuUtilPercent: null,
      });
    }
    return points;
  }
}

/**
 * Per-thread history in fixed rings: each 30 s window's ticks average into one point for every
 * thread seen in it. A thread absent from some ticks averages lower; one absent from a whole
 * window gets no point, so the gap shows.
 */
export class ThreadResourceHistory {
  private readonly rings = new Map<ThreadId, ThreadRing>();
  private readonly window = new Map<ThreadId, { cpuSum: number; memoryBytes: number }>();
  private windowTicks = 0;
  private windowStartMs: number | null = null;
  private lastTickMs = 0;

  /** Folds one tick in; true when it closed a window. */
  record(atMs: number, usage: ReadonlyMap<ThreadId, ThreadUsage>): boolean {
    let closed = false;
    // Ticks stopped for longer than a window (the monitor was down): close at the last one.
    if (this.windowStartMs !== null && atMs - this.lastTickMs > THREAD_HISTORY_STEP_MS) {
      this.close(this.lastTickMs);
      this.windowStartMs = null;
      closed = true;
    }
    this.windowStartMs ??= atMs;
    this.windowTicks += 1;
    this.lastTickMs = atMs;
    for (const [threadId, { cpuPercent, memoryBytes }] of usage) {
      const entry = this.window.get(threadId);
      if (entry === undefined) this.window.set(threadId, { cpuSum: cpuPercent, memoryBytes });
      else {
        entry.cpuSum += cpuPercent;
        entry.memoryBytes = memoryBytes;
      }
    }
    if (atMs - this.windowStartMs >= THREAD_HISTORY_STEP_MS) {
      this.close(atMs);
      this.windowStartMs = atMs;
      closed = true;
    }
    return closed;
  }

  /** Oldest first, ages relative to `nowMs`. */
  read(threadId: ThreadId, nowMs: number): ReadonlyArray<ThreadResourcePoint> {
    return this.rings.get(threadId)?.read(nowMs) ?? [];
  }

  threadIds(): ReadonlyArray<ThreadId> {
    return [...this.rings.keys()];
  }

  forget(threadIds: Iterable<ThreadId>): void {
    for (const threadId of threadIds) {
      this.rings.delete(threadId);
      this.window.delete(threadId);
    }
  }

  private close(atMs: number): void {
    for (const [threadId, { cpuSum, memoryBytes }] of this.window) {
      let ring = this.rings.get(threadId);
      if (ring === undefined) {
        ring = new ThreadRing();
        this.rings.set(threadId, ring);
      }
      ring.push(atMs, Math.round((cpuSum / this.windowTicks) * 10) / 10, Math.round(memoryBytes));
    }
    this.window.clear();
    this.windowTicks = 0;
    if (this.rings.size <= THREAD_HISTORY_MAX_THREADS) return;
    const stale = [...this.rings]
      .toSorted((a, b) => b[1].lastAtMs - a[1].lastAtMs)
      .slice(THREAD_HISTORY_MAX_THREADS);
    for (const [threadId] of stale) this.rings.delete(threadId);
  }
}
