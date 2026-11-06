import type { MachineIndicator } from "@t3tools/client-runtime/state/machineIndicator";
import type { MachineProcessRow } from "@t3tools/client-runtime/state/machineProcessFrames";
import type { MachineTotalsSummary, MachineVerdictReason } from "@t3tools/contracts";

// Mirrors apps/web/src/components/nodeResources/format.ts until the copy moves to a shared package.

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

// value and threshold arrive in the rule's own unit: per-core load, or percent.
function formatMachineReason(reason: MachineVerdictReason): string {
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
export function machineVerdictText(indicator: MachineIndicator): string | null {
  if (indicator.unreachable) {
    if (!indicator.lastSeen) return "Unreachable";
    const seen = indicator.lastSeen.verdict === "stressed" ? "last seen stressed" : "last seen";
    return `Unreachable, ${seen} ${formatAge(indicator.lastSeen.ageMs)} ago`;
  }
  if (indicator.verdict === "unknown") return "No sample yet";
  if (indicator.verdict === "ok") return null;
  if (!indicator.reason) return "Stressed";
  return `Stressed: ${formatMachineReason(indicator.reason)}, ${formatAge(indicator.reason.heldForMs)}`;
}

export interface TopProcess {
  readonly name: string;
  readonly count: number;
  readonly value: number;
}

/** Sums rows sharing a name ("claude ×6") and returns the top `limit` by the metric. */
export function topProcessesByName(
  rows: ReadonlyArray<MachineProcessRow>,
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
  return [...byName]
    .map(([name, entry]) => ({ name, ...entry }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}
