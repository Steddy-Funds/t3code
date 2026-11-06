import { DEFAULT_MACHINE_THRESHOLDS, type MachineThresholds } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { HostTotals } from "./hostTotals.ts";
import {
  initialVerdictState,
  stepVerdict,
  verdictChanged,
  type VerdictState,
} from "./nodeVerdict.ts";

const GiB = 1024 ** 3;

// One core, so load.five reads directly as load per core; memory at 50 % used.
function totals(overrides: Partial<HostTotals> = {}): HostTotals {
  return {
    platform: "linux",
    sampledAt: 0,
    cpuCount: 1,
    cpuUtilization: 0.1,
    perCore: [10],
    load: { one: 1, five: 1, fifteen: 1 },
    memoryTotalBytes: 16 * GiB,
    memoryAvailableBytes: 8 * GiB,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
    memoryPressure: null,
    ...overrides,
  };
}

const load = (five: number, overrides: Partial<HostTotals> = {}) =>
  totals({ load: { one: five, five, fifteen: five }, ...overrides });

const memoryUsed = (percent: number) =>
  totals({ memoryTotalBytes: 1000, memoryAvailableBytes: 1000 - percent * 10 });

const darwin = (overrides: Partial<HostTotals>) => totals({ platform: "darwin", ...overrides });

const win32 = (cpuUtilization: number | null, overrides: Partial<HostTotals> = {}) =>
  totals({ platform: "win32", load: null, cpuUtilization, ...overrides });

function run(
  steps: ReadonlyArray<readonly [now: number, totals: HostTotals | null]>,
  overrides: Partial<MachineThresholds> = {},
  start: VerdictState = initialVerdictState(0),
): Array<VerdictState> {
  const th = { ...DEFAULT_MACHINE_THRESHOLDS, ...overrides };
  const states: Array<VerdictState> = [];
  let state = start;
  for (const [now, sample] of steps) {
    state = stepVerdict(state, sample, th, now);
    states.push(state);
  }
  return states;
}

const verdicts = (states: ReadonlyArray<VerdictState>) => states.map((state) => state.verdict);

describe("stepVerdict entering stressed", () => {
  it("enters only once a rule has held over its threshold for enterHoldMs", () => {
    const states = run([
      [0, load(13)],
      [5_000, load(13)],
      [9_999, load(13)],
      [10_000, load(13)],
    ]);
    expect(verdicts(states)).toEqual(["ok", "ok", "ok", "stressed"]);
    expect(states[3]).toMatchObject({
      since: 10_000,
      reason: { rule: "load", value: 13, threshold: 12.5, heldForMs: 10_000 },
      clearSince: null,
    });
  });

  it("restarts the hold after one reading dips below the threshold", () => {
    const states = run([
      [0, load(13)],
      [5_000, load(13)],
      [8_000, load(12)],
      [10_000, load(13)],
      [15_000, load(13)],
      [20_000, load(13)],
    ]);
    expect(verdicts(states)).toEqual(["ok", "ok", "ok", "ok", "ok", "stressed"]);
    expect(states[5]!.reason?.heldForMs).toBe(10_000);
  });

  it.each([
    ["enterHoldMs 0 enters on the first reading over", load(13), "load", 13],
    ["a value equal to the threshold counts as over", load(12.5), "load", 12.5],
    ["Linux memory is (total - available) / total", memoryUsed(93), "memory", 93],
  ] as const)("%s", (_name, sample, rule, value) => {
    const [state] = run([[1_000, sample]], { enterHoldMs: 0 });
    expect(state).toMatchObject({
      verdict: "stressed",
      since: 1_000,
      reason: { rule, heldForMs: 0 },
    });
    expect(state!.reason!.value).toBeCloseTo(value, 9);
  });

  it("stays ok with Linux memory just under its threshold", () => {
    expect(verdicts(run([[0, memoryUsed(92)]], { enterHoldMs: 0 }))).toEqual(["ok"]);
  });

  it("names the worst rule, relative to its threshold, when two enter together", () => {
    const [state] = run(
      [
        [
          0,
          totals({
            load: { one: 13, five: 13, fifteen: 13 },
            memoryTotalBytes: 1000,
            memoryAvailableBytes: 1,
          }),
        ],
      ],
      { enterHoldMs: 0, loadPerCore: 12.5, memoryUsedPercent: 50 },
    );
    expect(state!.reason!.rule).toBe("memory");
  });
});

