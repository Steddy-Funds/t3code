import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("never schedules a clock run for a load task", () => {
    expect(
      nextScheduledRunAt(
        {
          type: "load",
          condition: { metric: "cpuPercent", op: ">=", threshold: 90, sustainSeconds: 60 },
        },
        DateTime.makeUnsafe("2026-11-08T00:00:00.000Z"),
      ),
    ).toBeNull();
  });

  it("treats a load schedule as changed when any condition field differs", () => {
    const condition = {
      metric: "gpuUtilPercent",
      op: ">=",
      threshold: 90,
      sustainSeconds: 60,
      gpuId: "gpu-0",
    } as const;
    const clear = { ...condition, op: "<=", threshold: 20 } as const;
    const base = { type: "load", condition, clear } as const;
    expect(
      isSameSchedule(base, { type: "load", condition: { ...condition }, clear: { ...clear } }),
    ).toBe(true);
    const { gpuId: _gpuId, ...anyGpu } = condition;
    expect(
      isSameSchedule(
        { type: "load", condition: anyGpu },
        { type: "load", condition: { ...anyGpu } },
      ),
    ).toBe(true);
    for (const changed of [
      { ...base, condition: { ...condition, metric: "vramUsedPercent" } },
      { ...base, condition: { ...condition, op: "<=" } },
      { ...base, condition: { ...condition, threshold: 91 } },
      { ...base, condition: { ...condition, sustainSeconds: 0 } },
      { ...base, condition: anyGpu },
      { ...base, condition: { ...condition, gpuId: "gpu-1" } },
      { ...base, clear: { ...clear, threshold: 30 } },
      { type: "load", condition },
    ] as const) {
      expect(isSameSchedule(base, changed)).toBe(false);
      expect(isSameSchedule(changed, base)).toBe(false);
    }
    expect(isSameSchedule(base, { type: "interval", everyMs: 60_000 })).toBe(false);
    expect(isSameSchedule({ type: "interval", everyMs: 60_000 }, base)).toBe(false);
    expect(isSameSchedule({ type: "webhook", signature: null }, base)).toBe(false);
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule(
        { type: "once", runAt: "2026-11-01T03:00:00-05:00" },
        { type: "once", runAt: "2026-11-01T08:00:00.000Z" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });
});
