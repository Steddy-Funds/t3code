import type { ThreadResourcePoint } from "@t3tools/contracts";

export const RESOURCE_STEP_MS = 30_000;
/** Ten minutes of 30 s rollups. */
export const RESOURCE_WINDOW_POINTS = 20;

export interface IdleSummary {
  /** Age of the newest rollup, when the thread ran within the history window. */
  readonly lastActiveMs: number | null;
  readonly peakCpuPercent: number | null;
  readonly peakMemoryBytes: number | null;
}

export function idleSummary(history: ReadonlyArray<ThreadResourcePoint>): IdleSummary {
  if (history.length === 0) {
    return { lastActiveMs: null, peakCpuPercent: null, peakMemoryBytes: null };
  }
  return {
    lastActiveMs: Math.min(...history.map((point) => point.ageMs)),
    peakCpuPercent: Math.max(...history.map((point) => point.cpuPercent)),
    peakMemoryBytes: Math.max(...history.map((point) => point.memoryBytes)),
  };
}