describe("stepVerdict leaving stressed", () => {
  const stressedAt0 = () => run([[0, load(20)]], { enterHoldMs: 0 })[0]!;

  it("leaves only after every rule stays under exitFactor x threshold for exitHoldMs", () => {
    const states = run(
      [
        [5_000, load(10)],
        [64_999, load(10)],
        [65_000, load(10)],
      ],
      { enterHoldMs: 0 },
      stressedAt0(),
    );
    expect(verdicts(states)).toEqual(["stressed", "stressed", "ok"]);
    expect(states[0]).toMatchObject({ since: 0, clearSince: 5_000 });
    expect(states[2]).toMatchObject({ since: 65_000, reason: null, clearSince: null });
  });

  it("stays stressed between the exit level and the threshold, and restarts the clear hold", () => {
    const states = run(
      [
        [5_000, load(10)],
        [35_000, load(11)],
        [45_000, load(10)],
        [104_999, load(10)],
        [105_000, load(10)],
      ],
      { enterHoldMs: 0 },
      stressedAt0(),
    );
    expect(verdicts(states)).toEqual(["stressed", "stressed", "stressed", "stressed", "ok"]);
    expect(states.map((state) => state.clearSince)).toEqual([5_000, null, 45_000, 45_000, null]);
    expect(states[1]).toMatchObject({ since: 0, reason: { rule: "load", value: 11 } });
  });

  it("keeps the reason's rule while it holds, even when another rule is worse", () => {
    const both = totals({
      load: { one: 13, five: 13, fifteen: 13 },
      memoryTotalBytes: 1000,
      memoryAvailableBytes: 1,
    });
    const memoryOnly = totals({ memoryTotalBytes: 1000, memoryAvailableBytes: 1 });
    const states = run(
      [
        [0, load(13)],
        [5_000, both],
        [10_000, memoryOnly],
      ],
      { enterHoldMs: 0, memoryUsedPercent: 60 },
    );
    expect(states.map((state) => state.reason?.rule)).toEqual(["load", "load", "memory"]);
    expect(states[1]!.reason!.heldForMs).toBe(5_000);
    expect(verdicts(states)).toEqual(["stressed", "stressed", "stressed"]);
  });
});

describe("stepVerdict per platform", () => {
  it("uses CPU utilization with windowsCpuHoldMs on Windows, where load is null", () => {
    const states = run(
      [
        [0, win32(0.96)],
        [299_999, win32(0.96)],
        [300_000, win32(0.96)],
      ],
      { enterHoldMs: 0 },
    );
    expect(verdicts(states)).toEqual(["ok", "ok", "stressed"]);
    expect(states[2]!.reason).toMatchObject({ rule: "cpu", threshold: 95, heldForMs: 300_000 });
    expect(states[2]!.reason!.value).toBeCloseTo(96, 9);
  });

  it("ignores a load average on Windows", () => {
    expect(
      verdicts(
        run([[0, win32(0.1, { load: { one: 99, five: 99, fifteen: 99 } })]], { enterHoldMs: 0 }),
      ),
    ).toEqual(["ok"]);
  });

  it("still judges memory on Windows before the first CPU delta", () => {
    expect(verdicts(run([[0, win32(null)]]))).toEqual(["ok"]);
  });

  it("stresses on critical macOS pressure and counts warn as clear", () => {
    const states = run(
      [
        [0, darwin({ memoryPressure: "critical" })],
        [5_000, darwin({ memoryPressure: "warn" })],
        [65_000, darwin({ memoryPressure: "warn" })],
      ],
      { enterHoldMs: 0 },
    );
    expect(verdicts(states)).toEqual(["stressed", "stressed", "ok"]);
    expect(states[0]!.reason).toEqual({
      rule: "memoryPressure",
      value: 4,
      threshold: 4,
      heldForMs: 0,
    });
    expect(states[1]!.clearSince).toBe(5_000);
  });

  it.each([
    ["normal pressure", "normal"],
    ["no pressure report yet", null],
  ] as const)("never stresses macOS on 99 %% used RAM with %s", (_name, memoryPressure) => {
    const sample = darwin({ memoryPressure, memoryTotalBytes: 1000, memoryAvailableBytes: 10 });
    expect(verdicts(run([[0, sample]], { enterHoldMs: 0 }))).toEqual(["ok"]);
  });

  it("judges macOS by load alone while pressure is null", () => {
    const [state] = run(
      [[0, darwin({ memoryPressure: null, load: { one: 13, five: 13, fifteen: 13 } })]],
      {
        enterHoldMs: 0,
      },
    );
    expect(state!.reason?.rule).toBe("load");
  });

  it("divides the load average by the core count", () => {
    const sample = load(100, { cpuCount: 8 });
    expect(verdicts(run([[0, sample]], { enterHoldMs: 0 }))).toEqual(["stressed"]);
    expect(run([[0, sample]], { enterHoldMs: 0 })[0]!.reason!.value).toBe(12.5);
    expect(verdicts(run([[0, load(99, { cpuCount: 8 })]], { enterHoldMs: 0 }))).toEqual(["ok"]);
  });
});

