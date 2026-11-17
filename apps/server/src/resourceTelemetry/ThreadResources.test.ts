import { it } from "@effect/vitest";
import { ClaimId, type ProcessOwner, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import type * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import type { AttributedSample } from "./ResourceSampler.ts";
import {
  indexLinks,
  lineageOf,
  lineageRoots,
  lineageTotals,
  makeAggregator,
  sumByThread,
} from "./ThreadResources.ts";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const parent = ThreadId.make("parent");
const child = ThreadId.make("child");
const grandchild = ThreadId.make("grandchild");
const sibling = ThreadId.make("sibling");
const fork = ThreadId.make("fork");
const unrelated = ThreadId.make("unrelated");
const link = (threadId: ThreadId, parentThreadId: ThreadId) => ({ threadId, parentThreadId });
/** As the store reads it: a fork is no link, so it tops its own tree. */
const family = [link(child, parent), link(sibling, parent), link(grandchild, child)];

interface Row {
  readonly pid: number;
  readonly cpu?: number;
  readonly rss: number;
  readonly owner?: ProcessOwner;
}

const owned = (threadId: ThreadId): ProcessOwner => ({ type: "thread", threadId });

/** A host sample at the TestClock's time, with an owner for each row that has one. */
const sampleOf = (atMs: number, rows: ReadonlyArray<Row>): AttributedSample => {
  const sample: NativeTelemetryClient.NativeHostSample = {
    generation: 0,
    statics: new Map(),
    sample: {
      version: 4,
      type: "hostSample",
      sequence: 0,
      sampledAtUnixMs: atMs,
      collectionDurationMicros: 1,
      scannedProcessCount: rows.length,
      inaccessibleProcessCount: 0,
      staticReset: false,
      processes: {
        pid: rows.map((row) => row.pid),
        ppid: rows.map(() => 1),
        startTimeMs: rows.map((row) => row.pid * 10),
        cpuPercent: rows.map((row) => row.cpu ?? 0),
        residentBytes: rows.map((row) => row.rss),
      },
    },
  };
  const owners = new Map(
    rows.flatMap((row) =>
      row.owner === undefined ? [] : [[`${row.pid}:${row.pid * 10}`, row.owner]],
    ),
  );
  return { sample, owners: owners as Map<string, ProcessOwner>, claims: [] };
};

interface Store {
  running: ReadonlyArray<ThreadId>;
  links: ReadonlyArray<ProjectionStoreV2.SubagentLink> | "fail";
  /** Threads `listActiveThreadIds` drops; "fail" fails the read. */
  inactive: ReadonlySet<ThreadId> | "fail";
}

const readError = () => new ProjectionStoreV2.ProjectionStoreReadError({ threadId: threadA });

const makeService = (store: Store) =>
  makeAggregator.pipe(
    Effect.provideService(ProjectionStoreV2.ProjectionStoreV2, {
      listRunningThreadIds: () => Effect.sync(() => store.running),
      listSubagentLinks: () =>
        Effect.suspend(() =>
          store.links === "fail" ? Effect.fail(readError()) : Effect.succeed(store.links),
        ),
      listActiveThreadIds: (threadIds: ReadonlyArray<ThreadId>) =>
        Effect.suspend(() => {
          const inactive = store.inactive;
          return inactive === "fail"
            ? Effect.fail(readError())
            : Effect.succeed(threadIds.filter((threadId) => !inactive.has(threadId)));
        }),
    } as unknown as ProjectionStoreV2.ProjectionStoreV2["Service"]),
  );

const store = (overrides: Partial<Store> = {}): Store => ({
  running: [],
  links: [],
  inactive: new Set(),
  ...overrides,
});

/** One shared sample every 5 s from now through `seconds`, the rows read fresh each time. */
const ticks = (
  tick: (sample: AttributedSample) => Effect.Effect<void>,
  seconds: number,
  rows: () => ReadonlyArray<Row>,
) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed <= seconds; elapsed += 5) {
      if (elapsed > 0) yield* TestClock.adjust("5 seconds");
      yield* tick(sampleOf(yield* Clock.currentTimeMillis, rows()));
    }
  });

const gaps = (history: ReadonlyArray<{ readonly ageMs: number }>) =>
  history.slice(1).map((entry, index) => history[index]!.ageMs - entry.ageMs);

describe("sumByThread", () => {
  it("counts each process once, toward its owner's thread, claims included", () => {
    const { sample, owners } = sampleOf(0, [
      { pid: 1, cpu: 10, rss: 100, owner: owned(threadA) },
      {
        pid: 2,
        cpu: 5,
        rss: 50,
        owner: { type: "claimed", claimId: ClaimId.make("c1"), threadId: threadA },
      },
      { pid: 3, cpu: 1, rss: 7, owner: owned(threadB) },
      { pid: 4, cpu: 99, rss: 999, owner: { type: "t3", label: "server" } },
      { pid: 5, cpu: 99, rss: 999 },
    ]);
    expect(sumByThread(sample.sample, owners)).toEqual(
      new Map([
        [threadA, { cpuPercent: 15, memoryBytes: 150, processCount: 2 }],
        [threadB, { cpuPercent: 1, memoryBytes: 7, processCount: 1 }],
      ]),
    );
  });
});

