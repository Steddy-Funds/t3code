import { it } from "@effect/vitest";
import {
  type Claim,
  ClaimId,
  type ProcessOwner,
  type ResourceMonitorProcessSample,
  THREAD_RESOURCE_HISTORY_POINTS,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  type ProcessRoot,
  ProcessOwnershipRegistry,
  type RegisteredRoot,
} from "@t3tools/shared/ProcessOwnershipRegistry";
import type { RootCgroup } from "@t3tools/shared/cgroup";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as ProjectionStoreV2 from "../orchestration-v2/ProjectionStore.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import { ProcessOwnership, type ResolvedClaim } from "./ProcessOwnership.ts";
import {
  appendPoint,
  boundRings,
  cpuPercentBetween,
  historyPoints,
  layerWith,
  measureUnits,
  parseCpuStatUsageUsec,
  parseProcStat,
  parseStatmResidentPages,
  planUnits,
  ThreadResources,
  type ThreadResourcesShape,
} from "./ThreadResources.ts";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const PAGE_SIZE = 4_096;

const registered = (
  id: number,
  root: ProcessRoot,
  cgroup: RootCgroup = root.cgroup === undefined
    ? { type: "none" }
    : { type: "adopted", cgroup: root.cgroup },
): RegisteredRoot => ({ id, root, registeredAtMs: 0, cgroup });

const resolvedClaim = (threadId: ThreadId, cgroup: string | undefined): ResolvedClaim => {
  const claim: Claim = {
    id: ClaimId.make(`claim-${threadId}-${cgroup ?? "none"}`),
    threadId,
    target: { type: "cgroup", path: cgroup ?? "/gone.slice" },
    createdAt: DateTime.makeUnsafe(0),
    createdBy: { type: "agent", threadId },
  };
  return cgroup === undefined ? { claim } : { claim, cgroup };
};

/** A `/proc/<pid>/stat` line: utime, stime and starttime at fields 11, 12 and 19 after `)`. */
const procStat = (pid: number, name: string, utime: number, stime: number, start: number) => {
  const fields = Array.from({ length: 30 }, (_, index) => String(index));
  fields[0] = "S";
  fields[11] = String(utime);
  fields[12] = String(stime);
  fields[19] = String(start);
  return `${pid} (${name}) ${fields.join(" ")}`;
};

const point = (atMs: number) => ({ atMs, cpuPercent: 1, memoryBytes: 2, gpuUtilPercent: null });

describe("planUnits", () => {
  const unit = (cgroup: string, threadId: ThreadId | null = threadA) => ({
    threadId,
    cgroup,
    split: false,
  });

  it("drops a unit equal to or inside an earlier one and keeps the first", () => {
    expect(
      planUnits([unit("/a.scope"), unit("/a.scope", threadB), unit("/a.scope/tool", threadB)]),
    ).toEqual([{ ...unit("/a.scope"), subtract: [] }]);
  });

  it("subtracts only the kept units directly inside, not their children or prefix siblings", () => {
    expect(
      planUnits([
        unit("/x/y/z"),
        unit("/x/y"),
        unit("/x/yy"),
        unit("/x", threadB),
        unit("/other", null),
      ]),
    ).toEqual([
      { ...unit("/x/y/z"), subtract: [] },
      { ...unit("/x/y"), subtract: ["/x/y/z"] },
      { ...unit("/x/yy"), subtract: [] },
      { ...unit("/x", threadB), subtract: ["/x/y", "/x/yy"] },
      { ...unit("/other", null), subtract: [] },
    ]);
  });
});

describe("measureUnits", () => {
  it("makes units of adopted roots in order, then claims whose cgroup resolved", () => {
    const roots = [
      registered(1, { cgroup: "/t.scope", owner: { type: "thread", threadId: threadA } }),
      registered(
        2,
        { pid: 7, cgroup: "/pending.scope", owner: { type: "thread", threadId: threadA } },
        { type: "pending" },
      ),
      registered(3, { pid: 8, owner: { type: "thread", threadId: threadB } }),
      registered(4, {
        cgroup: "/split.scope",
        splitByEnv: true,
        owner: { type: "shared", provider: "codex", label: "app-server" },
      }),
      registered(5, {
        cgroup: "/shared.scope",
        owner: { type: "shared", provider: "opencode", label: "serve" },
      }),
      registered(6, {
        cgroup: "/t3.scope",
        splitByEnv: true,
        owner: { type: "t3", label: "machine terminal" },
      }),
    ];
    const claims = [resolvedClaim(threadB, "/claim.slice"), resolvedClaim(threadA, undefined)];
    expect(measureUnits(roots, claims)).toEqual([
      { threadId: threadA, cgroup: "/t.scope", split: false },
      { threadId: null, cgroup: "/split.scope", split: true },
      { threadId: null, cgroup: "/shared.scope", split: false },
      { threadId: null, cgroup: "/t3.scope", split: false },
      { threadId: threadB, cgroup: "/claim.slice", split: false },
    ]);
  });
});

