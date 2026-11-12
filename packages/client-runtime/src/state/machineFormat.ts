import type {
  GpuDeviceSample,
  MachineTotalsSummary,
  MachineVerdictReason,
} from "@t3tools/contracts";

import type { MachineIndicator } from "./machineIndicator.ts";
import type { MachineProcessRow } from "./machineProcessFrames.ts";

/** What every machine surface reads: the derived indicator, minus `show`. */
export type MachineIndicatorView = Omit<MachineIndicator, "show">;

/** The fields of a folded process row the card ranks by. */
export type MachineProcessSummary = Pick<MachineProcessRow, "name" | "cpu" | "rss">;

export interface TopProcess {
  readonly name: string;
  readonly count: number;
  readonly value: number;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export function formatGiB(bytes: number): string {
  return (bytes / GIB).toFixed(1);
}

/** Compact process memory: "9.2 G", "820 M". */
export function formatProcessMemory(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} G` : `${Math.round(bytes / MIB)} M`;
}

export function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

export function formatPerCore(load: number, cpuCount: number): string {
  return (load / Math.max(1, cpuCount)).toFixed(1);
}

export function memoryUsedBytes(totals: MachineTotalsSummary): number {
  return Math.max(0, totals.memoryTotalBytes - totals.memoryAvailableBytes);
}

export function memoryUsedPercent(totals: MachineTotalsSummary): number {
  if (totals.memoryTotalBytes <= 0) return 0;
  return (memoryUsedBytes(totals) / totals.memoryTotalBytes) * 100;
}

export interface GpuRowValues {
  /** "Suspended" or "Unavailable": the device has no reading. */
  readonly note: string | null;
  readonly util: string | null;
  readonly vram: string | null;
}

/** A GPU row's values; a suspended device is never woken, so it shows only its state. */
export function gpuRowValues(gpu: GpuDeviceSample): GpuRowValues {
  if (gpu.status !== "active") {
    return {
      note: gpu.status === "suspended" ? "Suspended" : "Unavailable",
      util: null,
      vram: null,
    };
  }
  const vram =
    gpu.vramUsedBytes === null || gpu.vramTotalBytes === null || gpu.vramTotalBytes === 0
      ? null
      : `${formatGiB(gpu.vramUsedBytes)} / ${formatGiB(gpu.vramTotalBytes)} GiB${gpu.sharedMemory ? " shared" : ""}`;
  return {
    note: null,
    util: gpu.utilPercent === null ? null : formatPercent(gpu.utilPercent),
    vram,
  };
}

/** Which of a GPU's values tripped the verdict, if its device is the one named in the reason. */
export function gpuTrippedRule(
  reason: MachineVerdictReason | null,
  gpuId: string,
): "gpuUtil" | "gpuVram" | null {
  if (reason === null || reason.deviceId !== gpuId) return null;
  return reason.rule === "gpuUtil" || reason.rule === "gpuVram" ? reason.rule : null;
}

// value and threshold arrive in the rule's own unit: per-core load, or percent.
export function formatMachineReason(reason: MachineVerdictReason): string {
  const device = reason.deviceName ?? reason.deviceId ?? "GPU";
  switch (reason.rule) {
    case "load":
      return `load ${reason.value.toFixed(1)} / ${reason.threshold} per core`;
    case "memory":
      return `RAM ${reason.value.toFixed(1)}% / ${reason.threshold}%`;
    case "memoryPressure":
      return "memory pressure critical";
    case "cpu":
      return `CPU ${formatPercent(reason.value)} / ${reason.threshold}%`;
    case "gpuVram":
      return `${device} VRAM ${formatPercent(reason.value)} / ${reason.threshold}%`;
    case "gpuUtil":
      return `${device} util ${formatPercent(reason.value)} / ${reason.threshold}%`;
  }
}

/** The one-line verdict text; null when the machine is ok (quiet when fine). */
export function machineVerdictText(view: MachineIndicatorView): string | null {
  if (view.unreachable) {
    if (!view.lastSeen) return "Unreachable";
    const seen = view.lastSeen.verdict === "stressed" ? "last seen stressed" : "last seen";
    return `Unreachable, ${seen} ${formatAge(view.lastSeen.ageMs)} ago`;
  }
  if (view.verdict === "unknown") return "No sample yet";
  if (view.verdict === "ok") return null;
  if (!view.reason) return "Stressed";
  return `Stressed: ${formatMachineReason(view.reason)}, ${formatAge(view.reason.heldForMs)}`;
}

/** Sums rows sharing a name ("claude ×6") and returns the top `limit` by the metric. */
export function topProcessesByName(
  rows: ReadonlyArray<MachineProcessSummary>,
  metric: "cpu" | "rss",
  limit: number,
): TopProcess[] {
  const byName = new Map<string, { count: number; value: number }>();
  for (const row of rows) {
    const entry = byName.get(row.name);
    if (entry) {
      entry.count += 1;
      entry.value += row[metric];
    } else {
      byName.set(row.name, { count: 1, value: row[metric] });
    }
  }
  // Hermes lacks toSorted; the spread already copies.
  return [...byName]
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}
