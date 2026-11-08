import type { MachineIndicatorView } from "@t3tools/client-runtime/state/machineFormat";
import type { MachineProcessRow } from "@t3tools/client-runtime/state/machineProcessFrames";
import type { GpuDeviceSample } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type CrossMachineEntry,
  type CrossMachineGroup,
  coreCellCount,
  crossMachineGroup,
  groupCoreRow,
  groupCoreSeries,
  loadPerCore,
  orderCrossMachines,
  resampleSeries,
  topOwnerShare,
  vramTotal,
} from "./crossMachineModel";
import { ownerThreadId } from "../ownership/processOwners";

const GIB = 1024 ** 3;

const view = (overrides: Partial<MachineIndicatorView> = {}): MachineIndicatorView => ({
  verdict: "ok",
  unreachable: false,
  reason: null,
  lastSeen: null,
  ...overrides,
});

describe("crossMachineGroup", () => {
  it.each<[string, MachineIndicatorView, CrossMachineGroup]>([
    ["stressed", view({ verdict: "stressed" }), "stressed"],
    ["ok", view(), "byLoad"],
    ["no sample yet (pending)", view({ verdict: "unknown" }), "unknown"],
    [
      "unreachable, last seen stressed",
      view({ unreachable: true, lastSeen: { verdict: "stressed", ageMs: 1 } }),
      "lastSeenStressed",
    ],
    [
      "unreachable, last seen ok",
      view({ unreachable: true, lastSeen: { verdict: "ok", ageMs: 1 } }),
      "unknown",
    ],
    ["unreachable, never seen", view({ unreachable: true }), "unknown"],
    [
      "unreachable wins over a stale stressed verdict",
      view({ unreachable: true, verdict: "stressed" }),
      "unknown",
    ],
  ])("%s", (_name, input, expected) => {
    expect(crossMachineGroup(input)).toBe(expected);
  });
});

describe("loadPerCore", () => {
  const totals = (load: { five: number } | null, cpuCount: number) => ({
    cpuUtilization: null,
    cpuCount,
    load: load === null ? null : { one: 0, five: load.five, fifteen: 0 },
    memoryTotalBytes: 0,
    memoryAvailableBytes: 0,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
    memoryPressure: null,
  });
  it("divides the five-minute load by cores, never by zero", () => {
    expect(loadPerCore(totals({ five: 6 }, 4))).toBe(1.5);
    expect(loadPerCore(totals({ five: 3 }, 0))).toBe(3);
  });
  it("is null without totals or a load average", () => {
    expect(loadPerCore(null)).toBeNull();
    expect(loadPerCore(totals(null, 4))).toBeNull();
  });
});

describe("orderCrossMachines", () => {
  const entry = (
    item: string,
    group: CrossMachineGroup,
    load: number | null = null,
  ): CrossMachineEntry<string> => ({ item, group, load });
  const order = (entries: Array<CrossMachineEntry<string>>) =>
    orderCrossMachines(entries).map((value) => value.item);

  it("puts stressed, then last seen stressed, then ok by load, then unknown", () => {
    expect(
      order([
        entry("unknown", "unknown"),
        entry("ok-low", "byLoad", 0.2),
        entry("seen", "lastSeenStressed"),
        entry("ok-high", "byLoad", 3),
        entry("stressed", "stressed", 0.1),
      ]),
    ).toEqual(["stressed", "seen", "ok-high", "ok-low", "unknown"]);
  });

  it("keeps catalog order for loads within a tenth and in other groups", () => {
    expect(
      order([
        entry("a", "byLoad", 1.01),
        entry("b", "byLoad", 1.04),
        entry("s1", "stressed", 0),
        entry("s2", "stressed", 9),
        entry("u1", "unknown"),
        entry("u2", "unknown"),
      ]),
    ).toEqual(["s1", "s2", "a", "b", "u1", "u2"]);
  });

  it("sorts a load more than a tenth higher first", () => {
    expect(order([entry("a", "byLoad", 1.0), entry("b", "byLoad", 1.2)])).toEqual(["b", "a"]);
  });

  it("puts an ok machine without a load average last among ok", () => {
    expect(
      order([entry("none", "byLoad", null), entry("zero", "byLoad", 0), entry("one", "byLoad", 1)]),
    ).toEqual(["one", "zero", "none"]);
  });

  it("does not mutate its input", () => {
    const entries = [entry("u", "unknown"), entry("s", "stressed")];
    orderCrossMachines(entries);
    expect(entries.map((value) => value.item)).toEqual(["u", "s"]);
  });
});