describe("parsers", () => {
  it("reads utime, stime and starttime after the last parenthesis", () => {
    expect(parseProcStat(procStat(42, "node", 300, 50, 9_000))).toEqual({
      cpuTicks: 350,
      startTicks: 9_000,
    });
    expect(parseProcStat(procStat(42, "we(ird) ) name", 7, 3, 123))).toEqual({
      cpuTicks: 10,
      startTicks: 123,
    });
  });

  it.each([
    "",
    "garbage",
    "42 (node) S 1 2 3",
    procStat(42, "node", 300, 50, 9_000).replace(" 9000 ", " x "),
  ])("returns undefined for a bad stat line %#", (contents) => {
    expect(parseProcStat(contents)).toBeUndefined();
  });

  it("reads usage_usec from cpu.stat and resident pages from statm", () => {
    expect(parseCpuStatUsageUsec("usage_usec 1234\nuser_usec 1000\nsystem_usec 234\n")).toBe(1_234);
    expect(parseCpuStatUsageUsec("user_usec 1000\n")).toBeUndefined();
    expect(parseCpuStatUsageUsec("")).toBeUndefined();
    expect(parseStatmResidentPages("1000 25 3 1 0 50 0\n")).toBe(25);
    expect(parseStatmResidentPages("1000")).toBeUndefined();
    expect(parseStatmResidentPages("1000 x")).toBeUndefined();
    expect(parseStatmResidentPages("")).toBeUndefined();
  });
});

describe("cpuPercentBetween", () => {
  it.each([
    { name: "no earlier reading", previous: undefined, cpuMs: 500, atMs: 10_000, expected: 0 },
    {
      name: "under a second apart",
      previous: { cpuMs: 0, atMs: 9_500 },
      cpuMs: 500,
      atMs: 10_000,
      expected: 0,
    },
    {
      name: "a counter that went back",
      previous: { cpuMs: 900, atMs: 0 },
      cpuMs: 500,
      atMs: 10_000,
      expected: 0,
    },
    {
      name: "two cores for ten seconds",
      previous: { cpuMs: 1_000, atMs: 0 },
      cpuMs: 21_000,
      atMs: 10_000,
      expected: 200,
    },
  ])("gives $expected% for $name", ({ previous, cpuMs, atMs, expected }) => {
    expect(cpuPercentBetween(previous, cpuMs, atMs)).toBe(expected);
  });
});

describe("history rings", () => {
  it("keeps the newest points", () => {
    let ring: Parameters<typeof appendPoint>[0] = [];
    for (let atMs = 0; atMs <= THREAD_RESOURCE_HISTORY_POINTS; atMs++) {
      ring = appendPoint(ring, point(atMs));
    }
    expect(ring).toHaveLength(THREAD_RESOURCE_HISTORY_POINTS);
    expect(ring[0]?.atMs).toBe(1);
    expect(ring.at(-1)?.atMs).toBe(THREAD_RESOURCE_HISTORY_POINTS);
  });

  it("keeps the 200 threads with the newest last point", () => {
    const ids = Array.from({ length: 201 }, (_, index) => ThreadId.make(`thread-${index}`));
    // Insertion order is not age order: the oldest thread sits in the middle.
    const rings = new Map(
      [...ids.slice(100), ...ids.slice(0, 100)].map((id) => [
        id,
        [point(0), point(Number(id.slice("thread-".length)) + 1)],
      ]),
    );
    const bounded = boundRings(rings);
    expect(bounded.size).toBe(200);
    expect(bounded.has(ThreadId.make("thread-0"))).toBe(false);
    expect(bounded.has(ThreadId.make("thread-200"))).toBe(true);

    const few = new Map([[threadA, [point(1)]]]);
    expect(boundRings(few)).toEqual(few);
    expect(boundRings(few)).not.toBe(few);
  });

  it("gives ages relative to now, never negative", () => {
    expect(historyPoints([point(4_000.4), point(12_000)], 10_000)).toEqual([
      { ageMs: 6_000, cpuPercent: 1, memoryBytes: 2, gpuUtilPercent: null },
      { ageMs: 0, cpuPercent: 1, memoryBytes: 2, gpuUtilPercent: null },
    ]);
  });
});

