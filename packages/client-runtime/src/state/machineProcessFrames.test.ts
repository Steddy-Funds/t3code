import type { MachineProcessAdded, MachineProcessFrame } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createMachineProcessFrameApplier } from "./machineProcessFrames.ts";

function added(key: number, pid = key + 100): MachineProcessAdded {
  return { key, pid, ppid: 1, startTimeMs: 0, name: `p${pid}`, user: "", command: `p${pid}` };
}

function frame(
  overrides: Partial<MachineProcessFrame> & { readonly values?: ReadonlyArray<[number, number]> },
): MachineProcessFrame {
  const { values = [], ...rest } = overrides;
  return {
    generation: 0,
    full: false,
    sequence: 0,
    sampleAgeMs: 0,
    source: "t3",
    added: [],
    removed: [],
    rows: {
      key: values.map(([key]) => key),
      cpu: values.map(([, cpu]) => cpu),
      rss: values.map(([, cpu]) => cpu * 10),
    },
    ...rest,
  };
}

const full = (sequence: number, keys: ReadonlyArray<number>, generation = 0) =>
  frame({
    generation,
    full: true,
    sequence,
    added: keys.map((key) => added(key)),
    values: keys.map((key) => [key, key + 1]),
  });

const view = (table: ReturnType<ReturnType<typeof createMachineProcessFrameApplier>["apply"]>) =>
  table?.rows.map((row) => [row.key, row.cpu, row.rss]);

describe("createMachineProcessFrameApplier", () => {
  it("replaces the table on a full frame", () => {
    const { apply } = createMachineProcessFrameApplier();
    expect(view(apply(full(0, [0, 1])))).toEqual([
      [0, 1, 10],
      [1, 2, 20],
    ]);
    const replaced = apply({ ...full(1, [5]), truncated: 7 });
    expect(view(replaced)).toEqual([[5, 6, 60]]);
    expect(replaced).toMatchObject({ generation: 0, sequence: 1, truncated: 7, source: "t3" });
  });

  it("holds a split full frame until its last part and keeps the previous table meanwhile", () => {
    const { apply } = createMachineProcessFrameApplier();
    apply(full(0, [0]));
    expect(apply({ ...full(1, [1, 2]), complete: false })).toBeNull();
    // A diff arriving mid-split cannot apply to either table.
    expect(apply(frame({ sequence: 2, values: [[0, 50]] }))).toBeNull();
    const done = apply({ ...full(2, [3]), complete: true });
    expect(view(done)).toEqual([
      [1, 2, 20],
      [2, 3, 30],
      [3, 4, 40],
    ]);
    expect(done?.sequence).toBe(2);
  });

  it("applies adds, removes and new values from a diff", () => {
    const { apply } = createMachineProcessFrameApplier();
    apply(full(0, [0, 1]));
    const next = apply(
      frame({
        sequence: 1,
        sampleAgeMs: 300,
        added: [added(2)],
        removed: [0],
        values: [
          [1, 9],
          [2, 4],
        ],
      }),
    );
    expect(view(next)).toEqual([
      [1, 9, 90],
      [2, 4, 40],
    ]);
    expect(next).toMatchObject({ sequence: 1, sampleAgeMs: 300, truncated: 0 });
    expect(next?.rows[1]).toMatchObject({ pid: 102, name: "p102" });
  });

  it("skips a row whose key it never received", () => {
    const { apply } = createMachineProcessFrameApplier();
    apply(full(0, [0]));
    expect(
      view(
        apply(
          frame({
            sequence: 1,
            values: [
              [0, 3],
              [42, 99],
            ],
          }),
        ),
      ),
    ).toEqual([[0, 3, 30]]);
  });

  it.each([
    { label: "a stale sequence", diff: frame({ sequence: 1, values: [[0, 50]] }) },
    { label: "a repeated sequence", diff: frame({ sequence: 2, values: [[0, 50]] }) },
    { label: "another generation", diff: frame({ generation: 1, sequence: 3, values: [[0, 50]] }) },
  ])("ignores a diff with $label", ({ diff }) => {
    const { apply } = createMachineProcessFrameApplier();
    apply(full(2, [0]));
    expect(apply(diff)).toBeNull();
    expect(view(apply(frame({ sequence: 3, values: [[0, 7]] })))).toEqual([[0, 7, 70]]);
  });

  it("ignores a diff before any full frame", () => {
    const { apply } = createMachineProcessFrameApplier();
    expect(apply(frame({ sequence: 0, added: [added(0)], values: [[0, 1]] }))).toBeNull();
  });

  it("keeps GPU values through diffs that carry no GPU columns", () => {
    const { apply } = createMachineProcessFrameApplier();
    const gpu = (table: ReturnType<typeof apply>) =>
      table?.rows.map((row) => [row.key, row.gpuUtil, row.vram]);
    const first = full(0, [0, 1]);
    const withGpu = apply({
      ...first,
      rows: { ...first.rows, gpuUtil: [40, null], vram: [2048, null] },
    });
    expect(gpu(withGpu)).toEqual([
      [0, 40, 2048],
      [1, null, null],
    ]);

    // The host sends GPU columns less often than CPU; the last measured values stay.
    const cpuOnly = apply(frame({ sequence: 1, values: [[0, 9]] }));
    expect(view(cpuOnly)).toEqual([
      [0, 9, 90],
      [1, 2, 20],
    ]);
    expect(gpu(cpuOnly)).toEqual([
      [0, 40, 2048],
      [1, null, null],
    ]);

    const next = frame({ sequence: 2, values: [[1, 3]] });
    expect(gpu(apply({ ...next, rows: { ...next.rows, gpuUtil: [75], vram: [512] } }))).toEqual([
      [0, 40, 2048],
      [1, 75, 512],
    ]);
  });

  it("leaves GPU fields off rows when the stream never carries them", () => {
    const { apply } = createMachineProcessFrameApplier();
    const table = apply(full(0, [0]));
    expect(table?.rows[0]).not.toHaveProperty("gpuUtil");
    expect(table?.rows[0]).not.toHaveProperty("vram");
  });

  it("starts a new generation from its full frame", () => {
    const { apply } = createMachineProcessFrameApplier();
    apply(full(4, [0, 1]));
    expect(view(apply(full(0, [0], 1)))).toEqual([[0, 1, 10]]);
    expect(view(apply(frame({ generation: 1, sequence: 1, values: [[0, 2]] })))).toEqual([
      [0, 2, 20],
    ]);
  });
});
