// @effect-diagnostics nodeBuiltinImport:off -- cgroup and /proc files are tiny and read in one pass.
import * as NodeFS from "node:fs";

import {
  THREAD_RESOURCE_HISTORY_POINTS,
  ThreadId,
  type ResourceMonitorProcessSample,
  type ThreadResourcePoint,
  type ThreadResources as ThreadResourcesResult,
  type ThreadResourceTotals,
} from "@t3tools/contracts";
import { cgroupDirectory, isCgroupWithin } from "@t3tools/shared/cgroup";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  ProcessOwnershipRegistry,
  type RegisteredRoot,
} from "@t3tools/shared/ProcessOwnershipRegistry";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import { parseProcEnvironThread } from "../preview/PortScanner.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import {
  ownerThreadId,
  ProcessOwnership,
  processKey,
  type OwnershipRow,
  type ResolvedClaim,
} from "./ProcessOwnership.ts";

const ROLLUP_INTERVAL_MS = 30_000;
/** The Scheduler ticks every 5 s, so a rollup lands 30 to 35 s after the previous one. */
const ROLLUP_FRESH_MS = ROLLUP_INTERVAL_MS + 10_000;
const MAX_THREADS = 200;
/** Linux reports process CPU time in USER_HZ ticks, 100 per second on every supported kernel. */
const CLOCK_TICKS_PER_SECOND = 100;

/** A cgroup measured for one thread: a registered root's unit or a claimed container or cgroup. */
export interface MeasureUnit {
  readonly threadId: ThreadId | null;
  readonly cgroup: string;
  /** A shared unit: its members are split by `T3CODE_THREAD_ID`, process by process. */
  readonly split: boolean;
}

export interface PlannedUnit extends MeasureUnit {
  /** Kept units directly inside this one; their usage is taken out of this unit's own. */
  readonly subtract: ReadonlyArray<string>;
}

/**
 * Each cgroup is counted once. Units come in attribution order (roots, then claims oldest
 * first), so a unit equal to or inside an earlier one is dropped, and an outer unit subtracts
 * the kept units nested directly inside it. Cgroup counters are hierarchical, so this leaves
 * every process in exactly one unit.
 */
export function planUnits(units: ReadonlyArray<MeasureUnit>): ReadonlyArray<PlannedUnit> {
  const kept: Array<MeasureUnit> = [];
  for (const unit of units) {
    if (kept.some((other) => isCgroupWithin(unit.cgroup, other.cgroup))) continue;
    kept.push(unit);
  }
  return kept.map((unit) => {
    const inside = kept.filter(
      (other) => other !== unit && isCgroupWithin(other.cgroup, unit.cgroup),
    );
    const direct = inside.filter(
      (other) =>
        !inside.some(
          (between) => between !== other && isCgroupWithin(other.cgroup, between.cgroup),
        ),
    );
    return { ...unit, subtract: direct.map((other) => other.cgroup) };
  });
}

/** Units in attribution order: thread and shared roots with an adopted cgroup, then claims. */
export function measureUnits(
  roots: ReadonlyArray<RegisteredRoot>,
  claims: ReadonlyArray<ResolvedClaim>,
): ReadonlyArray<MeasureUnit> {
  const units: Array<MeasureUnit> = [];
  for (const entry of roots) {
    if (entry.cgroup.type !== "adopted") continue;
    const owner = entry.root.owner;
    if (owner.type === "thread") {
      units.push({ threadId: ThreadId.make(owner.threadId), cgroup: entry.cgroup.cgroup, split: false });
    } else {
      // Shared and T3 units are still units: they keep their processes out of outer claims.
      units.push({
        threadId: null,
        cgroup: entry.cgroup.cgroup,
        split: owner.type === "shared" && entry.root.splitByEnv === true,
      });
    }
  }
  for (const resolved of claims) {
    if (resolved.cgroup === undefined) continue;
    units.push({ threadId: resolved.claim.threadId, cgroup: resolved.cgroup, split: false });
  }
  return units;
}

export function parseCpuStatUsageUsec(contents: string): number | undefined {
  const match = /^usage_usec (\d+)$/m.exec(contents);
  return match ? Number(match[1]) : undefined;
}

