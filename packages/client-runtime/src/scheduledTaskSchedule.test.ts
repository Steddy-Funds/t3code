// @effect-diagnostics globalDate:off - Expected labels use the same local Date formatting as the summary.
import type { LoadCondition, LoadMetric, ScheduledTaskLoadSchedule } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_LOAD_SCHEDULE_DRAFT,
  LOAD_METRICS,
  type LoadConditionDraft,
  type LoadScheduleDraft,
  loadScheduleDraft,
  loadScheduleFromDraft,
  scheduledTaskScheduleSummary,
  withLoadMetric,
  withLoadVerdictState,
} from "./scheduledTaskSchedule.ts";

const load = (condition: LoadCondition, clear?: LoadCondition): ScheduledTaskLoadSchedule => ({
  type: "load",
  condition,
  ...(clear === undefined ? {} : { clear }),
});
const when = (
  metric: LoadMetric,
  op: LoadCondition["op"],
  threshold: number,
  sustainSeconds = 0,
  gpuId?: string,
): LoadCondition => ({
  metric,
  op,
  threshold,
  sustainSeconds,
  ...(gpuId === undefined ? {} : { gpuId }),
});

describe("scheduledTaskScheduleSummary", () => {
  it.each([
    [{ type: "webhook" }, "On webhook"],
    [{ type: "interval", everyMs: 15 * 60_000 }, "Every 15 minutes"],
    [{ type: "interval", everyMs: 60 * 60_000 }, "Every hour"],
    [{ type: "interval", everyMs: 90 * 60_000 }, "Every 1 hour 30 minutes"],
    [{ type: "interval", everyMs: 30_000 }, "Every 30 seconds"],
  ] as const)("labels %j as %s", (schedule, label) => {
    expect(scheduledTaskScheduleSummary(schedule as never)).toBe(label);
  });

  it("labels fixed times by their days and local time", () => {
    const at = new Date(2000, 0, 1, 9, 5).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    for (const [weekdays, days] of [
      [undefined, "Every day"],
      [[], "Every day"],
      [[0, 1, 2, 3, 4, 5, 6], "Every day"],
      [[5, 1, 3, 2, 4], "Weekdays"],
      [[0, 3, 1], "Mon, Wed, Sun"],
      [[6, 0], "Sat, Sun"],
      [[1, 2, 3, 4, 6], "Mon, Tue, Wed, Thu, Sat"],
    ] as const) {
      expect(
        scheduledTaskScheduleSummary({
          type: "fixed_time",
          timeOfDay: "09:05",
          ...(weekdays === undefined ? {} : { weekdays }),
        } as never),
      ).toBe(`${days} at ${at}`);
    }
  });

  it("labels a one-time run with its local date and time", () => {
    const runAt = new Date(2026, 10, 8, 14, 30).toISOString();
    const date = new Date(runAt);
    const day = date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
    const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(scheduledTaskScheduleSummary({ type: "once", runAt } as never)).toBe(
      `Once, ${day} at ${time}`,
    );
  });

  it.each([
    [load(when("loadPerCore", "<=", 8, 120)), "On load · load/core ≤ 8 for 2 min"],
    [load(when("cpuPercent", ">=", 92.5)), "On load · CPU ≥ 92.5%"],
    [load(when("cpuPercent", ">=", 92.456, 45)), "On load · CPU ≥ 92.46% for 45 s"],
    [load(when("memoryUsedPercent", ">=", 90, 90)), "On load · RAM ≥ 90% for 1 min 30 s"],
    [load(when("swapUsedPercent", ">=", 10, 3600)), "On load · swap ≥ 10% for 60 min"],
    [load(when("gpuUtilPercent", ">=", 80)), "On load · GPU util ≥ 80%"],
    [load(when("gpuUtilPercent", ">=", 80, 0, "1")), "On load · GPU 1 GPU util ≥ 80%"],
    [load(when("vramUsedPercent", "<=", 70, 0, "0")), "On load · GPU 0 VRAM ≤ 70%"],
    [load(when("cpuPercent", ">=", 50, 0, "0")), "On load · CPU ≥ 50%"],
    [load(when("loadPerCore", ">=", 1.5)), "On load · load/core ≥ 1.5"],
    [load(when("verdict", ">=", 1, 60)), "On load · machine stressed for 1 min"],
    [load(when("verdict", ">=", 0.5)), "On load · machine stressed"],
    [load(when("verdict", "<=", 0)), "On load · machine ok"],
    [load(when("verdict", "<=", 0.5)), "On load · machine ok"],
    [load(when("verdict", ">=", 2)), "On load · machine ≥ 2"],
    [load(when("verdict", ">=", 0)), "On load · machine ≥ 0"],
    [load(when("verdict", "<=", 1)), "On load · machine ≤ 1"],
    [
      load(when("unbucketedSharePercent", ">=", 25), when("unbucketedSharePercent", "<=", 15)),
      "On load · unbucketed share ≥ 25% · clears when unbucketed share ≤ 15%",
    ],
    [
      load(when("verdict", ">=", 1, 30), when("verdict", "<=", 0, 300)),
      "On load · machine stressed for 30 s · clears when machine ok for 5 min",
    ],
  ])("labels load schedule %# as %s", (schedule, label) => {
    expect(scheduledTaskScheduleSummary(schedule)).toBe(label);
  });

  it("names every metric without a placeholder", () => {
    for (const { metric } of LOAD_METRICS) {
      const label = scheduledTaskScheduleSummary(load(when(metric, ">=", 5)));
      expect(label).toMatch(/^On load · \S/);
      expect(label).not.toMatch(/undefined|NaN/);
    }
  });
});

