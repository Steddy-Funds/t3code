import { DEFAULT_MACHINE_THRESHOLDS, type MachineThresholds } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { HostGpuTotals, HostTotals } from "./hostTotals.ts";
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

const gpu = (id: string, overrides: Partial<HostGpuTotals> = {}): HostGpuTotals => ({
  id,
  name: `GPU ${id}`,
  vendor: "nvidia",
  status: "active",
  utilPercent: 10,
  vramUsedPercent: 10,
  ...overrides,
});

// Calm load and memory, so only the GPU rules can stress.
const withGpus = (...gpus: Array<HostGpuTotals>) => totals({ gpus });

describe("stepVerdict GPU rules", () => {
  it.each<{
    label: string;
    device: Partial<HostGpuTotals>;
    at: number;
    verdict: "ok" | "stressed";
    rule?: "gpuVram" | "gpuUtil";
  }>([
    {
      label: "NVIDIA VRAM at 92.5 % held enterHoldMs",
      device: { vramUsedPercent: 92.5 },
      at: 10_000,
      verdict: "stressed",
      rule: "gpuVram",
    },
    {
      label: "NVIDIA VRAM over, before enterHoldMs",
      device: { vramUsedPercent: 99 },
      at: 9_999,
      verdict: "ok",
    },
    {
      label: "NVIDIA VRAM just under",
      device: { vramUsedPercent: 92.4 },
      at: 600_000,
      verdict: "ok",
    },
    {
      label: "Intel VRAM (shared memory) never counts",
      device: { vendor: "intel", vramUsedPercent: 100 },
      at: 600_000,
      verdict: "ok",
    },
    { label: "NVIDIA VRAM unknown", device: { vramUsedPercent: null }, at: 600_000, verdict: "ok" },
    {
      label: "util at 95 % held gpuUtilHoldMs",
      device: { utilPercent: 95 },
      at: 300_000,
      verdict: "stressed",
      rule: "gpuUtil",
    },
    {
      label: "util over, held only enterHoldMs",
      device: { utilPercent: 100 },
      at: 299_999,
      verdict: "ok",
    },
    {
      label: "Intel util held gpuUtilHoldMs",
      device: { vendor: "intel", utilPercent: 99 },
      at: 300_000,
      verdict: "stressed",
      rule: "gpuUtil",
    },
    { label: "util unknown", device: { utilPercent: null }, at: 600_000, verdict: "ok" },
    {
      label: "a suspended device",
      device: { status: "suspended", utilPercent: 100, vramUsedPercent: 100 },
      at: 600_000,
      verdict: "ok",
    },
    {
      label: "an unavailable device",
      device: { status: "unavailable", utilPercent: 100, vramUsedPercent: 100 },
      at: 600_000,
      verdict: "ok",
    },
  ])("$label → $verdict", ({ device, at, verdict, rule }) => {
    const sample = withGpus(gpu("0000:01:00.0", device));
    const states = run([
      [0, sample],
      [at, sample],
    ]);
    expect(states[1]!.verdict).toBe(verdict);
    if (rule !== undefined) {
      expect(states[1]!.reason).toMatchObject({
        rule,
        heldForMs: at,
        deviceId: "0000:01:00.0",
        deviceName: "GPU 0000:01:00.0",
      });
    }
  });

  it("carries the threshold from settings in the reason", () => {
    const [state] = run([[0, withGpus(gpu("a", { vramUsedPercent: 81 }))]], {
      enterHoldMs: 0,
      gpuVramUsedPercent: 80,
    });
    expect(state!.reason).toMatchObject({ rule: "gpuVram", value: 81, threshold: 80 });
  });

  it.each([
    ["no gpus field (no monitor)", totals()],
    ["an empty device list", withGpus()],
  ])("judges CPU and memory alone with %s", (_name, sample) => {
    const states = run([[0, sample]], { enterHoldMs: 0 });
    expect(states[0]!.verdict).toBe("ok");
    expect(Object.keys(states[0]!.overSince)).toEqual([]);
  });

  it("is ok, not unknown, when only an active GPU can be measured", () => {
    const sample = totals({ load: null, memoryTotalBytes: 0, gpus: [gpu("a")] });
    expect(run([[0, sample]])[0]!.verdict).toBe("ok");
  });

  it("is unknown when the only GPU is suspended and nothing else is measured", () => {
    const sample = totals({
      load: null,
      memoryTotalBytes: 0,
      gpus: [gpu("a", { status: "suspended" })],
    });
    expect(run([[0, sample]])[0]!.verdict).toBe("unknown");
  });

  it("holds util per device, so two devices taking turns never add up", () => {
    const busyA = withGpus(gpu("a", { utilPercent: 99 }), gpu("b"));
    const busyB = withGpus(gpu("a"), gpu("b", { utilPercent: 99 }));
    const states = run([
      [0, busyA],
      [150_000, busyA],
      [150_001, busyB],
      [300_000, busyB],
      [450_000, busyB],
      [450_001, busyB],
    ]);
    expect(verdicts(states)).toEqual(["ok", "ok", "ok", "ok", "ok", "stressed"]);
    expect(states[5]!.reason).toMatchObject({ rule: "gpuUtil", deviceId: "b", heldForMs: 300_000 });
  });

  it("keeps separate VRAM and util holds on one device", () => {
    const both = withGpus(gpu("a", { utilPercent: 99, vramUsedPercent: 99 }));
    const states = run([
      [0, both],
      [10_000, both],
    ]);
    expect(states[1]!.reason).toMatchObject({ rule: "gpuVram", deviceId: "a" });
    expect(Object.keys(states[1]!.overSince).sort()).toEqual(["gpuUtil:a", "gpuVram:a"]);
  });

  it("drops a device's hold when it suspends, so waking restarts it", () => {
    const busy = withGpus(gpu("a", { utilPercent: 99 }));
    const asleep = withGpus(gpu("a", { status: "suspended", utilPercent: 0 }));
    const states = run([
      [0, busy],
      [200_000, busy],
      [205_000, asleep],
      [210_000, busy],
      [500_000, busy],
      [510_000, busy],
    ]);
    expect(verdicts(states)).toEqual(["ok", "ok", "ok", "ok", "ok", "stressed"]);
    expect(states[5]!.reason!.heldForMs).toBe(300_000);
  });

  it("names the worse of a GPU rule and a host rule, relative to threshold", () => {
    const sample = totals({
      load: { one: 13, five: 13, fifteen: 13 },
      gpus: [gpu("a", { vramUsedPercent: 99 })],
    });
    expect(run([[0, sample]], { enterHoldMs: 0 })[0]!.reason).toMatchObject({
      rule: "gpuVram",
      deviceId: "a",
    });
  });

  it("while stressed, sticks to the same rule and device while it stays over the exit level", () => {
    const states = run(
      [
        [0, withGpus(gpu("a", { utilPercent: 96 }), gpu("b"))],
        // b is worse, a is still over 0.85 × 95 = 80.75
        [5_000, withGpus(gpu("a", { utilPercent: 81 }), gpu("b", { utilPercent: 100 }))],
        // a falls under its exit level: the reason moves to b
        [10_000, withGpus(gpu("a", { utilPercent: 80 }), gpu("b", { utilPercent: 100 }))],
      ],
      { gpuUtilHoldMs: 0 },
    );
    expect(verdicts(states)).toEqual(["stressed", "stressed", "stressed"]);
    expect(states.map((state) => state.reason?.deviceId)).toEqual(["a", "a", "b"]);
    expect(states[2]!.reason).toMatchObject({
      rule: "gpuUtil",
      deviceName: "GPU b",
      heldForMs: 5_000,
    });
  });

  it("does not stick to the same rule on another device", () => {
    const states = run(
      [
        [0, withGpus(gpu("a", { vramUsedPercent: 99 }), gpu("b"))],
        [5_000, withGpus(gpu("a"), gpu("b", { vramUsedPercent: 99 }))],
      ],
      { enterHoldMs: 0 },
    );
    expect(states.map((state) => state.reason?.deviceId)).toEqual(["a", "b"]);
  });

  it("leaves a GPU stress only after util stays under the exit level for exitHoldMs", () => {
    const at = (utilPercent: number) => withGpus(gpu("a", { utilPercent }));
    const states = run(
      [
        [0, at(99)],
        [5_000, at(81)],
        [10_000, at(80)],
        [69_999, at(80)],
        [70_000, at(80)],
      ],
      { gpuUtilHoldMs: 0 },
    );
    expect(verdicts(states)).toEqual(["stressed", "stressed", "stressed", "stressed", "ok"]);
    expect(states.map((state) => state.clearSince)).toEqual([null, null, 10_000, 10_000, null]);
  });

  it("clears a GPU stress when the device suspends", () => {
    const states = run(
      [
        [0, withGpus(gpu("a", { vramUsedPercent: 99 }))],
        [5_000, withGpus(gpu("a", { status: "suspended" }))],
        [65_000, withGpus(gpu("a", { status: "suspended" }))],
      ],
      { enterHoldMs: 0 },
    );
    expect(verdicts(states)).toEqual(["stressed", "stressed", "ok"]);
    expect(states[1]!.clearSince).toBe(5_000);
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