describe("core grouping", () => {
  it("caps the cell count at 20", () => {
    expect([0, 1, 20, 21, 64, -3].map(coreCellCount)).toEqual([0, 1, 20, 20, 20, 0]);
  });

  it("gives up to 20 cores a cell each", () => {
    const perCore = Array.from({ length: 12 }, (_, core) => core * 5);
    expect(Array.from(groupCoreRow(perCore, coreCellCount(12)))).toEqual(perCore);
  });

  it("averages runs of floor(i·64/20)..floor((i+1)·64/20) for 64 cores", () => {
    const perCore = Array.from({ length: 64 }, (_, core) => core);
    const row = groupCoreRow(perCore, 20);
    expect(row).toHaveLength(20);
    for (let cell = 0; cell < 20; cell++) {
      const start = Math.floor((cell * 64) / 20);
      const end = Math.floor(((cell + 1) * 64) / 20);
      expect(row[cell]).toBeCloseTo((start + end - 1) / 2, 5);
    }
    // 3 or 4 cores per cell; together they cover every core once.
    expect(row[0]).toBe(1);
    expect(row[19]).toBe(61.5);
  });

  it("skips NaN cores and leaves an all-NaN cell NaN", () => {
    const perCore = [10, Number.NaN, 30, Number.NaN, Number.NaN, Number.NaN];
    expect(Array.from(groupCoreRow(perCore, 3))).toEqual([10, 30, Number.NaN]);
  });

  it("folds series per cell and keeps their length", () => {
    const series = [
      new Float32Array([10, Number.NaN, 0]),
      new Float32Array([30, Number.NaN, Number.NaN]),
      new Float32Array([50, 60, 70]),
      new Float32Array([Number.NaN, Number.NaN, Number.NaN]),
    ];
    const grouped = groupCoreSeries(series, 2).map((cell) => Array.from(cell));
    expect(grouped).toEqual([
      [20, Number.NaN, 0],
      [50, 60, 70],
    ]);
  });

  it("matches the live row when folding 64 core series", () => {
    const perCore = Array.from({ length: 64 }, (_, core) => new Float32Array([core, core * 2]));
    const grouped = groupCoreSeries(perCore, 20);
    expect(grouped).toHaveLength(20);
    expect(grouped.every((cell) => cell.length === 2)).toBe(true);
    const live = groupCoreRow(
      perCore.map((series) => series[1]!),
      20,
    );
    expect(grouped.map((cell) => cell[1])).toEqual(Array.from(live));
  });

  it("folds no history into empty series", () => {
    expect(groupCoreSeries([], 0)).toEqual([]);
    expect(groupCoreSeries([new Float32Array(0)], 1).map((cell) => cell.length)).toEqual([0]);
  });
});

describe("vramTotal", () => {
  const gpu = (id: string, overrides: Partial<GpuDeviceSample> = {}): GpuDeviceSample => ({
    id,
    vendor: "nvidia",
    name: id,
    status: "active",
    utilPercent: 10,
    vramTotalBytes: 24 * GIB,
    vramUsedBytes: 6 * GIB,
    sharedMemory: false,
    ...overrides,
  });

  it("sums dedicated VRAM over active devices", () => {
    expect(
      vramTotal([gpu("a"), gpu("b", { vramTotalBytes: 8 * GIB, vramUsedBytes: GIB })]),
    ).toEqual({ usedBytes: 7 * GIB, totalBytes: 32 * GIB });
  });

  it("skips suspended, unavailable, shared-memory and unmeasured devices", () => {
    expect(
      vramTotal([
        gpu("a"),
        gpu("suspended", { status: "suspended" }),
        gpu("unavailable", { status: "unavailable" }),
        gpu("igpu", { vendor: "intel", sharedMemory: true }),
        gpu("noUsed", { vramUsedBytes: null }),
        gpu("noTotal", { vramTotalBytes: null }),
      ]),
    ).toEqual({ usedBytes: 6 * GIB, totalBytes: 24 * GIB });
  });

  it.each<[string, ReadonlyArray<GpuDeviceSample> | undefined]>([
    ["no gpus field", undefined],
    ["no devices", []],
    ["only a suspended device", [gpu("a", { status: "suspended" })]],
    ["only shared memory", [gpu("a", { sharedMemory: true })]],
  ])("is null with %s", (_name, gpus) => {
    expect(vramTotal(gpus)).toBeNull();
  });
});

