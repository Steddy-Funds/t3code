import type { GpuDeviceSample, MachineHistory, MachineStatusSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SeriesRing } from "../charts/SeriesRing";
import {
  createMachineSeries,
  GPU_COLUMN,
  gpuReadings,
  hasReadableGpu,
  MEMORY_COLUMN,
  memorySegments,
  poolCellBytes,
  receiveMachineSnapshot,
  setMemoryOwners,
  snapshotCores,
} from "./machineSeries";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const T = 10_000_000;

type Totals = NonNullable<MachineStatusSnapshot["totals"]>;

const totals = (overrides: Partial<Totals> = {}): Totals => ({
  cpuUtilization: 0.25,
  cpuCount: 4,
  load: { one: 2, five: 2, fifteen: 2 },
  memoryTotalBytes: 64 * GIB,
  memoryAvailableBytes: 16 * GIB,
  swapTotalBytes: 8 * GIB,
  swapUsedBytes: 2 * GIB,
  memoryPressure: null,
  ...overrides,
});

const gpu = (overrides: Partial<GpuDeviceSample> = {}): GpuDeviceSample => ({
  id: "gpu-0",
  vendor: "nvidia",
  name: "RTX 4090",
  status: "active",
  utilPercent: 40,
  vramTotalBytes: 24 * GIB,
  vramUsedBytes: 6 * GIB,
  sharedMemory: false,
  ...overrides,
});

/** `count` ticks of 5 s ending at the snapshot; every series holds its index as permille. */
const history = (count: number, overrides: Partial<MachineHistory> = {}): MachineHistory => {
  const ramp = Array.from({ length: count }, (_, index) => index % 1001);
  return {
    stepMs: 5_000,
    count,
    endAgeMs: 0,
    cpu: ramp,
    perCore: Array.from({ length: count * 2 }, (_, index) => Math.floor(index / 2) % 1001),
    cores: 2,
    memoryUsed: ramp,
    swapUsed: ramp,
    load1: Array.from({ length: count }, () => 2),
    gpus: [],
    ...overrides,
  };
};

const snapshot = (overrides: Partial<MachineStatusSnapshot> = {}): MachineStatusSnapshot => ({
  sequence: 1,
  verdict: "ok",
  verdictAgeMs: 0,
  reason: null,
  sampleAgeMs: 0,
  totals: totals(),
  sample: { perCore: [10, 20] },
  ...overrides,
});

const withoutSample = (value: MachineStatusSnapshot): MachineStatusSnapshot => {
  const { sample: _sample, ...rest } = value;
  return rest;
};

const column = (ring: SeriesRing, index = 0) =>
  Array.from({ length: ring.length }, (_, row) => ring.valueAt(index, row));
const newest = (ring: SeriesRing) =>
  Array.from({ length: ring.columns }, (_, index) => ring.latest(index));

describe("createMachineSeries", () => {
  it.each([
    ["1 h at 1 s", 1_000, 3_600_000, 3_600],
    ["15 min at 5 s", 5_000, 900_000, 180],
    ["15 min at 500 ms", 500, 900_000, 1_800],
  ])("holds range/tick points per graph, %s", (_name, tickMs, rangeMs, capacity) => {
    const series = createMachineSeries(tickMs, rangeMs, 8);
    expect(series).toMatchObject({ tickMs, rangeMs });
    for (const ring of [series.cpu, series.memory, series.load, series.gpu]) {
      expect(ring.capacity).toBe(capacity);
    }
    expect(series.memory.columns).toBe(2);
    expect(series.gpu.columns).toBe(2);
    expect(series.cores).toMatchObject({ columns: 8, capacity: 120 });
  });

  it("keeps one core column for a machine reporting none", () => {
    expect(createMachineSeries(1_000, 900_000, 0).cores.columns).toBe(1);
  });
});

