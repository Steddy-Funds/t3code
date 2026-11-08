import type { MachineProcessRow } from "@t3tools/client-runtime/state/machineProcessFrames";
import type { ThreadResourcePoint } from "@t3tools/contracts";

import { sharedText } from "../nodeResources/primitives/OwnerLabel";

export const RESOURCE_STEP_MS = 30_000;
/** Ten minutes of 30 s rollups. */
export const RESOURCE_WINDOW_POINTS = 20;
const MAX_TREE_ROWS = 8;
const MAX_DEPTH = 2;

export interface ProcessTreeLine {
  readonly key: number;
  readonly depth: number;
  readonly text: string;
  /** CPU percent of one core; null for a shared root, whose load belongs to several threads. */
  readonly cpu: number | null;
  readonly shared: boolean;
  readonly claimed: boolean;
}

export interface ProcessTree {
  readonly lines: ReadonlyArray<ProcessTreeLine>;
  /** Processes left out past the row cap. */
  readonly hidden: number;
}

function lineText(row: MachineProcessRow): string {
  const args = row.command.trim().split(/\s+/).slice(1).join(" ");
  const base = args.length > 0 ? `${row.name} · ${args}` : row.name;
  const owner = row.owner;
  if (owner?.type === "shared") return `${row.name} — ${sharedText(owner.threadCount)}`;
  if (owner?.type === "thread" && owner.terminalId !== undefined) return `terminal · ${base}`;
  return base;
}

/** Provider CLI first, then terminals, then claims; each group by start time so rows never jump. */
function rootRank(row: MachineProcessRow): number {
  const owner = row.owner;
  if (owner?.type === "claimed") return 2;
  if (owner?.type === "thread" && owner.terminalId !== undefined) return 1;
  return 0;
}

/**
 * The thread's processes as a small tree: a row whose parent is in the set nests under it.
 * Rows deeper than two levels, or past the row cap, are counted in `hidden` instead.
 */
export function threadProcessTree(rows: ReadonlyArray<MachineProcessRow>): ProcessTree {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const children = new Map<number, MachineProcessRow[]>();
  const roots: MachineProcessRow[] = [];
  for (const row of rows) {
    const parent = byPid.get(row.ppid);
    if (parent === undefined || parent === row) roots.push(row);
    else children.set(parent.pid, [...(children.get(parent.pid) ?? []), row]);
  }
  const byStart = (a: MachineProcessRow, b: MachineProcessRow) =>
    a.startTimeMs - b.startTimeMs || a.pid - b.pid;
  roots.sort((a, b) => rootRank(a) - rootRank(b) || byStart(a, b));

  const lines: ProcessTreeLine[] = [];
  const visit = (row: MachineProcessRow, depth: number) => {
    const shared = row.owner?.type === "shared";
    lines.push({
      key: row.key,
      depth,
      text: lineText(row),
      cpu: shared ? null : row.cpu,
      shared,
      claimed: row.owner?.type === "claimed",
    });
    if (depth >= MAX_DEPTH) return;
    for (const child of (children.get(row.pid) ?? []).toSorted(byStart)) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  const shown = lines.slice(0, MAX_TREE_ROWS);
  return { lines: shown, hidden: rows.length - shown.length };
}

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