describe("resampleSeries", () => {
  const series = (...columns: ReadonlyArray<ReadonlyArray<number>>) =>
    columns.map((column) => new Float32Array(column));
  const ramp = (length: number) => Float32Array.from({ length }, (_, index) => index);
  const values = (columns: ReadonlyArray<Float32Array>) => columns.map((c) => Array.from(c));

  it("returns the input columns unchanged for equal steps, in a new array", () => {
    const input = series([1, 2, 3], [4, 5, 6]);
    const output = resampleSeries(input, 5_000, 5_000);
    expect(output).not.toBe(input);
    expect(output[0]).toBe(input[0]);
    expect(output[1]).toBe(input[1]);
  });

  it("keeps empty columns empty", () => {
    expect(values(resampleSeries(series([], []), 5_000, 2_000))).toEqual([[], []]);
    expect(resampleSeries([], 5_000, 2_000)).toEqual([]);
  });

  it.each<[string, number, number, ReadonlyArray<number>]>([
    // Output times -10,-8,-6,-4,-2,0 s over inputs at -10,-5,0 s: newest at or before each.
    ["5 s to 2 s", 5_000, 2_000, [10, 10, 10, 20, 20, 30]],
    ["5 s to 10 s", 5_000, 10_000, [10, 30]],
    ["5 s to 3 s", 5_000, 3_000, [10, 10, 20, 30]],
    // A 4 s span at 5 s fits one point, the newest.
    ["2 s to 5 s", 2_000, 5_000, [30]],
  ])("takes the newest sample at or before each point, %s", (_name, from, to, expected) => {
    expect(values(resampleSeries(series([10, 20, 30]), from, to))).toEqual([expected]);
  });

  it.each<[string, number, number, number]>([
    ["5 s to 2 s", 2_000, 148, 0],
    ["5 s to 10 s", 10_000, 30, 1],
  ])(
    "sizes 60 points %s as floor((len-1)*from/to)+1, every column alike",
    (_name, to, points, first) => {
      const input = [ramp(60), ramp(60)];
      const output = resampleSeries(input, 5_000, to);
      expect(output.map((column) => column.length)).toEqual([points, points]);
      expect(output.map((column) => column[points - 1])).toEqual([59, 59]);
      expect(output[0]![0]).toBe(first);
    },
  );

  it("indexes len-1-ceil(age/from) for every point", () => {
    const output = resampleSeries([ramp(60)], 5_000, 2_000)[0]!;
    output.forEach((value, point) => {
      const ageMs = (output.length - 1 - point) * 2_000;
      expect(value).toBe(59 - Math.ceil(ageMs / 5_000));
    });
  });

  it("passes NaN through", () => {
    expect(values(resampleSeries(series([10, Number.NaN, 30]), 5_000, 2_000))).toEqual([
      [10, 10, 10, Number.NaN, Number.NaN, 30],
    ]);
  });
});

describe("topOwnerShare", () => {
  const row = (threadId: string | null, cpu: number) =>
    ({
      cpu,
      rss: 0,
      ...(threadId === null ? {} : { owner: { type: "thread", threadId } }),
    }) as unknown as MachineProcessRow;
  const byThread = (r: MachineProcessRow) => ownerThreadId(r.owner);

  it("sums each owner's rows and labels the busiest as a floor", () => {
    const rows = [row("a", 30), row("b", 50), row("a", 40.4), row(null, 99)];
    expect(topOwnerShare(rows, byThread)).toEqual({ key: "a", text: "≥70%" });
  });

  it("is null when no row has an owner", () => {
    expect(topOwnerShare([row(null, 10)], byThread)).toBeNull();
    expect(topOwnerShare([], byThread)).toBeNull();
  });
});
