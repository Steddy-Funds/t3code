import type { MachineHistory } from "@t3tools/contracts";

/** One series per column, oldest first, every column `count` long; NaN where a tick had no reading. */
export interface DecodedMachineHistory {
  readonly stepMs: number;
  /** When the newest entry was sampled, on the receiving client's clock. */
  readonly endAtMs: number;
  /** Percent 0–100. */
  readonly cpu: Float32Array;
  /** Percent 0–100, one series per core. */
  readonly perCore: ReadonlyArray<Float32Array>;
  /** Percent of total memory. */
  readonly memoryUsed: Float32Array;
  /** Percent of total swap. */
  readonly swapUsed: Float32Array;
  readonly load1: Float32Array;
  readonly gpus: ReadonlyArray<{
    readonly id: string;
    /** Percent 0–100. */
    readonly util: Float32Array;
    /** Percent of the device's VRAM. */
    readonly vramUsed: Float32Array;
  }>;
}

const fromPermille = (values: ReadonlyArray<number>, count: number) => {
  const series = new Float32Array(count).fill(Number.NaN);
  for (let index = 0; index < Math.min(count, values.length); index++) {
    const value = values[index]!;
    if (value >= 0) series[index] = value / 10;
  }
  return series;
};

/**
 * Decodes a snapshot's history for `SeriesRing.seed(columns, stepMs, endAtMs)`. Every series is
 * full length, so a seeded ring keeps the columns aligned in time.
 */
export function decodeMachineHistory(
  history: MachineHistory,
  receivedAtMs: number,
): DecodedMachineHistory {
  const { count, cores } = history;
  const perCore = Array.from({ length: cores }, () => new Float32Array(count).fill(Number.NaN));
  for (let index = 0; index < count; index++) {
    for (let core = 0; core < cores; core++) {
      const value = history.perCore[index * cores + core] ?? -1;
      if (value >= 0) perCore[core]![index] = value / 10;
    }
  }
  const load1 = new Float32Array(count).fill(Number.NaN);
  for (let index = 0; index < Math.min(count, history.load1.length); index++) {
    const value = history.load1[index]!;
    if (value >= 0) load1[index] = value;
  }
  return {
    stepMs: history.stepMs,
    endAtMs: receivedAtMs - history.endAgeMs,
    cpu: fromPermille(history.cpu, count),
    perCore,
    memoryUsed: fromPermille(history.memoryUsed, count),
    swapUsed: fromPermille(history.swapUsed, count),
    load1,
    gpus: history.gpus.map((gpu) => ({
      id: gpu.id,
      util: fromPermille(gpu.util, count),
      vramUsed: fromPermille(gpu.vramUsed, count),
    })),
  };
}