describe("receiveMachineSnapshot", () => {
  it.each([
    ["15 min at 1 s", 900_000, 180, 896],
    ["1 h at 1 s", 3_600_000, 720, 3_596],
  ])("seeds every graph from history onto the tick, %s", (_name, rangeMs, points, expected) => {
    const series = createMachineSeries(1_000, rangeMs, 2);
    receiveMachineSnapshot(series, snapshot({ history: history(points) }), T);

    for (const ring of [series.cpu, series.memory, series.load, series.gpu]) {
      expect(ring.length).toBe(expected);
      // The live sample at T is the history's newest tick, so it isn't added again.
      expect(ring.timeAt(ring.length - 1)).toBe(T);
      expect(ring.timeAt(1) - ring.timeAt(0)).toBe(1_000);
    }
    expect(series.cores.length).toBe(120);
  });

  it("seeds cpu, memory and swap, load per core, peak GPU and cores from the history", () => {
    const series = createMachineSeries(5_000, 900_000, 2);
    receiveMachineSnapshot(
      series,
      snapshot({
        history: history(2, {
          cpu: [100, 500],
          memoryUsed: [200, 600],
          swapUsed: [-1, 50],
          load1: [2, 6],
          perCore: [100, 200, 300, 400],
          gpus: [
            { id: "a", util: [100, -1], vramUsed: [500, 250] },
            { id: "b", util: [300, 200], vramUsed: [-1, 750] },
          ],
        }),
        totals: null,
      }),
      T,
    );

    expect(column(series.cpu)).toEqual([10, 50]);
    expect(column(series.memory, MEMORY_COLUMN.used)).toEqual([20, 60]);
    expect(column(series.memory, MEMORY_COLUMN.swap)).toEqual([Number.NaN, 5]);
    expect(column(series.load)).toEqual([1, 3]);
    expect(column(series.gpu, GPU_COLUMN.util)).toEqual([30, 20]);
    expect(column(series.gpu, GPU_COLUMN.vram)).toEqual([50, 75]);
    expect([column(series.cores, 0), column(series.cores, 1)]).toEqual([
      [10, 30],
      [20, 40],
    ]);
    expect(series.cpu.timeAt(0)).toBe(T - 5_000);
  });

  it("ends the seed at endAtMs", () => {
    const series = createMachineSeries(1_000, 900_000, 2);
    receiveMachineSnapshot(
      series,
      snapshot({ history: history(3, { endAgeMs: 2_500 }), totals: null }),
      T,
    );
    expect(series.cpu.timeAt(series.cpu.length - 1)).toBe(T - 2_500);
  });

  it("seeds Windows load, with no load average, as NaN", () => {
    const series = createMachineSeries(5_000, 900_000, 2);
    receiveMachineSnapshot(
      series,
      snapshot({ history: history(2, { load1: [-1, -1] }), totals: null }),
      T,
    );
    expect(column(series.load)).toEqual([Number.NaN, Number.NaN]);
  });

  it("appends one row per later snapshot at its sample time", () => {
    const series = createMachineSeries(1_000, 900_000, 2);
    const seed = history(3);
    receiveMachineSnapshot(series, snapshot({ history: seed }), T);
    const seeded = series.cpu.length;

    // A shared stream repeats the same history object on every snapshot; it seeds only once.
    receiveMachineSnapshot(
      series,
      snapshot({ history: seed, sampleAgeMs: 400, sample: { perCore: [70, 80], gpus: [gpu()] } }),
      T + 1_400,
    );

    for (const ring of [series.cpu, series.memory, series.load, series.gpu]) {
      expect(ring.length).toBe(seeded + 1);
      expect(ring.timeAt(ring.length - 1)).toBe(T + 1_000);
    }
    expect(newest(series.cpu)).toEqual([25]);
    expect(newest(series.memory)).toEqual([75, 25]);
    expect(newest(series.load)).toEqual([0.5]);
    expect(newest(series.gpu)).toEqual([40, 25]);
    expect(newest(series.cores)).toEqual([70, 80]);
  });

  it("reseeds from a new history object, as a reopened stream sends", () => {
    const series = createMachineSeries(1_000, 900_000, 2);
    receiveMachineSnapshot(series, snapshot({ history: history(3) }), T);
    receiveMachineSnapshot(series, snapshot(), T + 1_000);
    expect(series.cpu.length).toBe(12);

    const reopened = history(5);
    receiveMachineSnapshot(series, snapshot({ history: reopened }), T + 60_000);

    expect(series.seededFrom).toBe(reopened);
    for (const ring of [series.cpu, series.memory, series.load, series.gpu]) {
      expect(ring.length).toBe(21);
      expect(ring.timeAt(0)).toBe(T + 40_000);
      expect(ring.timeAt(ring.length - 1)).toBe(T + 60_000);
    }
  });

  it("adds nothing for a heartbeat repeating the last sample time", () => {
    const series = createMachineSeries(1_000, 900_000, 2);
    receiveMachineSnapshot(series, snapshot(), T);
    receiveMachineSnapshot(
      series,
      snapshot({ sampleAgeMs: 2_000, totals: totals({ cpuUtilization: 0.9 }) }),
      T + 2_000,
    );

    for (const ring of [series.cpu, series.memory, series.load, series.gpu, series.cores]) {
      expect(ring.length).toBe(1);
    }
    expect(series.cpu.latest()).toBe(25);
  });

  it.each([
    ["no swap", { swapTotalBytes: 0, swapUsedBytes: 0 }, "memory", [75, 0]],
    ["no load average", { load: null }, "load", [Number.NaN]],
    ["no CPU reading", { cpuUtilization: null }, "cpu", [Number.NaN]],
    ["no CPU count", { cpuCount: 0, load: { one: 3, five: 3, fifteen: 3 } }, "load", [3]],
  ] as const)("pushes %s as its fallback", (_name, overrides, ring, expected) => {
    const series = createMachineSeries(1_000, 900_000, 2);
    receiveMachineSnapshot(series, snapshot({ totals: totals(overrides) }), T);
    expect(newest(series[ring])).toEqual(expected);
  });

  it("pushes NaN for the GPU without a readable device", () => {
    const series = createMachineSeries(1_000, 900_000, 2);
    receiveMachineSnapshot(series, snapshot(), T);
    expect(newest(series.gpu)).toEqual([Number.NaN, Number.NaN]);
  });

  it("skips cores whose count doesn't match the grid", () => {
    const series = createMachineSeries(1_000, 900_000, 4);
    receiveMachineSnapshot(series, snapshot({ history: history(3) }), T);
    receiveMachineSnapshot(series, snapshot({ sample: { perCore: [1, 2, 3] } }), T + 1_000);

    expect(series.cores.length).toBe(0);
    expect(series.cpu.length).toBeGreaterThan(0);
  });

  it("records nothing but the seed without totals", () => {
    const series = createMachineSeries(1_000, 900_000, 2);
    receiveMachineSnapshot(series, snapshot({ totals: null }), T);
    expect(series.cpu.length).toBe(0);
    expect(series.cores.length).toBe(0);
    expect(series.memoryPool.total).toBe(0);
  });

  it.each([
    ["64 GiB in 1 GiB cells", 64 * GIB, 16 * GIB, 64, 48],
    ["512 GiB in 4 GiB cells", 512 * GIB, 256 * GIB, 128, 64],
  ])("fills the memory pool, %s", (_name, total, available, cells, used) => {
    const series = createMachineSeries(1_000, 900_000, 2);
    receiveMachineSnapshot(
      series,
      snapshot({ totals: totals({ memoryTotalBytes: total, memoryAvailableBytes: available }) }),
      T,
    );
    expect(series.memoryPool.total).toBe(cells);
    expect(series.memoryPool.segments).toEqual([{ cells: used, color: "--primary" }]);
    expect(series.memoryUsage).toEqual({ totalBytes: total, usedBytes: total - available });
  });

  it("recolours the pool by owner between snapshots, and back to one colour on null", () => {
    const series = createMachineSeries(1_000, 900_000, 2);
    // Before any totals there is nothing to split.
    setMemoryOwners(series, [{ bytes: 8 * GIB, color: "--owner-1" }]);
    expect(series.memoryPool.total).toBe(0);

    receiveMachineSnapshot(series, snapshot(), T);
    expect(series.memoryPool.segments).toEqual([
      { cells: 8, color: "--owner-1" },
      { cells: 40, color: "--owner-other" },
    ]);

    setMemoryOwners(series, null);
    expect(series.memoryPool.segments).toEqual([{ cells: 48, color: "--primary" }]);
  });

  it("fills the VRAM pool in 256 MiB cells only when a device reports VRAM", () => {
    const series = createMachineSeries(1_000, 900_000, 2);
    receiveMachineSnapshot(series, snapshot({ sample: { perCore: [1, 2], gpus: [] } }), T);
    expect(series.vramPool.total).toBe(0);

    receiveMachineSnapshot(
      series,
      snapshot({ sample: { perCore: [1, 2], gpus: [gpu({ sharedMemory: true })] } }),
      T + 1_000,
    );
    expect(series.vramPool.total).toBe(0);

    receiveMachineSnapshot(
      series,
      snapshot({ sample: { perCore: [1, 2], gpus: [gpu()] } }),
      T + 2_000,
    );
    expect(series.vramPool.total).toBe(96);
    expect(series.vramPool.segments).toEqual([{ cells: 24, color: "--primary" }]);
  });
});

