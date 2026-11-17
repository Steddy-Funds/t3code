import {
  type ProcessOwner,
  type ThreadId,
  type ThreadResources as ThreadResourcesResult,
  type ThreadResourceTotals,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import type * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import { ownerThreadId, processKey } from "./ProcessOwnership.ts";
import { ResourceSampler, type AttributedSample } from "./ResourceSampler.ts";
import { ThreadResourceHistory } from "./ResourceTelemetryHistory.ts";

/** Subagent links change only when a subagent starts or a thread is deleted. */
const LINKS_TTL = "30 seconds";
/** Which threads have a running turn: history keeps points for their lineages only. */
const RUNNING_TTL = "5 seconds";

export interface Totals {
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
}

const add = (into: Totals, from: Totals) => {
  into.cpuPercent += from.cpuPercent;
  into.memoryBytes += from.memoryBytes;
  into.processCount += from.processCount;
};

/** Each thread's own totals in one sample: every process counts once, toward its owner's thread. */
export function sumByThread(
  sample: NativeTelemetryClient.NativeHostSample["sample"],
  owners: ReadonlyMap<string, ProcessOwner>,
): Map<ThreadId, Totals> {
  const totals = new Map<ThreadId, Totals>();
  const columns = sample.processes;
  if (!columns) return totals;
  for (let index = 0; index < columns.pid.length; index++) {
    const owner = owners.get(processKey(columns.pid[index]!, columns.startTimeMs[index]!));
    const threadId = owner === undefined ? null : ownerThreadId(owner);
    if (threadId === null) continue;
    let entry = totals.get(threadId);
    if (entry === undefined) {
      entry = { cpuPercent: 0, memoryBytes: 0, processCount: 0 };
      totals.set(threadId, entry);
    }
    entry.cpuPercent += columns.cpuPercent[index]!;
    entry.memoryBytes += columns.residentBytes[index]!;
    entry.processCount += 1;
  }
  return totals;
}

/** Subagent links by both ends. */
export interface LinkIndex {
  readonly parents: ReadonlyMap<ThreadId, ThreadId>;
  readonly children: ReadonlyMap<ThreadId, ReadonlyArray<ThreadId>>;
}

export function indexLinks(links: ReadonlyArray<ProjectionStoreV2.SubagentLink>): LinkIndex {
  const parents = new Map<ThreadId, ThreadId>();
  const children = new Map<ThreadId, Array<ThreadId>>();
  for (const link of links) {
    parents.set(link.threadId, link.parentThreadId);
    const siblings = children.get(link.parentThreadId);
    if (siblings === undefined) children.set(link.parentThreadId, [link.threadId]);
    else siblings.push(link.threadId);
  }
  return { parents, children };
}

const NO_LINKS: LinkIndex = { parents: new Map(), children: new Map() };

/** The thread, then its `subagent` descendants, breadth first. */
export function lineageOf(index: LinkIndex, threadId: ThreadId): ReadonlyArray<ThreadId> {
  const lineage = [threadId];
  const seen = new Set(lineage);
  for (let at = 0; at < lineage.length; at++) {
    for (const child of index.children.get(lineage[at]!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      lineage.push(child);
    }
  }
  return lineage;
}

/** Each running thread and every live ancestor of it: the lineages that hold a running turn. */
export function lineageRoots(index: LinkIndex, running: Iterable<ThreadId>): ReadonlySet<ThreadId> {
  const roots = new Set<ThreadId>();
  for (const threadId of running) {
    let current: ThreadId | undefined = threadId;
    while (current !== undefined && !roots.has(current)) {
      roots.add(current);
      current = index.parents.get(current);
    }
  }
  return roots;
}

/**
 * Each thread's lineage totals, its own plus its subagent descendants', by adding every owning
 * thread into itself and each ancestor once. The cost follows the owning threads, not the links.
 */
export function lineageTotals(
  index: LinkIndex,
  own: ReadonlyMap<ThreadId, Totals>,
): Map<ThreadId, Totals> {
  const totals = new Map<ThreadId, Totals>();
  for (const [owner, ownTotals] of own) {
    const seen = new Set<ThreadId>();
    let current: ThreadId | undefined = owner;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      let entry = totals.get(current);
      if (entry === undefined) {
        entry = { cpuPercent: 0, memoryBytes: 0, processCount: 0 };
        totals.set(current, entry);
      }
      add(entry, ownTotals);
      current = index.parents.get(current);
    }
  }
  return totals;
}

const toTotals = (totals: Totals, sampleAgeMs: number): ThreadResourceTotals => ({
  cpuPercent: Math.round(totals.cpuPercent * 10) / 10,
  memoryBytes: Math.round(totals.memoryBytes),
  // The shared walk leaves per-process GPU use out; a live view's GPU columns carry it.
  gpuUtilPercent: null,
  vramBytes: null,
  processCount: totals.processCount,
  sampleAgeMs: Math.max(0, Math.round(sampleAgeMs)),
  source: "sample",
});

export interface ThreadResourcesShape {
  /** The thread's lineage totals from the latest shared sample, and its history. Never samples. */
  readonly read: (threadId: ThreadId) => Effect.Effect<ThreadResourcesResult>;
  /** The thread, then its `subagent` descendants on this environment; just the thread on a failed read. */
  readonly lineage: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<ThreadId>>;
  /** Each running thread's own totals from the latest shared sample. */
  readonly byThread: Effect.Effect<ReadonlyMap<ThreadId, ThreadResourceTotals>>;
}

/** Empty unless the server provides one, so RPC test layers need no stand-in. */
export class ThreadResources extends Context.Reference<ThreadResourcesShape>(
  "t3/resourceTelemetry/ThreadResources",
  {
    defaultValue: () => ({
      read: (threadId) => Effect.succeed({ current: null, history: [], threadIds: [threadId] }),
      lineage: (threadId) => Effect.succeed([threadId]),
      byThread: Effect.succeed(new Map()),
    }),
  },
) {}

interface Latest {
  readonly atMs: number;
  readonly links: LinkIndex;
  readonly running: ReadonlyArray<ThreadId>;
  readonly own: ReadonlyMap<ThreadId, Totals>;
  readonly lineage: ReadonlyMap<ThreadId, Totals>;
}

/** The aggregation, fed one attributed sample per `tick`; the layer feeds it the shared sampler. */
export const makeAggregator = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2.ProjectionStoreV2;
  const history = new ThreadResourceHistory();
  let latest: Latest | null = null;

  // Without links, each thread is its own lineage; without running ids, history pauses.
  const links = yield* Effect.cachedWithTTL(
    projections.listSubagentLinks().pipe(
      Effect.map(indexLinks),
      Effect.orElseSucceed(() => NO_LINKS),
    ),
    LINKS_TTL,
  );
  const running = yield* Effect.cachedWithTTL(
    projections.listRunningThreadIds().pipe(Effect.orElseSucceed(() => [])),
    RUNNING_TTL,
  );

  /** Archived and deleted threads lose their history; a failed read keeps it for the next window. */
  const forgetInactive = Effect.gen(function* () {
    const held = history.threadIds();
    const active = new Set(yield* projections.listActiveThreadIds(held));
    history.forget(held.filter((threadId) => !active.has(threadId)));
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not prune thread resource history", { cause: cause.message }),
    ),
  );

  // One aggregation per shared sample, whoever reads it; a span each would only add noise.
  const tick = Effect.fnUntraced(function* ({ sample, owners }: AttributedSample) {
    const index = yield* links;
    const runningIds = yield* running;
    const own = sumByThread(sample.sample, owners);
    const lineage = lineageTotals(index, own);
    const roots = lineageRoots(index, runningIds);
    const usage = new Map<ThreadId, Totals>();
    for (const root of roots) {
      const totals = lineage.get(root);
      if (totals !== undefined) usage.set(root, totals);
    }
    latest = {
      atMs: sample.sample.sampledAtUnixMs,
      links: index,
      running: runningIds,
      own,
      lineage,
    };
    if (history.record(sample.sample.sampledAtUnixMs, usage)) yield* forgetInactive;
  });

  const lineage: ThreadResourcesShape["lineage"] = (threadId) =>
    Effect.map(links, (index) => lineageOf(index, threadId));

  const read: ThreadResourcesShape["read"] = Effect.fn("ThreadResources.read")(
    function* (threadId) {
      const nowMs = yield* Clock.currentTimeMillis;
      const points = history.read(threadId, nowMs);
      const current = latest;
      if (current === null) {
        return { current: null, history: points, threadIds: yield* lineage(threadId) };
      }
      const totals = current.lineage.get(threadId);
      return {
        current: totals === undefined ? null : toTotals(totals, nowMs - current.atMs),
        history: points,
        threadIds: lineageOf(current.links, threadId),
      };
    },
  );

  const byThread: ThreadResourcesShape["byThread"] = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const result = new Map<ThreadId, ThreadResourceTotals>();
    const current = latest;
    if (current === null) return result;
    for (const threadId of current.running) {
      const totals = current.own.get(threadId);
      if (totals !== undefined) result.set(threadId, toTotals(totals, nowMs - current.atMs));
    }
    return result;
  });

  return { tick, service: { read, lineage, byThread } satisfies ThreadResourcesShape };
});

const make = Effect.gen(function* () {
  const sampler = yield* ResourceSampler;
  const { tick, service } = yield* makeAggregator;
  yield* sampler.samples.pipe(Stream.runForEach(tick), Effect.forkScoped);
  return service;
});

export const layer = Layer.effect(ThreadResources, make);
