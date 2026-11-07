import { memoryUsedPercent } from "@t3tools/client-runtime/state/machineFormat";
import { decodeMachineHistory } from "@t3tools/client-runtime/state/machineHistory";
import type { GpuDeviceSample, MachineStatusSnapshot } from "@t3tools/contracts";

import { CellPool } from "../charts/CellPool";
import { SeriesRing } from "../charts/SeriesRing";
import { resampleSeries, vramTotal } from "../crossMachine/crossMachineModel";

export const GRAPH_HISTORY_MS = 900_000;
/** The core grid draws the last W points of every core, so 64 cores stay cheap at a fast tick. */
const CORE_SAMPLES = 120;
const POOL_MAX_CELLS = 128;
const GIB = 1024 ** 3;
const VRAM_CELL_BYTES = 256 * 1024 ** 2;

export const MEMORY_COLUMN = { used: 0, swap: 1 } as const;
export const GPU_COLUMN = { util: 0, vram: 1 } as const;

/** Everything the overview draws, kept outside React; fed from the stream, never from render. */
export interface MachineSeries {
  readonly tickMs: number;
  readonly cpu: SeriesRing;
  readonly memory: SeriesRing;
  readonly load: SeriesRing;
  readonly gpu: SeriesRing;
  readonly cores: SeriesRing;
  readonly memoryPool: CellPool;
  readonly vramPool: CellPool;
}

export function createMachineSeries(tickMs: number, cores: number): MachineSeries {
  const capacity = Math.round(GRAPH_HISTORY_MS / tickMs);
  return {
    tickMs,
    cpu: SeriesRing.create({ capacity }),
    memory: SeriesRing.create({ columns: 2, capacity }),
    load: SeriesRing.create({ capacity }),
    gpu: SeriesRing.create({ columns: 2, capacity }),
    cores: SeriesRing.create({ columns: Math.max(1, cores), capacity: CORE_SAMPLES }),
    memoryPool: CellPool.create(),
    vramPool: CellPool.create(),
  };
}

/** The newest reading across devices, so the device that trips a GPU rule is the one drawn. */
function peak(values: ReadonlyArray<number | null>): number {
  let top = Number.NaN;
  for (const value of values) {
    if (value === null || Number.isNaN(value)) continue;
    if (Number.isNaN(top) || value > top) top = value;
  }
  return top;
}

function peakSeries(series: ReadonlyArray<Float32Array>, length: number): Float32Array {
  const output = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    output[index] = peak(series.map((values) => values[index] ?? Number.NaN));
  }
  return output;
}

export function gpuReadings(gpus: ReadonlyArray<GpuDeviceSample> | undefined): {
  readonly util: number;
  readonly vramPercent: number;
} {
  const active = (gpus ?? []).filter((gpu) => gpu.status === "active");
  return {
    util: peak(active.map((gpu) => gpu.utilPercent)),
    vramPercent: peak(
      active.map((gpu) =>
        gpu.vramUsedBytes === null || !gpu.vramTotalBytes
          ? null
          : (gpu.vramUsedBytes / gpu.vramTotalBytes) * 100,
      ),
    ),
  };
}

/** A unit that keeps a pool at or under 128 cells: `base` doubled as often as needed. */
export function poolCellBytes(totalBytes: number, base: number): number {
  let unit = base;
  while (totalBytes / unit > POOL_MAX_CELLS) unit *= 2;
  return unit;
}

function seedHistory(series: MachineSeries, snapshot: MachineStatusSnapshot, receivedAtMs: number) {
  if (!snapshot.history) return;
  const history = decodeMachineHistory(snapshot.history, receivedAtMs);
  const length = history.cpu.length;
  const cores = Math.max(1, snapshot.history.cores);
  const seed = (ring: SeriesRing, columns: ReadonlyArray<Float32Array>) =>
    ring.seed(
      resampleSeries(columns, history.stepMs, series.tickMs),
      series.tickMs,
      history.endAtMs,
    );
  seed(series.cpu, [history.cpu]);
  seed(series.memory, [history.memoryUsed, history.swapUsed]);
  seed(series.load, [history.load1.map((value) => value / cores)]);
  seed(series.gpu, [
    peakSeries(
      history.gpus.map((gpu) => gpu.util),
      length,
    ),
    peakSeries(
      history.gpus.map((gpu) => gpu.vramUsed),
      length,
    ),
  ]);
  if (history.perCore.length === series.cores.columns) seed(series.cores, history.perCore);
}

/** Folds one snapshot in: history seeds every ring once, then each sample appends a row. */
export function receiveMachineSnapshot(
  series: MachineSeries,
  snapshot: MachineStatusSnapshot,
  receivedAtMs: number,
): void {
  seedHistory(series, snapshot, receivedAtMs);
  const totals = snapshot.totals;
  if (totals === null) return;
  const atMs = receivedAtMs - snapshot.sampleAgeMs;
  series.cpu.push(
    [totals.cpuUtilization === null ? Number.NaN : totals.cpuUtilization * 100],
    atMs,
  );
  series.memory.push(
    [
      memoryUsedPercent(totals),
      totals.swapTotalBytes > 0 ? (totals.swapUsedBytes / totals.swapTotalBytes) * 100 : 0,
    ],
    atMs,
  );
  series.load.push(
    [totals.load ? totals.load.one / Math.max(1, totals.cpuCount) : Number.NaN],
    atMs,
  );
  const gpu = gpuReadings(snapshot.sample?.gpus);
  series.gpu.push([gpu.util, gpu.vramPercent], atMs);
  const perCore = snapshot.sample?.perCore;
  if (perCore && perCore.length === series.cores.columns) series.cores.push(perCore, atMs);

  const memoryUsed = Math.max(0, totals.memoryTotalBytes - totals.memoryAvailableBytes);
  const memoryCell = poolCellBytes(totals.memoryTotalBytes, GIB);
  series.memoryPool.set(totals.memoryTotalBytes / memoryCell, [
    { cells: Math.round(memoryUsed / memoryCell), color: "--primary" },
  ]);
  const vram = vramTotal(snapshot.sample?.gpus);
  if (vram) {
    const vramCell = poolCellBytes(vram.totalBytes, VRAM_CELL_BYTES);
    series.vramPool.set(vram.totalBytes / vramCell, [
      { cells: Math.round(vram.usedBytes / vramCell), color: "--primary" },
    ]);
  }
}

/** The core count a snapshot reports, from history or the live sample; 0 before either. */
export function snapshotCores(snapshot: MachineStatusSnapshot): number {
  return snapshot.history?.cores ?? snapshot.sample?.perCore.length ?? 0;
}

/** A GPU graph and pool only for hosts with a device that can be read; driverless hosts get none. */
export function hasReadableGpu(snapshot: MachineStatusSnapshot | null): boolean {
  return (snapshot?.sample?.gpus ?? []).some((gpu) => gpu.status !== "unavailable");
}