describe("lineage", () => {
  const index = indexLinks(family);

  it("lists a thread then its subagent descendants breadth first", () => {
    expect(lineageOf(index, parent)).toEqual([parent, child, sibling, grandchild]);
    expect(lineageOf(index, child)).toEqual([child, grandchild]);
    expect(lineageOf(index, fork)).toEqual([fork]);
    expect(lineageOf(indexLinks([]), parent)).toEqual([parent]);
  });

  it("roots a lineage at each running thread and every live ancestor of it", () => {
    expect([...lineageRoots(index, [grandchild])].toSorted()).toEqual(
      [child, grandchild, parent].toSorted(),
    );
    expect([...lineageRoots(index, [fork, sibling])].toSorted()).toEqual(
      [fork, parent, sibling].toSorted(),
    );
    // A deleted parent has no links, so the walk stops below it.
    expect([...lineageRoots(indexLinks([]), [child])]).toEqual([child]);
  });

  it("adds each owning thread into itself and every ancestor once", () => {
    const own = new Map([
      [parent, { cpuPercent: 1, memoryBytes: 1_000, processCount: 1 }],
      [grandchild, { cpuPercent: 2, memoryBytes: 30, processCount: 1 }],
      [sibling, { cpuPercent: 4, memoryBytes: 4, processCount: 2 }],
    ]);
    const totals = lineageTotals(index, own);
    expect(totals.get(parent)).toEqual({ cpuPercent: 7, memoryBytes: 1_034, processCount: 4 });
    expect(totals.get(child)).toEqual({ cpuPercent: 2, memoryBytes: 30, processCount: 1 });
    expect(totals.has(fork)).toBe(false);
  });

  it("ends every walk on a subagent cycle, counting each thread once", () => {
    const loopA = ThreadId.make("loop-a");
    const loopB = ThreadId.make("loop-b");
    const loop = indexLinks([link(loopA, loopB), link(loopB, loopA)]);
    expect(lineageOf(loop, loopA)).toEqual([loopA, loopB]);
    expect([...lineageRoots(loop, [loopA])].toSorted()).toEqual([loopA, loopB].toSorted());
    const totals = lineageTotals(
      loop,
      new Map([[loopA, { cpuPercent: 1, memoryBytes: 1, processCount: 1 }]]),
    );
    expect(totals.get(loopB)).toEqual({ cpuPercent: 1, memoryBytes: 1, processCount: 1 });
  });
});

describe("ThreadResources.read", () => {
  it.effect(
    "returns null with no history before any sample and for a thread nothing belongs to",
    () =>
      Effect.gen(function* () {
        const { tick, service } = yield* makeService(store());
        expect(yield* service.read(threadA)).toEqual({
          current: null,
          history: [],
          threadIds: [threadA],
        });
        yield* tick(sampleOf(0, [{ pid: 1, rss: 5, owner: owned(threadB) }]));
        expect((yield* service.read(threadA)).current).toBeNull();
      }),
  );

  it.effect(
    "serves the latest shared sample's lineage totals, with its age, and never samples",
    () =>
      Effect.gen(function* () {
        const { tick, service } = yield* makeService(store({ links: family }));
        yield* tick(
          sampleOf(0, [
            { pid: 1, cpu: 10, rss: 1_000, owner: owned(parent) },
            { pid: 2, cpu: 2.25, rss: 200, owner: owned(child) },
            { pid: 3, cpu: 0.5, rss: 30, owner: owned(grandchild) },
            { pid: 4, rss: 4, owner: owned(sibling) },
            { pid: 5, rss: 70_000, owner: owned(fork) },
            { pid: 6, rss: 80_000, owner: owned(unrelated) },
          ]),
        );
        yield* TestClock.adjust("3 seconds");

        const read = yield* service.read(parent);
        expect(read.threadIds).toEqual([parent, child, sibling, grandchild]);
        expect(read.current).toEqual({
          cpuPercent: 12.8,
          memoryBytes: 1_234,
          gpuUtilPercent: null,
          vramBytes: null,
          processCount: 4,
          sampleAgeMs: 3_000,
          source: "sample",
        });
        const fromChild = yield* service.read(child);
        expect(fromChild.threadIds).toEqual([child, grandchild]);
        expect(fromChild.current).toMatchObject({ memoryBytes: 230, processCount: 2 });
        // Nothing ran, so nothing has history.
        expect(read.history).toEqual([]);
      }),
  );

  it.effect("keeps byThread to running threads' own totals", () =>
    Effect.gen(function* () {
      const { tick, service } = yield* makeService(store({ links: family, running: [grandchild] }));
      yield* tick(
        sampleOf(0, [
          { pid: 1, rss: 1_000, owner: owned(parent) },
          { pid: 3, cpu: 3, rss: 30, owner: owned(grandchild) },
        ]),
      );
      const byThread = yield* service.byThread;
      expect([...byThread.keys()]).toEqual([grandchild]);
      expect(byThread.get(grandchild)).toMatchObject({
        cpuPercent: 3,
        memoryBytes: 30,
        processCount: 1,
      });
    }),
  );

  it.effect("reads each thread alone when the links read fails", () =>
    Effect.gen(function* () {
      const { tick, service } = yield* makeService(store({ links: "fail", running: [threadA] }));
      expect(yield* service.lineage(threadA)).toEqual([threadA]);
      yield* tick(sampleOf(0, [{ pid: 1, rss: 1_000, owner: owned(threadA) }]));
      const read = yield* service.read(threadA);
      expect(read.threadIds).toEqual([threadA]);
      expect(read.current).toMatchObject({ memoryBytes: 1_000, processCount: 1 });
    }),
  );
});