describe("memorySegments", () => {
  it.each<[string, number, ReadonlyArray<{ bytes: number; color: string }> | null, unknown]>([
    [
      "used memory in one colour without owners",
      48 * GIB,
      null,
      [{ cells: 48, color: "--primary" }],
    ],
    [
      "used memory in one colour for an empty list",
      48 * GIB,
      [],
      [{ cells: 48, color: "--primary" }],
    ],
    [
      "each owner, then the rest as other",
      48 * GIB,
      [
        { bytes: 10 * GIB, color: "--owner-1" },
        { bytes: 6 * GIB, color: "--owner-2" },
      ],
      [
        { cells: 10, color: "--owner-1" },
        { cells: 6, color: "--owner-2" },
        { cells: 32, color: "--owner-other" },
      ],
    ],
    [
      "owners summing past used memory, scaled down to fit",
      20 * GIB,
      [
        { bytes: 30 * GIB, color: "--owner-1" },
        { bytes: 10 * GIB, color: "--owner-2" },
      ],
      [
        { cells: 15, color: "--owner-1" },
        { cells: 5, color: "--owner-2" },
      ],
    ],
    [
      "no segment for an owner under half a cell",
      4 * GIB,
      [
        { bytes: 0.2 * GIB, color: "--owner-1" },
        { bytes: 2 * GIB, color: "--owner-2" },
      ],
      [
        { cells: 2, color: "--owner-2" },
        { cells: 2, color: "--owner-other" },
      ],
    ],
  ])("draws %s", (_name, used, owners, expected) => {
    expect(memorySegments(used, GIB, owners)).toEqual(expected);
  });

  it("never draws past used memory when rounding up", () => {
    const owners = [0, 1, 2].map((index) => ({ bytes: 1.5 * GIB, color: `--owner-${index + 1}` }));
    // 4.5 GiB fits in 5 unscaled, but each rounds up to 2 cells; the last gets what is left.
    expect(memorySegments(5 * GIB, GIB, owners)).toEqual([
      { cells: 2, color: "--owner-1" },
      { cells: 2, color: "--owner-2" },
      { cells: 1, color: "--owner-3" },
    ]);
  });
});