interface World {
  readonly files: Map<string, string>;
  roots: ReadonlyArray<RegisteredRoot>;
  claims: ReadonlyArray<ResolvedClaim>;
  running: ReadonlyArray<ThreadId> | "fail";
  sample: ReadonlyArray<ResourceMonitorProcessSample>;
  owners: ReadonlyMap<string, ProcessOwner>;
  readonly scheduled: Array<string>;
}

const world = (overrides: Partial<World> = {}): World => ({
  files: new Map(),
  roots: [],
  claims: [],
  running: [],
  sample: [],
  owners: new Map(),
  scheduled: [],
  ...overrides,
});

const cgroupFiles = (
  files: Map<string, string>,
  cgroup: string,
  {
    usageUsec,
    memory,
    procs,
  }: { usageUsec: number; memory?: number; procs: ReadonlyArray<number> },
) => {
  const directory = `/sys/fs/cgroup${cgroup}`;
  files.set(`${directory}/cpu.stat`, `usage_usec ${usageUsec}\nuser_usec 0\nsystem_usec 0\n`);
  files.set(`${directory}/cgroup.procs`, procs.map((pid) => `${pid}\n`).join(""));
  if (memory === undefined) files.delete(`${directory}/memory.current`);
  else files.set(`${directory}/memory.current`, `${memory}\n`);
};

const sampleRow = (
  pid: number,
  cpuTimeMs: number,
  residentBytes: number,
): ResourceMonitorProcessSample => ({
  pid,
  ppid: 1,
  startTimeMs: pid * 10,
  runTimeMs: 0,
  name: `p${pid}`,
  command: `p${pid}`,
  status: "running",
  cpuPercent: 0,
  cpuTimeMs,
  residentBytes,
  virtualBytes: 0,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  ioSemantics: "storage",
});

const threadRoot = (id: number, threadId: ThreadId, cgroup: string) =>
  registered(id, { cgroup, owner: { type: "thread", threadId } });

const makeService = (state: World, platform: "linux" | "darwin" = "linux") =>
  ThreadResources.pipe(
    Effect.provide(
      layerWith({
        readFile: (path) => state.files.get(path),
        readDirectories: (path) => [
          ...new Set(
            [...state.files.keys()].flatMap((file) => {
              if (!file.startsWith(`${path}/`)) return [];
              const rest = file.slice(path.length + 1).split("/");
              return rest.length > 1 ? [rest[0]!] : [];
            }),
          ),
        ],
        pageSize: PAGE_SIZE,
      }).pipe(
        Layer.provide(
          Layer.succeed(
            Scheduler.Scheduler,
            Scheduler.Scheduler.of({
              register: (name) => Effect.sync(() => void state.scheduled.push(name)),
            }),
          ),
        ),
        Layer.provide(
          NativeTelemetryClient.layerTest({
            sampleNow: Effect.sync(() => ({
              generation: 0,
              snapshot: {
                version: 4,
                type: "snapshot",
                sequence: 0,
                sampledAtUnixMs: 0,
                collectionDurationMicros: 0,
                scannedProcessCount: state.sample.length,
                retainedProcessCount: state.sample.length,
                inaccessibleProcessCount: 0,
                processes: state.sample,
              },
            })),
          }),
        ),
        Layer.provide(
          Layer.succeed(ProjectionStoreV2.ProjectionStoreV2, {
            listRunningThreadIds: () =>
              state.running === "fail"
                ? Effect.fail(new ProjectionStoreV2.ProjectionStoreReadError({ threadId: threadA }))
                : Effect.succeed(state.running),
          } as unknown as ProjectionStoreV2.ProjectionStoreV2["Service"]),
        ),
      ),
    ),
    Effect.provideService(ProcessOwnershipRegistry, {
      registerRoot: () => () => {},
      roots: () => state.roots,
    }),
    Effect.provideService(ProcessOwnership, {
      ...ProcessOwnership.defaultValue(),
      resolvedClaims: Effect.sync(() => state.claims),
      attribute: () => Effect.sync(() => state.owners),
    }),
    Effect.provideService(HostProcess.Platform, platform),
  );