describe("ThreadResources history", () => {
  it.effect("adds one point per 30 s for running lineages only, averaging the window's CPU", () =>
    Effect.gen(function* () {
      const state = store({ links: family, running: [child] });
      const { tick, service } = yield* makeService(state);
      let busy = true;
      yield* ticks(tick, 65, () => {
        // The child alternates 12% and 0%, so each window of six ticks averages near 6%.
        busy = !busy;
        return [
          { pid: 1, rss: 1_000, owner: owned(parent) },
          { pid: 2, cpu: busy ? 12 : 0, rss: 200, owner: owned(child) },
          { pid: 4, rss: 4, owner: owned(sibling) },
          { pid: 6, rss: 6, owner: owned(unrelated) },
        ];
      });

      const { history } = yield* service.read(parent);
      expect(history.map((point) => point.ageMs)).toEqual([35_000, 5_000]);
      expect(history.map((point) => point.memoryBytes)).toEqual([1_204, 1_204]);
      expect(history[1]?.cpuPercent).toBe(6);
      expect((yield* service.read(child)).history).toHaveLength(2);
      // Not running and not above a running thread.
      expect((yield* service.read(sibling)).history).toEqual([]);
      expect((yield* service.read(unrelated)).history).toEqual([]);
    }),
  );

  it.effect("leaves a real gap, with no filler points, while nothing runs", () =>
    Effect.gen(function* () {
      const state = store({ running: [threadA] });
      const { tick, service } = yield* makeService(state);
      const rows = () => [{ pid: 1, rss: 1_000, owner: owned(threadA) }];

      yield* ticks(tick, 60, rows);
      state.running = [];
      yield* TestClock.adjust("5 seconds");
      yield* ticks(tick, 90, rows);
      state.running = [threadA];
      yield* TestClock.adjust("5 seconds");
      yield* ticks(tick, 60, rows);

      const { history } = yield* service.read(threadA);
      // Points at 30 s and 60 s, none for the idle windows, then 180 s and 210 s.
      expect(gaps(history)).toEqual([30_000, 120_000, 30_000]);
    }),
  );

  it.effect("keeps a deleted child's share in the parent's earlier points", () =>
    Effect.gen(function* () {
      const state = store({ links: [link(child, parent)], running: [child] });
      const { tick, service } = yield* makeService(state);
      let rows: ReadonlyArray<Row> = [
        { pid: 1, rss: 1_000, owner: owned(parent) },
        { pid: 2, rss: 300, owner: owned(child) },
      ];
      yield* ticks(tick, 30, () => rows);

      // The child is deleted: gone from the links, its processes with it.
      state.links = [];
      state.running = [parent];
      state.inactive = new Set([child]);
      rows = [{ pid: 1, rss: 1_000, owner: owned(parent) }];
      // Links are cached for 30 s; past that, the parent stands alone.
      yield* TestClock.adjust("30 seconds");
      yield* ticks(tick, 30, () => rows);

      const { history } = yield* service.read(parent);
      expect(history.map((point) => point.memoryBytes)).toEqual([1_300, 1_000, 1_000]);
      expect((yield* service.read(child)).history).toEqual([]);
    }),
  );

  it.effect("drops archived and deleted threads' history when a window closes", () =>
    Effect.gen(function* () {
      const state = store({ running: [threadA, threadB], inactive: "fail" });
      const { tick, service } = yield* makeService(state);
      const rows = () => [
        { pid: 1, rss: 1, owner: owned(threadA) },
        { pid: 2, rss: 2, owner: owned(threadB) },
      ];
      // A failed read keeps everything for the next window.
      yield* ticks(tick, 30, rows);
      expect((yield* service.read(threadB)).history).toHaveLength(1);

      state.inactive = new Set([threadB]);
      yield* TestClock.adjust("5 seconds");
      yield* ticks(tick, 25, rows);
      expect((yield* service.read(threadA)).history).toHaveLength(2);
      expect((yield* service.read(threadB)).history).toEqual([]);
    }),
  );
});