/** Utime plus stime in ticks, and the start time in ticks since boot, from `/proc/<pid>/stat`. */
export function parseProcStat(
  contents: string,
): { readonly cpuTicks: number; readonly startTicks: number } | undefined {
  // The command name may hold spaces and parentheses, so fields count from its last `)`.
  const fields = contents.slice(contents.lastIndexOf(")") + 2).split(" ");
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const start = Number(fields[19]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime) || !Number.isFinite(start)) return undefined;
  return { cpuTicks: utime + stime, startTicks: start };
}

export const parseStatmResidentPages = (contents: string): number | undefined => {
  const pages = Number(contents.split(" ")[1]);
  return Number.isFinite(pages) ? pages : undefined;
};

/** Percent of one core between two cumulative CPU readings; 0 without an earlier reading. */
export function cpuPercentBetween(
  previous: { readonly cpuMs: number; readonly atMs: number } | undefined,
  cpuMs: number,
  atMs: number,
): number {
  if (previous === undefined || atMs - previous.atMs < 1_000 || cpuMs < previous.cpuMs) return 0;
  return ((cpuMs - previous.cpuMs) / (atMs - previous.atMs)) * 100;
}

/** An on-demand read reports CPU only when every reading it rests on had a predecessor this young. */
const CPU_CURRENT_MAX_AGE_MS = 10_000;

/** Whether `cpuPercentBetween` measured a real interval short enough to call current. */
export function cpuIsCurrent(
  previous: { readonly atMs: number } | undefined,
  atMs: number,
): boolean {
  if (previous === undefined) return false;
  const elapsed = atMs - previous.atMs;
  return elapsed >= 1_000 && elapsed < CPU_CURRENT_MAX_AGE_MS;
}

interface Point {
  readonly atMs: number;
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly gpuUtilPercent: number | null;
}

/** Appends one point, keeping the newest `THREAD_RESOURCE_HISTORY_POINTS`. */
export function appendPoint(ring: ReadonlyArray<Point>, point: Point): ReadonlyArray<Point> {
  const next = [...ring, point];
  return next.length > THREAD_RESOURCE_HISTORY_POINTS
    ? next.slice(next.length - THREAD_RESOURCE_HISTORY_POINTS)
    : next;
}

/** At most 200 rings: the threads whose last point is oldest go first. */
export function boundRings(
  rings: ReadonlyMap<ThreadId, ReadonlyArray<Point>>,
): Map<ThreadId, ReadonlyArray<Point>> {
  if (rings.size <= MAX_THREADS) return new Map(rings);
  const lastAt = (ring: ReadonlyArray<Point>) => ring.at(-1)?.atMs ?? 0;
  return new Map(
    [...rings].toSorted((a, b) => lastAt(b[1]) - lastAt(a[1])).slice(0, MAX_THREADS),
  );
}

export const historyPoints = (
  ring: ReadonlyArray<Point>,
  nowMs: number,
): ReadonlyArray<ThreadResourcePoint> =>
  ring.map((point) => ({
    ageMs: Math.max(0, Math.round(nowMs - point.atMs)),
    cpuPercent: point.cpuPercent,
    memoryBytes: point.memoryBytes,
    gpuUtilPercent: point.gpuUtilPercent,
  }));

interface Totals {
  cpuPercent: number;
  /** Every CPU reading summed here rests on a recent predecessor. */
  cpuCurrent: boolean;
  memoryBytes: number;
  processCount: number;
  cgroup: boolean;
  sample: boolean;
}

const emptyTotals = (): Totals => ({
  cpuPercent: 0,
  cpuCurrent: true,
  memoryBytes: 0,
  processCount: 0,
  cgroup: false,
  sample: false,
});

const roundCpu = (cpuPercent: number) => Math.round(cpuPercent * 10) / 10;

