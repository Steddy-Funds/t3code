// Local copies of the b3 wire shapes until packages/contracts/src/machineResources.ts lands.
export type MachineVerdict = "ok" | "stressed" | "unknown";

export interface MachineVerdictReason {
  readonly rule: "load" | "memory" | "memoryPressure" | "cpu" | "gpuVram" | "gpuUtil";
  readonly value: number;
  readonly threshold: number;
  readonly heldForMs: number;
  readonly deviceId?: string;
  readonly deviceName?: string;
}

export interface MachineTotalsSummary {
  readonly cpuUtilization: number | null;
  readonly cpuCount: number;
  readonly load: { readonly one: number; readonly five: number; readonly fifteen: number } | null;
  readonly memoryTotalBytes: number;
  readonly memoryAvailableBytes: number;
  readonly swapTotalBytes: number;
  readonly swapUsedBytes: number;
  readonly memoryPressure: "normal" | "warn" | "critical" | null;
}

export interface MachineStatusSnapshot {
  readonly sequence: number;
  readonly verdict: MachineVerdict;
  readonly verdictAgeMs: number;
  readonly reason: MachineVerdictReason | null;
  readonly sampleAgeMs: number;
  readonly totals: MachineTotalsSummary | null;
  readonly sample?: { readonly perCore: ReadonlyArray<number> };
}

export interface MachineLastSeen {
  readonly verdict: MachineVerdict;
  readonly ageMs: number;
}

/** What every machine surface reads: `resolveMachineIndicator`'s fields, minus `show`. */
export interface MachineIndicatorView {
  readonly verdict: MachineVerdict;
  readonly unreachable: boolean;
  readonly reason: MachineVerdictReason | null;
  readonly lastSeen: MachineLastSeen | null;
}

/** One live process row, already folded from `MachineProcessFrame`s. */
export interface MachineProcessRow {
  readonly name: string;
  /** Percent of one core. */
  readonly cpu: number;
  readonly rssBytes: number;
}

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
  rows: ReadonlyArray<MachineProcessRow>,
  metric: "cpu" | "rssBytes",
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
    .toSorted((a, b) => b.value - a.value)
    .slice(0, limit);
}
