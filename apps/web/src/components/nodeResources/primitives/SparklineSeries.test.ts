import { describe, expect, it } from "vite-plus/test";

import { sparklineColumns } from "./SparklineSeries";

const STEP = 30_000;
const CAPACITY = 10;

interface Point {
  readonly ageMs: number;
  readonly cpu: number | null;
  readonly memory: number | null;
}

const point = (ageMs: number, cpu: number | null, memory: number | null = cpu): Point => ({
  ageMs,
  cpu,
  memory,
});

const readers = [(p: Point) => p.cpu, (p: Point) => p.memory];

/** Slot → value for the slots that hold a reading. */
const filled = (column: Float32Array) =>
  Object.fromEntries(
    [...column].flatMap((value, slot) => (Number.isNaN(value) ? [] : [[slot, value]])),
  );

describe("sparklineColumns", () => {
  it("gives one capacity-long column per reader, all NaN without points", () => {
    const columns = sparklineColumns<Point>([], readers, CAPACITY, STEP);
    expect(columns).toHaveLength(2);
    for (const column of columns) {
      expect(column).toHaveLength(CAPACITY);
      expect(filled(column)).toEqual({});
    }
  });

  it.each<[string, number, number | null]>([
    ["age 0 is the newest slot", 0, CAPACITY - 1],
    ["one step back", STEP, CAPACITY - 2],
    ["just under half a step rounds to the newest slot", STEP / 2 - 1, CAPACITY - 1],
    ["half a step rounds back a slot", STEP / 2, CAPACITY - 2],
    ["the window edge is the oldest slot", (CAPACITY - 1) * STEP, 0],
    ["half a step past the edge is dropped", (CAPACITY - 1) * STEP + STEP / 2, null],
    ["a full window back is dropped", CAPACITY * STEP, null],
  ])("%s", (_name, ageMs, slot) => {
    const [cpu] = sparklineColumns([point(ageMs, 7)], readers, CAPACITY, STEP);
    expect(filled(cpu!)).toEqual(slot === null ? {} : { [slot]: 7 });
  });

  it("leaves NaN between points so a gap breaks the line", () => {
    const [cpu] = sparklineColumns(
      [point(0, 3), point(STEP, 2), point(4 * STEP, 1)],
      readers,
      CAPACITY,
      STEP,
    );
    expect(filled(cpu!)).toEqual({ 9: 3, 8: 2, 5: 1 });
    expect(Number.isNaN(cpu![7])).toBe(true);
  });

  it("reads each column with its own reader and a null reading is NaN in that column only", () => {
    const [cpu, memory] = sparklineColumns(
      [point(0, 12.5, 2048), point(STEP, null, 1024)],
      readers,
      CAPACITY,
      STEP,
    );
    expect(filled(cpu!)).toEqual({ 9: 12.5 });
    expect(filled(memory!)).toEqual({ 9: 2048, 8: 1024 });
  });

  it("keeps a zero reading", () => {
    const [cpu] = sparklineColumns([point(0, 0)], readers, CAPACITY, STEP);
    expect(filled(cpu!)).toEqual({ 9: 0 });
  });
});
