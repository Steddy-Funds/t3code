import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type MachineHistory } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { decodeMachineHistory } from "./machineHistory.ts";
import { createMachineResourcesAtoms } from "./machineResources.ts";

const history = (overrides: Partial<MachineHistory> = {}): MachineHistory => ({
  stepMs: 5_000,
  count: 3,
  endAgeMs: 2_500,
  cpu: [0, 505, 1000],
  perCore: [100, 200, -1, -1, 300, 400],
  cores: 2,
  memoryUsed: [750, -1, 750],
  swapUsed: [-1, -1, 10],
  load1: [1.5, -1, 0],
  gpus: [{ id: "a", util: [-1, -1, 300], vramUsed: [-1, -1, 990] }],
  ...overrides,
});

const values = (series: Float32Array) => Array.from(series);

describe("decodeMachineHistory", () => {
  it("turns permille into percent and -1 into NaN, every series count long", () => {
    const decoded = decodeMachineHistory(history(), 100_000);
    expect(decoded.stepMs).toBe(5_000);
    expect(decoded.endAtMs).toBe(97_500);
    expect(values(decoded.cpu)).toEqual([0, Math.fround(50.5), 100]);
    expect(decoded.perCore.map(values)).toEqual([
      [10, Number.NaN, 30],
      [20, Number.NaN, 40],
    ]);
    expect(values(decoded.memoryUsed)).toEqual([75, Number.NaN, 75]);
    expect(values(decoded.swapUsed)).toEqual([Number.NaN, Number.NaN, 1]);
    expect(values(decoded.load1)).toEqual([1.5, Number.NaN, 0]);
    expect(decoded.gpus).toEqual([
      {
        id: "a",
        util: new Float32Array([Number.NaN, Number.NaN, 30]),
        vramUsed: new Float32Array([Number.NaN, Number.NaN, 99]),
      },
    ]);
  });

  it("pads short columns with NaN and ignores extra entries", () => {
    const decoded = decodeMachineHistory(
      history({
        cpu: [100],
        perCore: [100, 200, 300],
        memoryUsed: [1, 2, 3, 4],
        swapUsed: [],
        load1: [2],
        gpus: [{ id: "a", util: [10], vramUsed: [] }],
      }),
      0,
    );
    expect(values(decoded.cpu)).toEqual([10, Number.NaN, Number.NaN]);
    expect(decoded.perCore.map(values)).toEqual([
      [10, 30, Number.NaN],
      [20, Number.NaN, Number.NaN],
    ]);
    expect(values(decoded.memoryUsed)).toEqual([0.1, 0.2, 0.3].map(Math.fround));
    expect(values(decoded.swapUsed)).toEqual([Number.NaN, Number.NaN, Number.NaN]);
    expect(values(decoded.load1)).toEqual([2, Number.NaN, Number.NaN]);
    expect(decoded.gpus[0]!.util).toHaveLength(3);
    expect(decoded.gpus[0]!.vramUsed).toHaveLength(3);
  });

  it("decodes an empty history to empty series", () => {
    const decoded = decodeMachineHistory(
      history({
        count: 0,
        endAgeMs: 0,
        cpu: [],
        perCore: [],
        cores: 0,
        memoryUsed: [],
        swapUsed: [],
        load1: [],
        gpus: [],
      }),
      42,
    );
    expect(decoded).toMatchObject({ endAtMs: 42, perCore: [], gpus: [] });
    expect(decoded.cpu).toHaveLength(0);
  });
});

describe("createMachineResourcesAtoms machine", () => {
  const environmentId = EnvironmentId.make("env-1");
  const { machine } = createMachineResourcesAtoms(
    Atom.runtime(
      Layer.succeed(
        EnvironmentRegistry.EnvironmentRegistry,
        {} as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"],
      ),
    ),
  );

  it("shares the status atom for a status-only input", () => {
    expect(machine(environmentId)).toBe(machine(environmentId, {}));
    expect(machine(environmentId).idleTTL).toBe(60_000);
  });

  it.each([
    ["history", { historyMs: 60_000 }],
    ["samples", { intervalMs: 1_000 }],
    ["both", { intervalMs: 1_000, historyMs: 60_000 }],
  ] as const)("uses the live atom when asking for %s", (_name, input) => {
    const atom = machine(environmentId, input);
    expect(atom).not.toBe(machine(environmentId));
    expect(atom.idleTTL).toBe(0);
  });
});