/** Calls `rollup` on every 5 s Scheduler tick from now through `seconds`. */
const tick = (service: ThreadResourcesShape, seconds: number) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed <= seconds; elapsed += 5) {
      if (elapsed > 0) yield* TestClock.adjust("5 seconds");
      yield* service.rollup;
    }
  });

const gaps = (history: ReadonlyArray<{ readonly ageMs: number }>) =>
  history.slice(1).map((entry, index) => history[index]!.ageMs - entry.ageMs);

describe("ThreadResources measuring", () => {
  it.effect("counts a claim's processes once, whether nested in a root or around one", () =>
    Effect.gen(function* () {
      const state = world({
        running: [threadA, threadB],
        roots: [threadRoot(1, threadA, "/outer.slice/a.scope")],
        claims: [
          resolvedClaim(threadA, "/outer.slice/a.scope/tool"),
          resolvedClaim(threadB, "/outer.slice"),
        ],
      });
      const files = (usage: { inner: number; outer: number; tool: number }) => {
        cgroupFiles(state.files, "/outer.slice/a.scope", {
          usageUsec: usage.inner,
          memory: 1_000,
          procs: [11, 12],
        });
        cgroupFiles(state.files, "/outer.slice/a.scope/tool", {
          usageUsec: usage.tool,
          memory: 400,
          procs: [13],
        });
        cgroupFiles(state.files, "/outer.slice", {
          usageUsec: usage.outer,
          memory: 5_000,
          procs: [20],
        });
      };
      files({ inner: 0, outer: 0, tool: 0 });
      const service = yield* makeService(state);
      expect(state.scheduled).toEqual(["thread-resources"]);

      yield* service.rollup;
      yield* TestClock.adjust("30 seconds");
      // 3 s of CPU in the root over 30 s is 10%; the outer claim's 9 s holds those 3 s.
      files({ inner: 3_000_000, outer: 9_000_000, tool: 1_000_000 });
      yield* service.rollup;

      const byThread = yield* service.byThread;
      expect(byThread.get(threadA)).toEqual({
        cpuPercent: 10,
        memoryBytes: 1_000,
        gpuUtilPercent: null,
        vramBytes: null,
        // 11 and 12 in the root, 13 in the claim nested inside it.
        processCount: 3,
        sampleAgeMs: 0,
        source: "cgroup",
      });
      expect(byThread.get(threadB)).toMatchObject({
        cpuPercent: 20,
        memoryBytes: 4_000,
        processCount: 1,
        source: "cgroup",
      });
    }),
  );

  it.effect("moves a process claim out of another thread's claimed cgroup", () =>
    Effect.gen(function* () {
      const box = resolvedClaim(threadB, "/box.slice");
      const tool: ResolvedClaim = {
        claim: {
          id: ClaimId.make("claim-tool"),
          threadId: threadA,
          target: { type: "process", pid: 402, startTimeMs: 4_020 },
          createdAt: DateTime.makeUnsafe(0),
          createdBy: { type: "agent", threadId: threadA },
        },
      };
      const state = world({
        claims: [box, tool],
        sample: [sampleRow(401, 0, 1_000), sampleRow(402, 0, 2_000)],
        owners: new Map<string, ProcessOwner>([
          ["401:4010", { type: "claimed", claimId: box.claim.id, threadId: threadB }],
          ["402:4020", { type: "claimed", claimId: tool.claim.id, threadId: threadA }],
        ]),
      });
      cgroupFiles(state.files, "/box.slice", { usageUsec: 0, memory: 5_000, procs: [401, 402] });
      state.files.set("/proc/401/cgroup", "0::/box.slice\n");
      state.files.set("/proc/402/cgroup", "0::/box.slice\n");
      const service = yield* makeService(state);

      // Attribution gives 402 to the process claim's thread, so the rollup does too.
      expect((yield* service.read(threadB)).current).toMatchObject({
        memoryBytes: 3_000,
        processCount: 1,
      });
      expect((yield* service.read(threadA)).current).toMatchObject({
        memoryBytes: 2_000,
        processCount: 1,
        source: "sample",
      });
    }),
  );

  it.effect("sends each member of a split shared root to the thread in its environment", () =>
    Effect.gen(function* () {
      const state = world({
        running: [threadA, threadB],
        roots: [
          registered(1, {
            cgroup: "/codex.scope",
            splitByEnv: true,
            owner: { type: "shared", provider: "codex", label: "app-server" },
          }),
        ],
      });
      cgroupFiles(state.files, "/codex.scope", {
        usageUsec: 0,
        memory: 99_999,
        procs: [101, 102, 103],
      });
      const members = (ticks: number) => {
        state.files.set("/proc/101/stat", procStat(101, "codex (a)", ticks, 0, 5));
        state.files.set("/proc/102/stat", procStat(102, "node", ticks * 2, 0, 6));
        state.files.set("/proc/103/stat", procStat(103, "app-server", ticks, 0, 7));
      };
      members(0);
      state.files.set("/proc/101/environ", "PATH=/bin\0T3CODE_THREAD_ID=thread-a\0");
      state.files.set("/proc/102/environ", "T3CODE_THREAD_ID=thread-b\0HOME=/h\0");
      state.files.set("/proc/103/environ", "PATH=/bin\0");
      state.files.set("/proc/101/statm", "500 10 0 0 0 0 0");
      state.files.set("/proc/102/statm", "500 20 0 0 0 0 0");
      state.files.set("/proc/103/statm", "500 40 0 0 0 0 0");
      const service = yield* makeService(state);

      yield* service.rollup;
      yield* TestClock.adjust("30 seconds");
      members(300);
      yield* service.rollup;

      const byThread = yield* service.byThread;
      expect(byThread.get(threadA)).toMatchObject({
        cpuPercent: 10,
        memoryBytes: 10 * PAGE_SIZE,
        processCount: 1,
        source: "cgroup",
      });
      expect(byThread.get(threadB)).toMatchObject({
        cpuPercent: 20,
        memoryBytes: 20 * PAGE_SIZE,
        processCount: 1,
        source: "cgroup",
      });
    }),
  );

  it.effect("sums the members' resident pages when memory.current is missing", () =>
    Effect.gen(function* () {
      const state = world({ running: [threadA], roots: [threadRoot(1, threadA, "/a.scope")] });
      cgroupFiles(state.files, "/a.scope", { usageUsec: 0, procs: [201, 202] });
      state.files.set("/proc/201/statm", "900 25 0 0 0 0 0");
      state.files.set("/proc/202/statm", "900 75 0 0 0 0 0");
      const service = yield* makeService(state);

      const { current } = yield* service.read(threadA);
      expect(current).toMatchObject({
        // A first reading has nothing to compare against.
        cpuPercent: null,
        memoryBytes: 100 * PAGE_SIZE,
        processCount: 2,
        source: "cgroup",
      });
    }),
  );

  it.effect.each([
    { platform: "linux" as const, processCount: 2, memoryBytes: 1_000 + 30, source: "cgroup" },
    { platform: "darwin" as const, processCount: 2, memoryBytes: 20 + 30, source: "sample" },
  ])(
    "on $platform, counts sampled rows outside every measured cgroup",
    ({ platform, processCount, memoryBytes, source }) =>
      Effect.gen(function* () {
        const owner: ProcessOwner = { type: "thread", threadId: threadA };
        const state = world({
          running: [threadA],
          roots: [
            threadRoot(1, threadA, "/a.scope"),
            registered(2, { pid: 302, owner: { type: "thread", threadId: threadA } }),
          ],
          sample: [sampleRow(301, 0, 20), sampleRow(302, 0, 30)],
          owners: new Map([
            ["301:3010", owner],
            ["302:3020", owner],
          ]),
        });
        cgroupFiles(state.files, "/a.scope", { usageUsec: 0, memory: 1_000, procs: [301] });
        state.files.set("/proc/301/cgroup", "0::/a.scope\n");
        state.files.set("/proc/302/cgroup", "0::/user.slice/term.scope\n");
        const service = yield* makeService(state, platform);

        const { current } = yield* service.read(threadA);
        expect(current).toMatchObject({ processCount, memoryBytes, source });
      }),
  );
});

