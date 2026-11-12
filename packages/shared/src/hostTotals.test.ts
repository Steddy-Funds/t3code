// @effect-diagnostics nodeBuiltinImport:off - stubs the node:os and node:fs/promises reads.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  cpuDeltas,
  hostGpuTotals,
  parseProcMeminfo,
  readHostTotals,
  type NativeHostTotals,
} from "./hostTotals.ts";

vi.mock("node:os", { spy: true });
vi.mock("node:fs/promises", { spy: true });

const KiB = 1024;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

describe("parseProcMeminfo", () => {
  it("reads total, available and swap in bytes", () => {
    const text = [
      "MemTotal:       16000000 kB",
      "MemFree:         1000000 kB",
      "MemAvailable:    8000000 kB",
      "SwapTotal:       2000000 kB",
      "SwapFree:         500000 kB",
    ].join("\n");
    expect(parseProcMeminfo(text)).toEqual({
      memoryTotalBytes: 16_000_000 * KiB,
      memoryAvailableBytes: 8_000_000 * KiB,
      swapTotalBytes: 2_000_000 * KiB,
      swapUsedBytes: 1_500_000 * KiB,
    });
  });

  it.each([
    ["no swap lines", "MemTotal: 100 kB\nMemAvailable: 50 kB", 0, 0],
    ["SwapTotal without SwapFree", "MemTotal: 100 kB\nSwapTotal: 40 kB", 40 * KiB, 0],
    ["SwapFree above SwapTotal", "SwapTotal: 40 kB\nSwapFree: 90 kB", 40 * KiB, 0],
  ])("reports swap with %s", (_name, text, swapTotalBytes, swapUsedBytes) => {
    expect(parseProcMeminfo(text)).toMatchObject({ swapTotalBytes, swapUsedBytes });
  });

  it("leaves a missing MemAvailable null instead of guessing", () => {
    expect(parseProcMeminfo("MemTotal: 100 kB")).toMatchObject({
      memoryTotalBytes: 100 * KiB,
      memoryAvailableBytes: null,
    });
  });
});

describe("cpuDeltas", () => {
  const counters = (...cores: Array<[idle: number, total: number]>) =>
    cores.map(([idle, total]) => ({ idle, total }));

  it("splits busy time overall and per core", () => {
    expect(cpuDeltas(counters([0, 0], [0, 0]), counters([75, 100], [0, 100]))).toEqual({
      cpuUtilization: 0.625,
      perCore: [25, 100],
    });
  });

  it.each([
    ["no previous read", null],
    ["a changed core count", counters([0, 0])],
  ])("has no utilization with %s", (_name, previous) => {
    expect(cpuDeltas(previous, counters([10, 100], [10, 100]))).toEqual({
      cpuUtilization: null,
      perCore: [],
    });
  });

  it("reads a core with no elapsed time as idle and the whole as unknown", () => {
    const same = counters([10, 100], [10, 100]);
    expect(cpuDeltas(same, same)).toEqual({ cpuUtilization: null, perCore: [0, 0] });
  });

  it("treats counters that went backwards as unknown", () => {
    expect(cpuDeltas(counters([50, 100]), counters([40, 200]))).toEqual({
      cpuUtilization: null,
      perCore: [0],
    });
  });
});

// Two cores; 16 GiB total with 6 GiB free as Node sees it; /proc/meminfo unreadable.
function setup() {
  vi.mocked(NodeOS.cpus).mockReset();
  vi.mocked(NodeOS.cpus).mockReturnValue(
    Array.from({ length: 2 }, () => ({
      model: "test",
      speed: 1,
      times: { user: 10, nice: 0, sys: 10, idle: 80, irq: 0 },
    })),
  );
  vi.mocked(NodeOS.loadavg).mockReset();
  vi.mocked(NodeOS.loadavg).mockReturnValue([1.5, 1.25, 1]);
  vi.mocked(NodeOS.totalmem).mockReset();
  vi.mocked(NodeOS.totalmem).mockReturnValue(16 * GiB);
  vi.mocked(NodeOS.freemem).mockReset();
  vi.mocked(NodeOS.freemem).mockReturnValue(6 * GiB);
  vi.mocked(NodeFSP.readFile).mockReset();
  vi.mocked(NodeFSP.readFile).mockRejectedValue(new Error("ENOENT"));
}

const NATIVE: NativeHostTotals = {
  memoryPressure: "warn",
  memoryAvailableBytes: 4 * GiB,
  swapTotalBytes: 2 * GiB,
  swapUsedBytes: 512 * MiB,
};