/** On demand, CPU is null unless it is current; a rollup's 30 s average is always a number. */
const toTotals = (
  totals: Totals,
  sampleAgeMs: number,
  onDemand: boolean,
): ThreadResourceTotals => ({
  cpuPercent: onDemand && !totals.cpuCurrent ? null : roundCpu(totals.cpuPercent),
  memoryBytes: Math.round(totals.memoryBytes),
  // Per-thread GPU use needs the host process walk, which the rollup never runs.
  gpuUtilPercent: null,
  vramBytes: null,
  processCount: totals.processCount,
  sampleAgeMs,
  source: totals.cgroup ? "cgroup" : totals.sample ? "sample" : "none",
});

export interface ThreadResourcesIo {
  /** A cgroup or /proc file, or undefined when it is gone or unreadable. */
  readonly readFile: (path: string) => string | undefined;
  /** The names of a directory's subdirectories; empty when it is gone or unreadable. */
  readonly readDirectories: (path: string) => ReadonlyArray<string>;
  readonly pageSize: number;
}

const readFileOrUndefined = (path: string) => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/** The kernel's page size, from this process's own resident set and page count. */
function livePageSize(): number {
  const pages = parseStatmResidentPages(readFileOrUndefined("/proc/self/statm") ?? "");
  if (!pages) return 4_096;
  const size = process.memoryUsage.rss() / pages;
  return 2 ** Math.round(Math.log2(size));
}