describe("ThreadResources rollups", () => {
  it.effect("adds no points while nothing runs, and rolls up as soon as a turn starts", () =>
    Effect.gen(function* () {
      const state = world({ roots: [threadRoot(1, threadA, "/a.scope")] });
      cgroupFiles(state.files, "/a.scope", { usageUsec: 0, memory: 1_000, procs: [1] });
      const service = yield* makeService(state);

      yield* tick(service, 60);
      expect((yield* service.read(threadA)).history).toEqual([]);
      expect((yield* service.byThread).size).toBe(0);

      state.running = [threadA];
      yield* TestClock.adjust("5 seconds");
      yield* service.rollup;
      expect((yield* service.read(threadA)).history).toHaveLength(1);
    }),
  );

  it.effect("adds one point per 30 s for running threads only", () =>
    Effect.gen(function* () {
      const state = world({
        running: [threadA],
        roots: [threadRoot(1, threadA, "/a.scope"), threadRoot(2, threadB, "/b.scope")],
      });
      cgroupFiles(state.files, "/a.scope", { usageUsec: 0, memory: 1_000, procs: [1] });
      cgroupFiles(state.files, "/b.scope", { usageUsec: 0, memory: 2_000, procs: [2] });
      const service = yield* makeService(state);

      yield* tick(service, 65);
      const { history } = yield* service.read(threadA);
      expect(history.map((entry) => entry.ageMs)).toEqual([65_000, 35_000, 5_000]);
      expect([...(yield* service.byThread).keys()]).toEqual([threadA]);
      expect((yield* service.read(threadB)).history).toEqual([]);
    }),
  );

  it.effect("logs a failed rollup without failing the tick, and retries on the next one", () =>
    Effect.gen(function* () {
      const state = world({ running: "fail", roots: [threadRoot(1, threadA, "/a.scope")] });
      cgroupFiles(state.files, "/a.scope", { usageUsec: 0, memory: 1_000, procs: [1] });
      const service = yield* makeService(state);

      expect(yield* Effect.exit(service.rollup)).toEqual(Exit.void);
      state.running = [threadA];
      yield* TestClock.adjust("5 seconds");
      yield* service.rollup;
      expect((yield* service.read(threadA)).history).toHaveLength(1);
    }),
  );
});

