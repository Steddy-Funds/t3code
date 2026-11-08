import { describe, expect, it } from "vite-plus/test";

import { niceScale } from "./niceScale";

describe("niceScale", () => {
  it.each([
    { peak: 0, count: 4, max: 0, ticks: [0] },
    { peak: -5, count: 4, max: 0, ticks: [0] },
    { peak: 100, count: 4, max: 100, ticks: [0, 50, 100] },
    { peak: 37, count: 4, max: 40, ticks: [0, 10, 20, 30, 40] },
    { peak: 7, count: 4, max: 8, ticks: [0, 2, 4, 6, 8] },
    { peak: 4, count: 4, max: 4, ticks: [0, 1, 2, 3, 4] },
    { peak: 0.37, count: 4, max: 0.4, ticks: [0, 0.1, 0.2, 0.3, 0.4] },
    { peak: 2300, count: 4, max: 3000, ticks: [0, 1000, 2000, 3000] },
  ])("peak $peak over $count ticks tops out at $max", ({ peak, count, max, ticks }) => {
    const scale = niceScale(peak, count);
    expect(scale.max).toBeCloseTo(max, 10);
    expect(scale.ticks).toHaveLength(ticks.length);
    scale.ticks.forEach((tick, index) => expect(tick).toBeCloseTo(ticks[index] ?? Number.NaN, 10));
  });

  it("always covers the peak with ticks from 0 to max", () => {
    for (const peak of [0.003, 1, 9.99, 12, 55, 101, 999, 86_400]) {
      const { max, ticks } = niceScale(peak, 4);
      expect(max).toBeGreaterThanOrEqual(peak);
      expect(ticks[0]).toBe(0);
      expect(ticks.at(-1)).toBeCloseTo(max, 10);
    }
  });
});