const readDirectoriesOrEmpty = (path: string) => {
  try {
    return NodeFS.readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

export const liveIo = (): ThreadResourcesIo => ({
  readFile: readFileOrUndefined,
  readDirectories: readDirectoriesOrEmpty,
  pageSize: livePageSize(),
});

export interface ThreadResourcesShape {
  /** `current` is sampled on demand when the thread has no running turn. */
  readonly read: (threadId: ThreadId) => Effect.Effect<ThreadResourcesResult>;
  /** Totals from the last rollup, for threads with a running turn then. */
  readonly byThread: Effect.Effect<ReadonlyMap<ThreadId, ThreadResourceTotals>>;
  /** One rollup, if 30 s passed and a turn is running; the Scheduler calls it every tick. */
  readonly rollup: Effect.Effect<void>;
}

/** Empty unless the server provides one, so RPC test layers need no stand-in. */
export class ThreadResources extends Context.Reference<ThreadResourcesShape>(
  "t3/resourceTelemetry/ThreadResources",
  {
    defaultValue: () => ({
      read: () => Effect.succeed({ current: null, history: [] }),
      byThread: Effect.succeed(new Map()),
      rollup: Effect.void,
    }),
  },
) {}

export const makeWith = Effect.fn("ThreadResources.make")(function* (io: ThreadResourcesIo) {
  const registry = yield* ProcessOwnershipRegistry;
  const ownership = yield* ProcessOwnership;
  const native = yield* NativeTelemetryClient.NativeTelemetryClient;
  const projections = yield* ProjectionStoreV2.ProjectionStoreV2;
  const platform = yield* HostProcess.Platform;
  const lock = yield* Semaphore.make(1);

  const cgroupCpu = new Map<string, { cpuMs: number; atMs: number }>();
  const processCpu = new Map<string, { cpuMs: number; atMs: number }>();
  const memberThreads = new Map<string, ThreadId | null>();
  const pidCgroups = new Map<string, string | null>();
  let rings = new Map<ThreadId, ReadonlyArray<Point>>();
  let latest: { readonly atMs: number; readonly totals: ReadonlyMap<ThreadId, ThreadResourceTotals> } =
    { atMs: 0, totals: new Map() };
  let lastRollupAtMs: number | null = null;

  const readProcs = (directory: string) =>
    (io.readFile(`${directory}/cgroup.procs`) ?? "")
      .split("\n")
      .filter((line) => line !== "")
      .map(Number);

  /** Processes in the cgroups below `cgroup`, leaving out the subtrees of the kept units in `skip`. */
  const countDescendantProcs = (cgroup: string, skip: ReadonlyArray<string>): number =>
    io.readDirectories(cgroupDirectory(cgroup)).reduce((sum, name) => {
      const child = `${cgroup}/${name}`;
      if (skip.includes(child)) return sum;
      return sum + readProcs(cgroupDirectory(child)).length + countDescendantProcs(child, skip);
    }, 0);

  const readCgroup = (unit: string, atMs: number) => {
    const directory = cgroupDirectory(unit);
    const usage = parseCpuStatUsageUsec(io.readFile(`${directory}/cpu.stat`) ?? "");
    if (usage === undefined) return undefined;
    const procs = readProcs(directory);
    const cpuMs = usage / 1_000;
    const previous = cgroupCpu.get(unit);
    const cpuPercent = cpuPercentBetween(previous, cpuMs, atMs);
    const cpuCurrent = cpuIsCurrent(previous, atMs);
    cgroupCpu.set(unit, { cpuMs, atMs });
    const current = Number(io.readFile(`${directory}/memory.current`));
    // Without memory delegation there is no memory.current; sum the members' resident pages.
    const memoryBytes = Number.isFinite(current)
      ? current
      : procs.reduce(
          (sum, pid) =>
            sum +
            (parseStatmResidentPages(io.readFile(`/proc/${pid}/statm`) ?? "") ?? 0) * io.pageSize,
          0,
        );
    return { cpuPercent, cpuCurrent, memoryBytes, procs };
  };

  /** A shared unit's members, each read once for its thread, then by `stat` and `statm`. */
  const readSplitMembers = (
    procs: ReadonlyArray<number>,
    atMs: number,
    seen: Set<string>,
    add: (threadId: ThreadId, cpu: number, cpuCurrent: boolean, memory: number) => void,
  ) => {
    for (const pid of procs) {
      const stat = parseProcStat(io.readFile(`/proc/${pid}/stat`) ?? "");
      if (stat === undefined) continue;
      const key = `${pid}:${stat.startTicks}`;
      seen.add(key);
      let threadId = memberThreads.get(key);
      if (threadId === undefined) {
        const environ = io.readFile(`/proc/${pid}/environ`);
        threadId = environ === undefined ? null : parseProcEnvironThread(environ);
        memberThreads.set(key, threadId);
      }
      const cpuMs = (stat.cpuTicks * 1_000) / CLOCK_TICKS_PER_SECOND;
      const previous = processCpu.get(key);
      const cpuPercent = cpuPercentBetween(previous, cpuMs, atMs);
      const cpuCurrent = cpuIsCurrent(previous, atMs);
      processCpu.set(key, { cpuMs, atMs });
      if (threadId === null) continue;
      const pages = parseStatmResidentPages(io.readFile(`/proc/${pid}/statm`) ?? "") ?? 0;
      add(threadId, cpuPercent, cpuCurrent, pages * io.pageSize);
    }
  };

  const pidCgroupOf = (row: ResourceMonitorProcessSample) => {
    const key = processKey(row.pid, row.startTimeMs);
    let cgroup = pidCgroups.get(key);
    if (cgroup === undefined) {
      const contents = io.readFile(`/proc/${row.pid}/cgroup`);
      const match = contents === undefined ? null : /^0::(\/.*)$/m.exec(contents);
      cgroup = match?.[1] ?? null;
      pidCgroups.set(key, cgroup);
    }
    return cgroup;
  };

  /**
   * Totals for `threads`. Linux reads each unit's cgroup files; processes outside every unit
   * (pid-only roots, process claims, and everything on macOS and Windows) come from one
   * `sampleNow` of the T3 subtree, attributed so each process has one owner.
   */
  const measure = Effect.fn("ThreadResources.measure")(function* (
    threads: ReadonlySet<ThreadId>,
  ) {
    const atMs = yield* Clock.currentTimeMillis;
    const seen = new Set<string>();
    const roots = registry.roots();
    const claims = yield* ownership.resolvedClaims;
    const totals = new Map<ThreadId, Totals>();
    const totalsOf = (threadId: ThreadId) => {
      let entry = totals.get(threadId);
      if (entry === undefined) {
        entry = emptyTotals();
        totals.set(threadId, entry);
      }
      return entry;
    };
    const wanted = (threadId: ThreadId | null): threadId is ThreadId =>
      threadId !== null && threads.has(threadId);

    const units = platform === "linux" ? planUnits(measureUnits(roots, claims)) : [];
    const readings = new Map<string, ReturnType<typeof readCgroup>>();
    for (const unit of units) {
      if (unit.split || wanted(unit.threadId)) {
        readings.set(unit.cgroup, readCgroup(unit.cgroup, atMs));
      }
    }
    for (const unit of units) {
      const reading = readings.get(unit.cgroup);
      if (reading === undefined) continue;
      if (unit.split) {
        readSplitMembers(reading.procs, atMs, seen, (threadId, cpu, cpuCurrent, memory) => {
          if (!wanted(threadId)) return;
          const entry = totalsOf(threadId);
          entry.cpuPercent += cpu;
          entry.cpuCurrent &&= cpuCurrent;
          entry.memoryBytes += memory;
          entry.processCount += 1;
          entry.cgroup = true;
        });
        continue;
      }
      if (!wanted(unit.threadId)) continue;
      const nested = unit.subtract.flatMap((cgroup) => {
        const inner = readings.get(cgroup) ?? readCgroup(cgroup, atMs);
        return inner === undefined ? [] : [inner];
      });
      const entry = totalsOf(unit.threadId);
      entry.cpuPercent += Math.max(
        0,
        reading.cpuPercent - nested.reduce((sum, inner) => sum + inner.cpuPercent, 0),
      );
      entry.cpuCurrent &&= reading.cpuCurrent && nested.every((inner) => inner.cpuCurrent);
      entry.memoryBytes += Math.max(
        0,
        reading.memoryBytes - nested.reduce((sum, inner) => sum + inner.memoryBytes, 0),
      );
      // cgroup.procs lists only the cgroup's own processes, so walk its sub-cgroups too.
      entry.processCount +=
        reading.procs.length + countDescendantProcs(unit.cgroup, unit.subtract);
      entry.cgroup = true;
    }

    const threadRoots = roots.some(
      (entry) =>
        entry.root.pid !== undefined &&
        (platform !== "linux" || entry.cgroup.type !== "adopted") &&
        entry.root.owner.type !== "t3",
    );
    const processClaimIds = new Set(
      claims.flatMap((resolved) =>
        resolved.claim.target.type === "process" ? [resolved.claim.id] : [],
      ),
    );
    /** The innermost unit holding the row's cgroup, which already counted the row. */
    const unitOf = (row: ResourceMonitorProcessSample) => {
      const cgroup = pidCgroupOf(row);
      if (cgroup === null) return undefined;
      let inner: PlannedUnit | undefined;
      for (const unit of units) {
        if (!isCgroupWithin(cgroup, unit.cgroup)) continue;
        if (inner === undefined || unit.cgroup.length > inner.cgroup.length) inner = unit;
      }
      return inner;
    };
    if (threadRoots || processClaimIds.size > 0) {
      const sample = yield* native.sampleNow.pipe(Effect.option);
      if (Option.isSome(sample)) {
        const processes = sample.value.snapshot.processes;
        const owners = yield* ownership.attribute(processes.map(sampleOwnershipRow));
        for (const row of processes) {
          const key = processKey(row.pid, row.startTimeMs);
          seen.add(key);
          const previous = processCpu.get(key);
          const cpuPercent = cpuPercentBetween(previous, row.cpuTimeMs, atMs);
          const cpuCurrent = cpuIsCurrent(previous, atMs);
          processCpu.set(key, { cpuMs: row.cpuTimeMs, atMs });
          const owner = owners.get(key);
          const threadId = owner === undefined ? null : ownerThreadId(owner);
          const processClaimed = owner?.type === "claimed" && processClaimIds.has(owner.claimId);
          if (!wanted(threadId) && !processClaimed) continue;
          const unit = units.length > 0 ? unitOf(row) : undefined;
          if (unit !== undefined) {
            // A process claim inside another thread's claimed cgroup belongs to the process
            // claim, as attribution says, so it moves out of that cgroup's totals.
            const movesOut =
              processClaimed && !unit.split && unit.threadId !== null && unit.threadId !== threadId;
            if (!movesOut) continue;
            const from = totals.get(unit.threadId);
            if (from !== undefined) {
              from.cpuPercent = Math.max(0, from.cpuPercent - cpuPercent);
              from.cpuCurrent &&= cpuCurrent;
              from.memoryBytes = Math.max(0, from.memoryBytes - row.residentBytes);
              from.processCount = Math.max(0, from.processCount - 1);
            }
          }
          if (!wanted(threadId)) continue;
          const entry = totalsOf(threadId);
          entry.cpuPercent += cpuPercent;
          entry.cpuCurrent &&= cpuCurrent;
          entry.memoryBytes += row.residentBytes;
          entry.processCount += 1;
          entry.sample = true;
        }
        const live = new Set(processes.map((row) => processKey(row.pid, row.startTimeMs)));
        for (const key of pidCgroups.keys()) if (!live.has(key)) pidCgroups.delete(key);
      }
    }
    for (const key of processCpu.keys()) if (!seen.has(key)) processCpu.delete(key);
    for (const key of memberThreads.keys()) if (!seen.has(key)) memberThreads.delete(key);
    const liveUnits = new Set(units.map((unit) => unit.cgroup));
    for (const unit of cgroupCpu.keys()) if (!liveUnits.has(unit)) cgroupCpu.delete(unit);
    return { atMs, totals };
  });

  const rollupNow = Effect.fn("ThreadResources.rollupNow")(function* (
    running: ReadonlySet<ThreadId>,
  ) {
    const { atMs, totals } = yield* measure(running);
    const next = new Map(rings);
    const byThread = new Map<ThreadId, ThreadResourceTotals>();
    for (const threadId of running) {
      const entry = totals.get(threadId);
      if (entry === undefined) continue;
      const value = toTotals(entry, 0, false);
      byThread.set(threadId, value);
      next.set(
        threadId,
        appendPoint(next.get(threadId) ?? [], {
          atMs,
          cpuPercent: roundCpu(entry.cpuPercent),
          memoryBytes: value.memoryBytes,
          gpuUtilPercent: value.gpuUtilPercent,
        }),
      );
    }
    rings = boundRings(next);
    latest = { atMs, totals: byThread };
  });

  const rollup: ThreadResourcesShape["rollup"] = lock.withPermits(1)(
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      if (lastRollupAtMs !== null && nowMs - lastRollupAtMs < ROLLUP_INTERVAL_MS) return;
      const running = yield* projections.listRunningThreadIds();
      if (running.length === 0) return;
      lastRollupAtMs = nowMs;
      yield* rollupNow(new Set(running));
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not roll up thread resources", { cause: cause.message }),
      ),
    ),
  );

  const read: ThreadResourcesShape["read"] = Effect.fn("ThreadResources.read")(function* (
    threadId,
  ) {
    const nowMs = yield* Clock.currentTimeMillis;
    const recent = latest.totals.get(threadId);
    const current =
      recent !== undefined && nowMs - latest.atMs <= ROLLUP_FRESH_MS
        ? { ...recent, sampleAgeMs: Math.max(0, Math.round(nowMs - latest.atMs)) }
        : yield* lock.withPermits(1)(
            Effect.map(measure(new Set([threadId])), ({ totals }) => {
              const entry = totals.get(threadId);
              return entry === undefined ? null : toTotals(entry, 0, true);
            }),
          );
    return { current, history: historyPoints(rings.get(threadId) ?? [], nowMs) };
  });

  return {
    read,
    byThread: Effect.sync(() => latest.totals),
    rollup,
  } satisfies ThreadResourcesShape;
});

const sampleOwnershipRow = (row: ResourceMonitorProcessSample): OwnershipRow => ({
  pid: row.pid,
  ppid: row.ppid,
  startTimeMs: row.startTimeMs,
  name: row.name,
  command: row.command,
  exe: "",
  cwd: "",
  user: "",
  cgroup: "",
  containerId: "",
});

const register = Effect.fn("ThreadResources.register")(function* (service: ThreadResourcesShape) {
  const scheduler = yield* Scheduler.Scheduler;
  yield* scheduler.register("thread-resources", service.rollup);
});

export const layerWith = (io: ThreadResourcesIo) =>
  Layer.effect(
    ThreadResources,
    Effect.tap(makeWith(io), register),
  );

export const layer = Layer.unwrap(Effect.sync(() => layerWith(liveIo())));
