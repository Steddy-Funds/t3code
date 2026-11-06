import { describe, expect, it } from "vite-plus/test";

import {
  formatAge,
  formatMachineReason,
  formatPerCore,
  formatProcessMemory,
  type MachineIndicatorView,
  type MachineTotalsSummary,
  type MachineVerdictReason,
  machineVerdictText,
  memoryUsedPercent,
  topProcessesByName,
} from "./format";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const view = (overrides: Partial<MachineIndicatorView>): MachineIndicatorView => ({
  verdict: "ok",
  unreachable: false,
  reason: null,
  lastSeen: null,
  ...overrides,
});

const reason = (overrides: Partial<MachineVerdictReason>): MachineVerdictReason => ({
  rule: "load",
  value: 14.04,
  threshold: 12.5,
  heldForMs: 90_000,
  ...overrides,
});

const totals = (overrides: Partial<MachineTotalsSummary>): MachineTotalsSummary => ({
  cpuUtilization: 0.5,
  cpuCount: 8,
  load: null,
  memoryTotalBytes: 16 * GIB,
  memoryAvailableBytes: 4 * GIB,
  swapTotalBytes: 0,
  swapUsedBytes: 0,
  memoryPressure: null,
  ...overrides,
});

describe("machineVerdictText", () => {
  it.each([
    ["ok is quiet", view({}), null],
    [
      "stressed names the reason and how long it held",
      view({ verdict: "stressed", reason: reason({}) }),
      "Stressed: load 14.0 / 12.5 per core, 1 m",
    ],
    ["stressed without a reason", view({ verdict: "stressed" }), "Stressed"],
    ["unknown", view({ verdict: "unknown" }), "No sample yet"],
    [
      "unreachable, last seen stressed",
      view({ unreachable: true, lastSeen: { verdict: "stressed", ageMs: 120_000 } }),
      "Unreachable, last seen stressed 2 m ago",
    ],
    [
      "unreachable, last seen ok",
      view({ unreachable: true, lastSeen: { verdict: "ok", ageMs: 5_000 } }),
      "Unreachable, last seen 5 s ago",
    ],
    ["unreachable, never seen", view({ unreachable: true }), "Unreachable"],
    [
      "unreachable wins over a stale stressed verdict",
      view({ unreachable: true, verdict: "stressed", reason: reason({}) }),
      "Unreachable",
    ],
  ])("%s", (_name, input, expected) => {
    expect(machineVerdictText(input)).toBe(expected);
  });

  it.each(["ok", "stressed", "unknown"] as const)(
    "unreachable never says ok (last seen %s)",
    (verdict) => {
      const text = machineVerdictText(
        view({ unreachable: true, verdict: "ok", lastSeen: { verdict, ageMs: 1_000 } }),
      );
      expect(text).toMatch(/^Unreachable/);
      expect(text).not.toMatch(/\bok\b/i);
    },
  );
});

describe("formatMachineReason", () => {
  it.each([
    ["load", reason({ rule: "load", value: 13.27, threshold: 12.5 }), "load 13.3 / 12.5 per core"],
    ["memory", reason({ rule: "memory", value: 94.26, threshold: 92.5 }), "RAM 94.3% / 92.5%"],
    [
      "memoryPressure",
      reason({ rule: "memoryPressure", value: 4, threshold: 4 }),
      "memory pressure critical",
    ],
    ["cpu", reason({ rule: "cpu", value: 97.4, threshold: 95 }), "CPU 97% / 95%"],
    [
      "gpuVram with a device name",
      reason({
        rule: "gpuVram",
        value: 91.6,
        threshold: 90,
        deviceId: "0",
        deviceName: "RTX 4090",
      }),
      "RTX 4090 VRAM 92% / 90%",
    ],
    [
      "gpuVram falls back to the device id",
      reason({ rule: "gpuVram", value: 91.6, threshold: 90, deviceId: "gpu-1" }),
      "gpu-1 VRAM 92% / 90%",
    ],
    [
      "gpuUtil falls back to GPU",
      reason({ rule: "gpuUtil", value: 99.2, threshold: 95 }),
      "GPU util 99% / 95%",
    ],
  ])("%s", (_name, input, expected) => {
    expect(formatMachineReason(input)).toBe(expected);
  });
});

describe("formatAge", () => {
  it.each([
    [-500, "0 s"],
    [59_999, "59 s"],
    [60_000, "1 m"],
    [59 * 60_000 + 59_999, "59 m"],
    [3_600_000, "1 h"],
    [24 * 3_600_000 - 1, "23 h"],
    [24 * 3_600_000, "1 d"],
  ])("%d ms → %s", (ms, expected) => {
    expect(formatAge(ms)).toBe(expected);
  });
});

describe("formatProcessMemory", () => {
  it.each([
    [GIB - MIB, "1023 M"],
    [GIB, "1.0 G"],
    [9.2 * GIB, "9.2 G"],
    [0, "0 M"],
  ])("%d bytes → %s", (bytes, expected) => {
    expect(formatProcessMemory(bytes)).toBe(expected);
  });
});

describe("formatPerCore", () => {
  it("divides by the core count", () => {
    expect(formatPerCore(12, 8)).toBe("1.5");
  });

  it("treats zero cores as one instead of dividing by zero", () => {
    expect(formatPerCore(3, 0)).toBe("3.0");
  });
});

describe("memoryUsedPercent", () => {
  it("is the used share of total", () => {
    expect(memoryUsedPercent(totals({}))).toBe(75);
  });

  it("is 0 when total is 0", () => {
    expect(memoryUsedPercent(totals({ memoryTotalBytes: 0, memoryAvailableBytes: 0 }))).toBe(0);
  });

  it("never goes negative when available exceeds total", () => {
    expect(memoryUsedPercent(totals({ memoryAvailableBytes: 20 * GIB }))).toBe(0);
  });
});

describe("topProcessesByName", () => {
  const rows = [
    { name: "claude", cpu: 10, rssBytes: 300 },
    { name: "node", cpu: 25, rssBytes: 100 },
    { name: "claude", cpu: 20, rssBytes: 400 },
    { name: "vite", cpu: 5, rssBytes: 900 },
    { name: "git", cpu: 1, rssBytes: 50 },
  ];

  it("sums and counts rows sharing a name, sorted by the metric", () => {
    expect(topProcessesByName(rows, "cpu", 10)).toEqual([
      { name: "claude", count: 2, value: 30 },
      { name: "node", count: 1, value: 25 },
      { name: "vite", count: 1, value: 5 },
      { name: "git", count: 1, value: 1 },
    ]);
  });

  it("ranks by memory and keeps only the limit", () => {
    expect(topProcessesByName(rows, "rssBytes", 2)).toEqual([
      { name: "vite", count: 1, value: 900 },
      { name: "claude", count: 2, value: 700 },
    ]);
  });

  it("returns nothing for no rows", () => {
    expect(topProcessesByName([], "cpu", 3)).toEqual([]);
  });
});