describe("ThreadResources.read", () => {
  it.effect(
    "returns the rollup's totals for 40 s, then measures on demand without adding history",
    () =>
      Effect.gen(function* () {
        const state = world({ running: [threadA], roots: [threadRoot(1, threadA, "/a.scope")] });
        cgroupFiles(state.files, "/a.scope", { usageUsec: 0, memory: 1_000, procs: [1] });
        const service = yield* makeService(state);
        yield* service.rollup;
        state.running = [];
        cgroupFiles(state.files, "/a.scope", { usageUsec: 0, memory: 9_000, procs: [1, 2] });

        yield* TestClock.adjust("40 seconds");
        const fresh = yield* service.read(threadA);
        expect(fresh.current).toMatchObject({
          memoryBytes: 1_000,
          processCount: 1,
          sampleAgeMs: 40_000,
        });

        yield* TestClock.adjust("1 millis");
        const measured = yield* service.read(threadA);
        // The only earlier CPU reading is the rollup's, 40 s old: not current.
        expect(measured.current).toMatchObject({
          cpuPercent: null,
          memoryBytes: 9_000,
          processCount: 2,
          sampleAgeMs: 0,
        });
        expect(measured.history).toHaveLength(1);
        expect(measured.history[0]?.cpuPercent).toBe(0);

        // 0.5 s of CPU over the 5 s since the last read is 10%.
        yield* TestClock.adjust("5 seconds");
        cgroupFiles(state.files, "/a.scope", { usageUsec: 500_000, memory: 9_000, procs: [1, 2] });
        expect((yield* service.read(threadA)).current?.cpuPercent).toBe(10);
      }),
  );

  it.effect("returns null with no history for a thread nothing belongs to", () =>
    Effect.gen(function* () {
      const service = yield* makeService(world());
      expect(yield* service.read(threadA)).toEqual({ current: null, history: [] });
    }),
  );

  it.effect("leaves a real gap, with no filler points, between runs", () =>
    Effect.gen(function* () {
      const state = world({ running: [threadA], roots: [threadRoot(1, threadA, "/a.scope")] });
      cgroupFiles(state.files, "/a.scope", { usageUsec: 0, memory: 1_000, procs: [1] });
      const service = yield* makeService(state);

      yield* tick(service, 30);
      state.running = [];
      yield* TestClock.adjust("5 seconds");
      yield* tick(service, 90);
      state.running = [threadA];
      yield* TestClock.adjust("5 seconds");
      yield* tick(service, 30);

      const { history } = yield* service.read(threadA);
      expect(gaps(history)).toEqual([30_000, 100_000, 30_000]);
    }),
  );
});
