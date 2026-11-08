import { memoryUsedPercent } from "@t3tools/client-runtime/state/machineFormat";
import { decodeMachineHistory } from "@t3tools/client-runtime/state/machineHistory";
import type { GpuDeviceSample, MachineStatusSnapshot } from "@t3tools/contracts";

import { CellPool, type CellPoolSegment } from "../charts/CellPool";
import { OTHER_OWNER_COLOR } from "../ownership/processOwners";
import { SeriesRing } from "../charts/SeriesRing";
import { resampleSeries, vramTotal } from "../crossMachine/crossMachineModel";

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
  readonly rangeMs: number;
  readonly cpu: SeriesRing;
  readonly memory: SeriesRing;
  readonly load: SeriesRing;
  readonly gpu: SeriesRing;
  readonly cores: SeriesRing;
  readonly memoryPool: CellPool;
  readonly vramPool: CellPool;
  /** The history last seeded; a shared stream repeats it on every snapshot. */
  seededFrom: MachineStatusSnapshot["history"];
  /** The latest memory totals, so a process frame can recolour the pool between snapshots. */
  memoryUsage: { readonly totalBytes: number; readonly usedBytes: number } | null;
  /** The top memory owners from the process stream; null draws used memory in one colour. */
  memoryOwners: ReadonlyArray<MemoryOwnerShare> | null;
}

export interface MemoryOwnerShare {
  readonly bytes: number;
  /** A CSS custom property, such as `--owner-1`. */
  readonly color: string;
}

/** Graph rings hold `rangeMs / tickMs` points, so the graphs span the chosen range at any tick. */
export function createMachineSeries(tickMs: number, rangeMs: number, cores: number): MachineSeries {
  const capacity = Math.round(rangeMs / tickMs);
  return {
    tickMs,
    rangeMs,
    cpu: SeriesRing.create({ capacity }),
    memory: SeriesRing.create({ columns: 2, capacity }),
    load: SeriesRing.create({ capacity }),
    gpu: SeriesRing.create({ columns: 2, capacity }),
    cores: SeriesRing.create({ columns: Math.max(1, cores), capacity: CORE_SAMPLES }),
    memoryPool: CellPool.create(),
    vramPool: CellPool.create(),
    seededFrom: undefined,
    memoryUsage: null,
    memoryOwners: null,
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
  if (!snapshot.history || snapshot.history === series.seededFrom) return;
  series.seededFrom = snapshot.history;
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

/** Folds one snapshot in: each new history seeds every ring once, then each sample appends a row. */
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

  series.memoryUsage = {
    totalBytes: totals.memoryTotalBytes,
    usedBytes: Math.max(0, totals.memoryTotalBytes - totals.memoryAvailableBytes),
  };
  fillMemoryPool(series);
  const vram = vramTotal(snapshot.sample?.gpus);
  if (vram) {
    const vramCell = poolCellBytes(vram.totalBytes, VRAM_CELL_BYTES);
    series.vramPool.set(vram.totalBytes / vramCell, [
      { cells: Math.round(vram.usedBytes / vramCell), color: "--primary" },
    ]);
  }
}

/** Recolours used memory by owner from a process frame; null returns it to one colour. */
export function setMemoryOwners(
  series: MachineSeries,
  owners: ReadonlyArray<MemoryOwnerShare> | null,
): void {
  series.memoryOwners = owners;
  fillMemoryPool(series);
}

function fillMemoryPool(series: MachineSeries): void {
  if (series.memoryUsage === null) return;
  const { totalBytes, usedBytes } = series.memoryUsage;
  const cell = poolCellBytes(totalBytes, GIB);
  series.memoryPool.set(totalBytes / cell, memorySegments(usedBytes, cell, series.memoryOwners));
}

/**
 * Used memory split by owner: each top owner, then "other" for everything else in use (other
 * processes, the kernel, shared pages). Resident sizes count shared pages once per process, so
 * owners that sum past used memory are scaled down to fit it.
 */
export function memorySegments(
  usedBytes: number,
  cellBytes: number,
  owners: ReadonlyArray<MemoryOwnerShare> | null,
): CellPoolSegment[] {
  const usedCells = Math.round(usedBytes / cellBytes);
  if (owners === null || owners.length === 0) return [{ cells: usedCells, color: "--primary" }];
  const ownerBytes = owners.reduce((sum, owner) => sum + owner.bytes, 0);
  const scale = ownerBytes > usedBytes ? usedBytes / ownerBytes : 1;
  const segments: CellPoolSegment[] = [];
  let assigned = 0;
  for (const owner of owners) {
    const cells = Math.min(Math.round((owner.bytes * scale) / cellBytes), usedCells - assigned);
    if (cells <= 0) continue;
    segments.push({ cells, color: owner.color });
    assigned += cells;
  }
  if (usedCells > assigned)
    segments.push({ cells: usedCells - assigned, color: OTHER_OWNER_COLOR });
  return segments;
}

/** The core count a snapshot reports, from history or the live sample; 0 before either. */
export function snapshotCores(snapshot: MachineStatusSnapshot): number {
  return snapshot.history?.cores ?? snapshot.sample?.perCore.length ?? 0;
}

/** A GPU graph and pool only for hosts with a device that can be read; driverless hosts get none. */
export function hasReadableGpu(snapshot: MachineStatusSnapshot | null): boolean {
  return (snapshot?.sample?.gpus ?? []).some((gpu) => gpu.status !== "unavailable");
}