describe("gpuReadings", () => {
  it.each<[string, ReadonlyArray<GpuDeviceSample> | undefined, number, number]>([
    ["no devices", undefined, Number.NaN, Number.NaN],
    ["an empty list", [], Number.NaN, Number.NaN],
    ["one device", [gpu()], 40, 25],
    [
      "the peak of active devices",
      [gpu({ utilPercent: 90, vramUsedBytes: 3 * GIB }), gpu({ id: "b", vramUsedBytes: 18 * GIB })],
      90,
      75,
    ],
    [
      "active devices only",
      [
        gpu({ status: "suspended", utilPercent: 99, vramUsedBytes: 24 * GIB }),
        gpu({ status: "unavailable", utilPercent: 99, vramUsedBytes: 24 * GIB }),
        gpu({ id: "b", utilPercent: 10, vramUsedBytes: 12 * GIB }),
      ],
      10,
      50,
    ],
    [
      "nulls and NaN skipped",
      [
        gpu({ utilPercent: null, vramUsedBytes: null }),
        gpu({ id: "b", utilPercent: Number.NaN, vramTotalBytes: 0 }),
        gpu({ id: "c", utilPercent: 5, vramTotalBytes: null }),
      ],
      5,
      Number.NaN,
    ],
    [
      "only unreadable values",
      [gpu({ utilPercent: null, vramUsedBytes: null })],
      Number.NaN,
      Number.NaN,
    ],
  ])("takes %s", (_name, gpus, util, vramPercent) => {
    expect(gpuReadings(gpus)).toEqual({ util, vramPercent });
  });
});

describe("hasReadableGpu", () => {
  it.each<[string, MachineStatusSnapshot | null, boolean]>([
    ["no snapshot", null, false],
    ["no sample", withoutSample(snapshot()), false],
    ["no devices", snapshot({ sample: { perCore: [] } }), false],
    [
      "only unavailable devices",
      snapshot({ sample: { perCore: [], gpus: [gpu({ status: "unavailable" })] } }),
      false,
    ],
    [
      "a suspended device",
      snapshot({ sample: { perCore: [], gpus: [gpu({ status: "suspended" })] } }),
      true,
    ],
    ["an active device", snapshot({ sample: { perCore: [], gpus: [gpu()] } }), true],
  ])("is %s → %s", (_name, value, expected) => {
    expect(hasReadableGpu(value)).toBe(expected);
  });
});

describe("poolCellBytes", () => {
  it.each([
    ["64 GiB of memory", 64 * GIB, GIB, GIB],
    ["exactly 128 cells", 128 * GIB, GIB, GIB],
    ["just over 128 cells", 129 * GIB, GIB, 2 * GIB],
    ["512 GiB of memory", 512 * GIB, GIB, 4 * GIB],
    ["24 GiB of VRAM", 24 * GIB, 256 * MIB, 256 * MIB],
    ["80 GiB of VRAM", 80 * GIB, 256 * MIB, 1 * GIB],
    ["nothing", 0, GIB, GIB],
  ])("sizes %s", (_name, total, base, unit) => {
    expect(poolCellBytes(total, base)).toBe(unit);
    expect(total / unit).toBeLessThanOrEqual(128);
  });
});

describe("snapshotCores", () => {
  it.each<[string, MachineStatusSnapshot, number]>([
    ["history first", snapshot({ history: history(1, { cores: 6 }) }), 6],
    ["the live sample", snapshot({ sample: { perCore: [1, 2, 3] } }), 3],
    ["nothing yet", withoutSample(snapshot()), 0],
  ])("reads %s", (_name, value, cores) => {
    expect(snapshotCores(value)).toBe(cores);
  });
});