describe("readHostTotals", () => {
  it("reads macOS pressure, available memory and swap from the native monitor", async () => {
    setup();
    const { totals } = await readHostTotals(null, { platform: "darwin", native: NATIVE });
    expect(totals).toMatchObject({
      platform: "darwin",
      cpuCount: 2,
      memoryTotalBytes: 16 * GiB,
      memoryAvailableBytes: 4 * GiB,
      swapTotalBytes: 2 * GiB,
      swapUsedBytes: 512 * MiB,
      memoryPressure: "warn",
      load: { one: 1.5, five: 1.25, fifteen: 1 },
    });
    expect(totals).not.toHaveProperty("gpus");
  });

  it.each([
    ["no native argument", {}],
    ["a null native", { native: null }],
  ])("leaves macOS pressure and swap unknown with %s", async (_name, options) => {
    setup();
    const { totals } = await readHostTotals(null, { platform: "darwin", ...options });
    expect(totals).toMatchObject({
      memoryAvailableBytes: 6 * GiB,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      memoryPressure: null,
    });
  });

  it("falls back to Node per field when the native monitor sends nulls", async () => {
    setup();
    const { totals } = await readHostTotals(null, {
      platform: "darwin",
      native: {
        memoryPressure: "critical",
        memoryAvailableBytes: null,
        swapTotalBytes: null,
        swapUsedBytes: null,
      },
    });
    expect(totals).toMatchObject({
      memoryAvailableBytes: 6 * GiB,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      memoryPressure: "critical",
    });
  });

  it("clamps native available memory to the total", async () => {
    setup();
    const { totals } = await readHostTotals(null, {
      platform: "darwin",
      native: { ...NATIVE, memoryAvailableBytes: 64 * GiB },
    });
    expect(totals.memoryAvailableBytes).toBe(16 * GiB);
  });

  it("never reads /proc on macOS", async () => {
    setup();
    await readHostTotals(null, { platform: "darwin", native: NATIVE });
    expect(NodeFSP.readFile).not.toHaveBeenCalled();
  });

  it("ignores native totals on Linux and reads /proc/meminfo", async () => {
    setup();
    vi.mocked(NodeFSP.readFile).mockResolvedValue(
      "MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 100 kB\nSwapFree: 40 kB\n",
    );
    const { totals } = await readHostTotals(null, { platform: "linux", native: NATIVE });
    expect(NodeFSP.readFile).toHaveBeenCalledWith("/proc/meminfo", "utf8");
    expect(totals).toMatchObject({
      memoryTotalBytes: 1000 * KiB,
      memoryAvailableBytes: 250 * KiB,
      swapTotalBytes: 100 * KiB,
      swapUsedBytes: 60 * KiB,
      memoryPressure: null,
    });
  });

  it("keeps Node's memory on Linux when /proc/meminfo is unreadable", async () => {
    setup();
    const { totals } = await readHostTotals(null, { platform: "linux" });
    expect(totals).toMatchObject({
      memoryTotalBytes: 16 * GiB,
      memoryAvailableBytes: 6 * GiB,
      swapTotalBytes: 0,
      memoryPressure: null,
    });
  });

  it("has no load average on Windows and ignores native totals there", async () => {
    setup();
    const { totals } = await readHostTotals(null, { platform: "win32", native: NATIVE });
    expect(totals).toMatchObject({
      load: null,
      memoryAvailableBytes: 6 * GiB,
      swapTotalBytes: 0,
      memoryPressure: null,
    });
  });

  it("measures CPU against the previous counters it returned", async () => {
    setup();
    const first = await readHostTotals(null, { platform: "darwin" });
    expect(first.totals).toMatchObject({ cpuUtilization: null, perCore: [] });
    vi.mocked(NodeOS.cpus).mockReturnValue(
      Array.from({ length: 2 }, (_, core) => ({
        model: "test",
        speed: 1,
        times: { user: 10 + 100 * core, nice: 0, sys: 10, idle: 180 - 100 * core, irq: 0 },
      })),
    );
    const second = await readHostTotals(first.next, { platform: "darwin" });
    expect(second.totals.perCore).toEqual([0, 100]);
    expect(second.totals.cpuUtilization).toBe(0.5);
  });
});

describe("hostGpuTotals", () => {
  const device = {
    id: "0000:01:00.0",
    name: "RTX",
    vendor: "nvidia" as const,
    status: "active" as const,
    utilPercent: 40,
    vramTotalBytes: 8 * GiB,
    vramUsedBytes: 2 * GiB,
  };

  it("keeps identity, status and util and turns VRAM into a share", () => {
    expect(hostGpuTotals([device])).toEqual([
      {
        id: "0000:01:00.0",
        name: "RTX",
        vendor: "nvidia",
        status: "active",
        utilPercent: 40,
        vramUsedPercent: 25,
      },
    ]);
  });

  it.each([
    ["no total", { vramTotalBytes: null }],
    ["a zero total", { vramTotalBytes: 0 }],
    ["no used", { vramUsedBytes: null }],
  ])("has no VRAM share with %s", (_name, overrides) => {
    expect(hostGpuTotals([{ ...device, ...overrides }])[0]!.vramUsedPercent).toBeNull();
  });

  it("passes a suspended device through with its status", () => {
    const [gpu] = hostGpuTotals([
      { ...device, status: "suspended", utilPercent: 0, vramTotalBytes: null, vramUsedBytes: null },
    ]);
    expect(gpu).toMatchObject({ status: "suspended", utilPercent: 0, vramUsedPercent: null });
  });
});