describe("load schedule drafts", () => {
  it("round-trips every metric, op, sustain bound, clear and GPU id", () => {
    const schedules: ScheduledTaskLoadSchedule[] = [];
    for (const { metric } of LOAD_METRICS) {
      for (const op of [">=", "<="] as const) {
        for (const sustainSeconds of [0, 3600]) {
          schedules.push(load(when(metric, op, 12.75, sustainSeconds)));
          schedules.push(
            load(when(metric, op, 0.5, sustainSeconds), when(metric, op === ">=" ? "<=" : ">=", 3)),
          );
        }
      }
    }
    schedules.push(load(when("gpuUtilPercent", ">=", 80, 60, "gpu-1")));
    schedules.push(
      load(when("vramUsedPercent", ">=", 90, 0, "0"), when("vramUsedPercent", "<=", 70, 0, "0")),
    );
    for (const schedule of schedules) {
      expect(loadScheduleFromDraft(loadScheduleDraft(schedule))).toStrictEqual(schedule);
    }
  });

  it("keeps an odd verdict threshold's text as it is", () => {
    const schedule = load(when("verdict", ">=", 0.5));
    const draft = loadScheduleDraft(schedule);
    expect(draft.condition.threshold).toBe("0.5");
    expect(draft.clearEnabled).toBe(false);
    expect(draft.clear).toEqual(DEFAULT_LOAD_SCHEDULE_DRAFT.clear);
    expect(loadScheduleFromDraft(draft)).toStrictEqual(schedule);
  });

  const valid: LoadScheduleDraft = {
    condition: {
      metric: "cpuPercent",
      op: ">=",
      threshold: "90",
      sustainSeconds: "60",
      gpuId: "",
    },
    clearEnabled: true,
    clear: { metric: "cpuPercent", op: "<=", threshold: "50", sustainSeconds: "0", gpuId: "" },
  };
  const withCondition = (patch: Partial<LoadConditionDraft>): LoadScheduleDraft => ({
    ...valid,
    condition: { ...valid.condition, ...patch },
  });
  const withClear = (patch: Partial<LoadConditionDraft>, clearEnabled = true) => ({
    ...valid,
    clearEnabled,
    clear: { ...valid.clear, ...patch },
  });

  it.each([
    ["an empty threshold", withCondition({ threshold: "" })],
    ["a blank threshold", withCondition({ threshold: "  " })],
    ["a word threshold", withCondition({ threshold: "high" })],
    ["an infinite threshold", withCondition({ threshold: "Infinity" })],
    ["a fractional sustain", withCondition({ sustainSeconds: "1.5" })],
    ["a negative sustain", withCondition({ sustainSeconds: "-1" })],
    ["a sustain past an hour", withCondition({ sustainSeconds: "3601" })],
    ["an empty sustain", withCondition({ sustainSeconds: "" })],
    ["a bad clear threshold", withClear({ threshold: "x" })],
    ["a bad clear sustain", withClear({ sustainSeconds: "4000" })],
  ])("rejects %s", (_label, draft) => {
    expect(loadScheduleFromDraft(draft)).toBeNull();
  });

  it("ignores a bad clear while clear is off", () => {
    expect(loadScheduleFromDraft(withClear({ threshold: "x" }, false))).toStrictEqual(
      load(when("cpuPercent", ">=", 90, 60)),
    );
  });

  it("parses comma decimals and trims GPU ids, dropping them off GPU metrics", () => {
    expect(
      loadScheduleFromDraft({
        ...valid,
        clearEnabled: false,
        condition: { ...valid.condition, metric: "loadPerCore", threshold: " 8,5 ", gpuId: "0" },
      }),
    ).toStrictEqual(load(when("loadPerCore", ">=", 8.5, 60)));
    expect(
      loadScheduleFromDraft({
        ...valid,
        clearEnabled: false,
        condition: { ...valid.condition, metric: "vramUsedPercent", gpuId: "  " },
      }),
    ).toStrictEqual(load(when("vramUsedPercent", ">=", 90, 60)));
    expect(
      loadScheduleFromDraft({
        ...valid,
        clearEnabled: false,
        condition: { ...valid.condition, metric: "vramUsedPercent", gpuId: " 1 " },
      }),
    ).toStrictEqual(load(when("vramUsedPercent", ">=", 90, 60, "1")));
  });

  it("parses the default draft to an ok-machine watch", () => {
    expect(loadScheduleFromDraft(DEFAULT_LOAD_SCHEDULE_DRAFT)).toStrictEqual({
      type: "load",
      condition: { metric: "verdict", op: "<=", threshold: 0, sustainSeconds: 60 },
    });
  });

  it("sets op and threshold together from the verdict picker", () => {
    const draft = DEFAULT_LOAD_SCHEDULE_DRAFT.condition;
    expect(withLoadVerdictState(draft, "stressed")).toEqual({ ...draft, op: ">=", threshold: "1" });
    expect(withLoadVerdictState({ ...draft, op: ">=", threshold: "1" }, "ok")).toEqual({
      ...draft,
      op: "<=",
      threshold: "0",
    });
  });

  it("carries what still applies when the metric changes", () => {
    const cpu = valid.condition;
    expect(withLoadMetric(cpu, "cpuPercent")).toBe(cpu);
    expect(withLoadMetric(cpu, "verdict")).toEqual({
      ...cpu,
      metric: "verdict",
      op: ">=",
      threshold: "1",
    });
    expect(withLoadMetric({ ...cpu, op: "<=" }, "verdict")).toMatchObject({
      op: "<=",
      threshold: "0",
    });
    const verdict = DEFAULT_LOAD_SCHEDULE_DRAFT.condition;
    expect(withLoadMetric(verdict, "memoryUsedPercent")).toEqual({
      ...verdict,
      metric: "memoryUsedPercent",
      threshold: "",
    });
    expect(withLoadMetric(cpu, "memoryUsedPercent")).toEqual({
      ...cpu,
      metric: "memoryUsedPercent",
    });
    const gpu = { ...cpu, metric: "gpuUtilPercent" as const, gpuId: "1" };
    expect(withLoadMetric(gpu, "vramUsedPercent")).toEqual({ ...gpu, metric: "vramUsedPercent" });
    expect(withLoadMetric(gpu, "cpuPercent")).toEqual({ ...gpu, metric: "cpuPercent", gpuId: "" });
  });
});
