import type { MachineIndicatorView } from "@t3tools/client-runtime/state/machineFormat";
import type { GpuDeviceSample, MachineTotalsSummary } from "@t3tools/contracts";

/** Every row's core grid has this many cells, so the columns line up across machines. */
export const CORE_GRID_CELLS = 20;

export type CrossMachineGroup = "stressed" | "lastSeenStressed" | "byLoad" | "unknown";

export const CROSS_MACHINE_GROUPS: ReadonlyArray<CrossMachineGroup> = [
  "stressed",
  "lastSeenStressed",
  "byLoad",
  "unknown",
];

export function crossMachineGroup(view: MachineIndicatorView): CrossMachineGroup {
  if (view.unreachable)
    return view.lastSeen?.verdict === "stressed" ? "lastSeenStressed" : "unknown";
  if (view.verdict === "stressed") return "stressed";
  return view.verdict === "ok" ? "byLoad" : "unknown";
}

/** The five-minute load per core the verdict judges; null where the OS has no load average. */
export function loadPerCore(totals: MachineTotalsSummary | null): number | null {
  if (totals?.load == null) return null;
  return totals.load.five / Math.max(1, totals.cpuCount);
}

export interface CrossMachineEntry<T> {
  readonly item: T;
  readonly group: CrossMachineGroup;
  readonly load: number | null;
}

/**
 * Stressed, then unreachable machines last seen stressed, then ok by load (highest first, so the
 * machine nearest to stress sits under the stressed ones), then unknown or connecting. Stable.
 */
export function orderCrossMachines<T>(
  entries: ReadonlyArray<CrossMachineEntry<T>>,
): Array<CrossMachineEntry<T>> {
  const rank = (group: CrossMachineGroup) => CROSS_MACHINE_GROUPS.indexOf(group);
  return [...entries].sort((a, b) => {
    const byGroup = rank(a.group) - rank(b.group);
    if (byGroup !== 0 || a.group !== "byLoad") return byGroup;
    // Tenths, so a row doesn't swap places with its neighbour on every tick's noise.
    return Math.round((b.load ?? -1) * 10) - Math.round((a.load ?? -1) * 10);
  });
}

/** Up to 20 cores get a cell each; past that, each of the 20 cells averages a run of cores. */
export function coreCellCount(cores: number): number {
  return Math.min(Math.max(0, cores), CORE_GRID_CELLS);
}

function cellRange(cell: number, cells: number, cores: number): readonly [number, number] {
  return [Math.floor((cell * cores) / cells), Math.floor(((cell + 1) * cores) / cells)];
}

function average(read: (core: number) => number, start: number, end: number): number {
  let sum = 0;
  let count = 0;
  for (let core = start; core < end; core++) {
    const value = read(core);
    if (Number.isNaN(value)) continue;
    sum += value;
    count += 1;
  }
  return count === 0 ? Number.NaN : sum / count;
}

/** One live per-core row folded into `cells` values. */
export function groupCoreRow(perCore: ReadonlyArray<number>, cells: number): Float32Array {
  const row = new Float32Array(cells);
  for (let cell = 0; cell < cells; cell++) {
    const [start, end] = cellRange(cell, cells, perCore.length);
    row[cell] = average((core) => perCore[core] ?? Number.NaN, start, end);
  }
  return row;
}

/** Decoded per-core history folded into `cells` series, each as long as the input series. */
export function groupCoreSeries(
  perCore: ReadonlyArray<Float32Array>,
  cells: number,
): Array<Float32Array> {
  const length = perCore[0]?.length ?? 0;
  return Array.from({ length: cells }, (_, cell) => {
    const [start, end] = cellRange(cell, cells, perCore.length);
    const series = new Float32Array(length);
    for (let index = 0; index < length; index++) {
      series[index] = average((core) => perCore[core]?.[index] ?? Number.NaN, start, end);
    }
    return series;
  });
}

export interface VramTotal {
  readonly usedBytes: number;
  readonly totalBytes: number;
}

/** Dedicated VRAM summed over active devices; null when no device reports it. */
export function vramTotal(gpus: ReadonlyArray<GpuDeviceSample> | undefined): VramTotal | null {
  let usedBytes = 0;
  let totalBytes = 0;
  for (const gpu of gpus ?? []) {
    if (gpu.status !== "active" || gpu.sharedMemory) continue;
    if (gpu.vramUsedBytes === null || gpu.vramTotalBytes === null) continue;
    usedBytes += gpu.vramUsedBytes;
    totalBytes += gpu.vramTotalBytes;
  }
  return totalBytes === 0 ? null : { usedBytes, totalBytes };
}
