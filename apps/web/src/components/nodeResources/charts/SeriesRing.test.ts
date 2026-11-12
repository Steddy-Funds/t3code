import { describe, expect, it, vi } from "vite-plus/test";

import { CellPool } from "./CellPool";
import { CHART_SAMPLES, SeriesRing } from "./SeriesRing";

function columnOf(ring: SeriesRing, column: number): number[] {
  return Array.from({ length: ring.length }, (_, index) => ring.valueAt(column, index));
}

function timesOf(ring: SeriesRing): number[] {
  return Array.from({ length: ring.length }, (_, index) => ring.timeAt(index));
}

describe("SeriesRing", () => {
  it("defaults to one column of CHART_SAMPLES and starts empty", () => {
    const ring = SeriesRing.create();
    expect(ring.columns).toBe(1);
    expect(ring.capacity).toBe(CHART_SAMPLES);
    expect(ring.length).toBe(0);
    expect(ring.spanMs).toBe(0);
    expect(ring.latest()).toBeNaN();
  });

  it("keeps the newest rows in order once pushes wrap past capacity", () => {
    const ring = SeriesRing.create({ columns: 2, capacity: 3 });
    for (let tick = 1; tick <= 5; tick++) ring.push([tick, tick * 10], tick * 1000);

    expect(ring.length).toBe(3);
    expect(columnOf(ring, 0)).toEqual([3, 4, 5]);
    expect(columnOf(ring, 1)).toEqual([30, 40, 50]);
    expect(timesOf(ring)).toEqual([3000, 4000, 5000]);
    expect(ring.spanMs).toBe(2000);
    expect(ring.latest(0)).toBe(5);
    expect(ring.latest(1)).toBe(50);
  });

  it("stores a missing column in a pushed row as NaN", () => {
    const ring = SeriesRing.create({ columns: 3 });
    ring.push([1], 1000);
    expect(ring.latest(0)).toBe(1);
    expect(ring.latest(1)).toBeNaN();
    expect(ring.latest(2)).toBeNaN();
  });

  it("drops a push not newer than the last sample, without notifying", () => {
    const ring = SeriesRing.create();
    ring.push([1], 2000);
    const listener = vi.fn();
    using _subscription = { [Symbol.dispose]: ring.subscribe(listener) };

    ring.push([2], 2000);
    ring.push([3], 1000);

    expect(listener).not.toHaveBeenCalled();
    expect(columnOf(ring, 0)).toEqual([1]);
    expect(timesOf(ring)).toEqual([2000]);
  });

  it("notifies once per push and stops after unsubscribe", () => {
    const ring = SeriesRing.create();
    const listener = vi.fn();
    const unsubscribe = ring.subscribe(listener);

    ring.push([1], 1000);
    ring.push([2], 2000);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    ring.push([3], 3000);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("seeds history with timestamps stepping back from the end", () => {
    const ring = SeriesRing.create({ capacity: 10 });
    ring.seed([[1, 2, 3, 4]], 5000, 100_000);

    expect(columnOf(ring, 0)).toEqual([1, 2, 3, 4]);
    expect(timesOf(ring)).toEqual([85_000, 90_000, 95_000, 100_000]);
    expect(ring.spanMs).toBe(15_000);
  });

  it("seed keeps only the newest capacity samples", () => {
    const ring = SeriesRing.create({ capacity: 3 });
    ring.seed([[1, 2, 3, 4, 5]], 1000, 10_000);

    expect(columnOf(ring, 0)).toEqual([3, 4, 5]);
    expect(timesOf(ring)).toEqual([8000, 9000, 10_000]);
    expect(ring.spanMs).toBe(2000);
  });

  it("seed replaces earlier contents, including after a wrap", () => {
    const ring = SeriesRing.create({ capacity: 3 });
    for (let tick = 1; tick <= 4; tick++) ring.push([tick], tick * 1000);

    ring.seed([[7, 8]], 1000, 50_000);

    expect(columnOf(ring, 0)).toEqual([7, 8]);
    expect(timesOf(ring)).toEqual([49_000, 50_000]);
  });

  it("seed fills the tail of a short column and a missing column with NaN", () => {
    const ring = SeriesRing.create({ columns: 3, capacity: 10 });
    ring.seed([[1, 2, 3], [9]], 1000, 3000);

    expect(ring.length).toBe(3);
    expect(columnOf(ring, 0)).toEqual([1, 2, 3]);
    expect(columnOf(ring, 1)).toEqual([9, Number.NaN, Number.NaN]);
    expect(columnOf(ring, 2)).toEqual([Number.NaN, Number.NaN, Number.NaN]);
  });

  it("a live push after the seed appends, and one overlapping the seed is dropped", () => {
    const ring = SeriesRing.create({ capacity: 4 });
    ring.seed([[1, 2, 3]], 1000, 3000);

    ring.push([99], 3000);
    ring.push([4], 4000);
    ring.push([5], 5000);

    expect(columnOf(ring, 0)).toEqual([2, 3, 4, 5]);
    expect(timesOf(ring)).toEqual([2000, 3000, 4000, 5000]);
  });

  it("seed notifies once, even with no history", () => {
    const ring = SeriesRing.create();
    const listener = vi.fn();
    using _subscription = { [Symbol.dispose]: ring.subscribe(listener) };

    ring.seed([[1, 2, 3]], 1000, 3000);
    expect(listener).toHaveBeenCalledTimes(1);

    ring.seed([], 1000, 3000);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(ring.length).toBe(0);
  });

  it("clear empties the ring and notifies only when it held samples", () => {
    const ring = SeriesRing.create();
    const listener = vi.fn();
    using _subscription = { [Symbol.dispose]: ring.subscribe(listener) };

    ring.clear();
    expect(listener).not.toHaveBeenCalled();

    ring.push([1], 1000);
    ring.clear();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(ring.length).toBe(0);
    expect(ring.latest()).toBeNaN();

    // A cleared ring accepts any timestamp again.
    ring.push([2], 500);
    expect(columnOf(ring, 0)).toEqual([2]);
  });
});

describe("CellPool", () => {
  it("notifies when the total or a segment changes, and not when both are unchanged", () => {
    const pool = CellPool.create();
    const listener = vi.fn();
    using _subscription = { [Symbol.dispose]: pool.subscribe(listener) };

    pool.set(16, [{ cells: 4, color: "--primary" }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(pool.total).toBe(16);
    expect(pool.segments).toEqual([{ cells: 4, color: "--primary" }]);

    // A fresh but equal segments array is the same pool.
    pool.set(16, [{ cells: 4, color: "--primary" }]);
    expect(listener).toHaveBeenCalledTimes(1);

    pool.set(16, [{ cells: 5, color: "--primary" }]);
    pool.set(16, [{ cells: 5, color: "--warning" }]);
    pool.set(16, [
      { cells: 5, color: "--warning" },
      { cells: 1, color: "--primary" },
    ]);
    pool.set(32, [
      { cells: 5, color: "--warning" },
      { cells: 1, color: "--primary" },
    ]);
    expect(listener).toHaveBeenCalledTimes(5);
  });

  it("rounds the total and clamps it at zero", () => {
    const pool = CellPool.create();
    const listener = vi.fn();
    using _subscription = { [Symbol.dispose]: pool.subscribe(listener) };

    pool.set(15.6, []);
    expect(pool.total).toBe(16);
    pool.set(16.2, []);
    expect(listener).toHaveBeenCalledTimes(1);

    pool.set(-3, []);
    expect(pool.total).toBe(0);
  });

  it("stops notifying after unsubscribe", () => {
    const pool = CellPool.create();
    const listener = vi.fn();
    pool.subscribe(listener)();
    pool.set(8, []);
    expect(listener).not.toHaveBeenCalled();
  });
});