describe("stepVerdict unknown", () => {
  it.each([
    ["no totals", null],
    ["no load and no memory total", totals({ load: null, memoryTotalBytes: 0 })],
    ["no cores and no memory total", totals({ cpuCount: 0, memoryTotalBytes: 0 })],
    ["Windows with no CPU delta and no memory total", win32(null, { memoryTotalBytes: 0 })],
    ["macOS with no pressure and no load", darwin({ load: null, memoryPressure: null })],
  ] as const)("is unknown with %s", (_name, sample) => {
    expect(run([[0, sample]])[0]!.verdict).toBe("unknown");
  });

  it("keeps since across repeated unknowns, and drops a stressed hold", () => {
    const states = run(
      [
        [0, load(20)],
        [5_000, null],
        [10_000, null],
        [15_000, load(20)],
        [24_999, load(20)],
        [25_000, load(20)],
      ],
      { enterHoldMs: 10_000 },
      { ...initialVerdictState(0), verdict: "ok" },
    );
    expect(verdicts(states)).toEqual(["ok", "unknown", "unknown", "ok", "ok", "stressed"]);
    expect(states[1]!.since).toBe(5_000);
    expect(states[2]).toBe(states[1]);
    expect(states[3]!.since).toBe(15_000);
  });

  it("stays ok with the same since across ok readings", () => {
    const states = run([
      [0, load(1)],
      [5_000, load(2)],
    ]);
    expect(states.map((state) => [state.verdict, state.since])).toEqual([
      ["ok", 0],
      ["ok", 0],
    ]);
  });
});

describe("verdictChanged", () => {
  const stressed = (rule: "load" | "memory", value: number, deviceId?: string): VerdictState => ({
    verdict: "stressed",
    since: 0,
    reason: {
      rule,
      value,
      threshold: 12.5,
      heldForMs: 0,
      ...(deviceId === undefined ? {} : { deviceId }),
    },
    overSince: {},
    clearSince: null,
  });

  it.each([
    ["value and hold drift", stressed("load", 13), stressed("load", 19), false],
    [
      "unknown becoming ok",
      initialVerdictState(0),
      { ...initialVerdictState(5), verdict: "ok" as const },
      true,
    ],
    [
      "a verdict change",
      stressed("load", 13),
      { ...stressed("load", 13), verdict: "ok" as const, reason: null },
      true,
    ],
    ["a reason rule change", stressed("load", 13), stressed("memory", 95), true],
    ["a reason device change", stressed("load", 13, "gpu-0"), stressed("load", 13, "gpu-1"), true],
  ] as const)("reports %s", (_name, prev, next, changed) => {
    expect(verdictChanged(prev, next)).toBe(changed);
  });

  it("ignores a since or clearSince change on the same verdict", () => {
    const prev = stressed("load", 13);
    expect(verdictChanged(prev, { ...prev, since: 99, clearSince: 50 })).toBe(false);
  });
});
