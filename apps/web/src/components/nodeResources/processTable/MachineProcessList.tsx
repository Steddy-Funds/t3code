import { useAtomValue } from "@effect/atom-react";
import { formatPercent, formatProcessMemory } from "@t3tools/client-runtime/state/machineFormat";
import type { MachineProcessRow } from "@t3tools/client-runtime/state/machineProcessFrames";
import { AuthDiagnosticsReadScope, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { Input } from "~/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { machineResources } from "~/state/machineResources";
import { useEnvironmentScope } from "~/state/session";

import { type MachineOwnerNames, ownerNamesAtom } from "../ownership/ownerNames";
import { type OwnerPalette, ownerPaletteAtom, type ProcessesResult } from "../ownership/ownerPalette";
import {
  ownerBucketId,
  ownerGroupOf,
  ownerKey,
  ownerThreadId,
  type ProcessGroupBy,
  processMatches,
  rowsHaveOwners,
} from "../ownership/processOwners";
import { type ColumnOption, ColumnsMenu } from "../primitives/ColumnsMenu";
import { MachineSection, MachineSectionMessage } from "../primitives/MachineSection";
import { OwnerChip } from "../primitives/OwnerChip";
import { ownerLabel } from "../primitives/OwnerLabel";
import { type ProcessViewMode, ProcessViewToggle } from "../primitives/ProcessViewToggle";
import type { TaskManagerTick } from "../taskManagerPreferences";
import { machineProcessGroupOf } from "./machineProcessGroups";
import {
  type ProcessColumn,
  ProcessTable,
  type ProcessTableSort,
  type ProcessTableState,
  useProcessTableState,
} from "./ProcessTable";
import { useProcessSignal } from "./useProcessSignal";

export type { ProcessesResult };
export const NO_PROCESSES: Atom.Atom<ProcessesResult> = Atom.make(AsyncResult.initial());

type ColumnId =
  | "pid"
  | "ppid"
  | "user"
  | "owner"
  | "thread"
  | "project"
  | "bucket"
  | "cpu"
  | "memory"
  | "gpu"
  | "vram"
  | "command";
type Column = ProcessColumn<MachineProcessRow> & { readonly id: ColumnId };

const idCell = (id: string | null | undefined) =>
  id ? <span className="font-mono text-muted-foreground">{id}</span> : null;

function columnsFor(names: MachineOwnerNames, palette: OwnerPalette): ReadonlyArray<Column> {
  return [
    {
      id: "pid",
      label: "PID",
      width: "4.5rem",
      align: "end",
      sortValue: (row) => row.pid,
      render: (row) => row.pid,
    },
    {
      id: "ppid",
      label: "PPID",
      width: "4.5rem",
      align: "end",
      sortValue: (row) => row.ppid,
      render: (row) => row.ppid,
    },
    {
      id: "user",
      label: "User",
      width: "6rem",
      sortValue: (row) => row.user,
      render: (row) => row.user,
    },
    {
      id: "owner",
      label: "Owner",
      width: "9rem",
      sortValue: (row) => (row.owner ? ownerLabel(row.owner, names).text : ""),
      render: (row) =>
        row.owner ? (
          <OwnerChip
            label={ownerLabel(row.owner, names)}
            color={ownerColor(palette, ownerKey(row.owner))}
          />
        ) : null,
    },
    {
      id: "thread",
      label: "Thread",
      width: "6rem",
      sortValue: (row) => ownerThreadId(row.owner) ?? "",
      render: (row) => idCell(ownerThreadId(row.owner)),
    },
    {
      id: "project",
      label: "Project",
      width: "6rem",
      sortValue: (row) => projectOf(row, names) ?? "",
      render: (row) => idCell(projectOf(row, names)),
    },
    {
      id: "bucket",
      label: "Bucket",
      width: "6rem",
      sortValue: (row) => ownerBucketId(row.owner) ?? "",
      render: (row) => idCell(ownerBucketId(row.owner)),
    },
    {
      id: "cpu",
      label: "CPU",
      width: "4rem",
      align: "end",
      sortValue: (row) => row.cpu,
      render: (row) => formatPercent(row.cpu),
      total: (rows) => formatPercent(sum(rows, (row) => row.cpu)),
    },
    {
      id: "memory",
      label: "Memory",
      width: "4.5rem",
      align: "end",
      sortValue: (row) => row.rss,
      render: (row) => formatProcessMemory(row.rss),
      total: (rows) => formatProcessMemory(sum(rows, (row) => row.rss)),
    },
    {
      id: "gpu",
      label: "GPU",
      width: "4rem",
      align: "end",
      sortValue: (row) => row.gpuUtil ?? -1,
      render: (row) => (row.gpuUtil == null ? null : formatPercent(row.gpuUtil)),
      total: (rows) => {
        const total = measuredSum(rows, (row) => row.gpuUtil);
        return total === null ? null : formatPercent(total);
      },
    },
    {
      id: "vram",
      label: "VRAM",
      width: "4.5rem",
      align: "end",
      sortValue: (row) => row.vram ?? -1,
      render: (row) => (row.vram == null ? null : formatProcessMemory(row.vram)),
      total: (rows) => {
        const total = measuredSum(rows, (row) => row.vram);
        return total === null ? null : formatProcessMemory(total);
      },
    },
    {
      id: "command",
      label: "Command",
      width: "minmax(10rem, 3fr)",
      render: (row) => <span className="font-mono text-muted-foreground">{row.command}</span>,
    },
  ];
}

const ownerColor = (palette: OwnerPalette, key: string) => {
  const color = palette.colorOf(key);
  return color === undefined ? undefined : `var(${color})`;
};

function projectOf(row: MachineProcessRow, names: MachineOwnerNames) {
  const threadId = ownerThreadId(row.owner);
  return threadId === null ? undefined : names.projectOf(threadId);
}

const GPU_COLUMNS: ReadonlySet<ColumnId> = new Set(["gpu", "vram"]);
const HOST_COLUMNS: ReadonlySet<ColumnId> = new Set(["user"]);
const OWNER_COLUMNS: ReadonlySet<ColumnId> = new Set(["owner", "thread", "project", "bucket"]);
const DEFAULT_HIDDEN: ReadonlySet<ColumnId> = new Set(["ppid", "thread", "project", "bucket"]);
const DEFAULT_SORT: ProcessTableSort = { columnId: "cpu", descending: true };

const GROUP_BY: ReadonlyArray<{ readonly value: ProcessGroupBy; readonly label: string }> = [
  { value: "thread", label: "Thread" },
  { value: "bucket", label: "Bucket" },
  { value: "provider", label: "Provider" },
];

/** The task manager's list tabs. Only Threads leaves the process stream unread. */
export type TaskManagerTab = "processes" | "threads" | "buckets";

export interface MachineProcessListState {
  readonly tab: TaskManagerTab;
  readonly setTab: (tab: TaskManagerTab) => void;
  readonly table: ProcessTableState;
  readonly hidden: ReadonlySet<ColumnId>;
  readonly setHidden: (hidden: ReadonlySet<ColumnId>) => void;
  readonly filter: string;
  readonly setFilter: (filter: string) => void;
  readonly groupBy: ProcessGroupBy;
  readonly setGroupBy: (groupBy: ProcessGroupBy) => void;
}

/**
 * The open tab, plus sort, expansion, columns, filter and grouping, held above the tabs so they
 * survive a switch and the page can close the process stream on Threads.
 */
export function useMachineProcessListState(): MachineProcessListState {
  const [tab, setTab] = useState<TaskManagerTab>("processes");
  const table = useProcessTableState(DEFAULT_SORT);
  const [hidden, setHidden] = useState<ReadonlySet<ColumnId>>(DEFAULT_HIDDEN);
  const [filter, setFilter] = useState("");
  const [groupBy, setGroupBy] = useState<ProcessGroupBy>("thread");
  return { tab, setTab, table, hidden, setHidden, filter, setFilter, groupBy, setGroupBy };
}

/**
 * The task manager's one process stream: the whole table (or the T3 subtree on servers without
 * the host walk) at the page's tick, shared by the list, the memory pool and Buckets & claims.
 * It waits for the GPU flag so it opens once with the right input; a null flag is not yet known,
 * or a hidden browser tab.
 */
export function machineProcessesSource(input: {
  readonly environmentId: EnvironmentId;
  readonly tick: TaskManagerTick;
  readonly hasGpu: boolean | null;
  readonly canReadDiagnostics: boolean;
  readonly hidden: ReadonlySet<ColumnId>;
  readonly tab: TaskManagerTab;
}): Atom.Atom<ProcessesResult> {
  // The pool above the tabs still shows on Threads, but owner colours alone don't justify a
  // whole process table per tick; without frames the pool draws used memory in one colour.
  if (!input.canReadDiagnostics || input.hasGpu === null || input.tab === "threads") {
    return NO_PROCESSES;
  }
  // Per-process GPU columns cost the host a DRM fdinfo or NVML walk, so ask only while shown.
  const gpuProcesses =
    input.hasGpu && [...GPU_COLUMNS].some((column) => !input.hidden.has(column));
  return machineResources.machineProcesses(input.environmentId, {
    intervalMs: Math.max(input.tick, 1000),
    ...(gpuProcesses ? { gpuProcesses: true } : {}),
  });
}

/**
 * The task manager's process list. The server never sends faster than once a second and only
 * whole frames reach React, so the list repaints at most once a second.
 */
export function MachineProcessList({
  environmentId,
  processes,
  hasGpu,
  unavailable = null,
  state,
  viewMode,
  onViewModeChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly processes: Atom.Atom<ProcessesResult>;
  /** Per-process GPU columns are offered only on a machine with a readable GPU. */
  readonly hasGpu: boolean | null;
  /** Shown instead of waiting when the GPU flag will not arrive, such as an unreachable machine. */
  readonly unavailable?: string | null;
  readonly state: MachineProcessListState;
  readonly viewMode: ProcessViewMode;
  readonly onViewModeChange: (mode: ProcessViewMode) => void;
}) {
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const { hidden, setHidden, filter, setFilter, groupBy, setGroupBy } = state;
  const result = useAtomValue(processes);
  const names = useAtomValue(ownerNamesAtom(environmentId));
  const palette = useAtomValue(ownerPaletteAtom(processes));
  const signal = useProcessSignal(environmentId);
  const table = Option.getOrNull(AsyncResult.value(result));
  const rows = table?.rows ?? [];
  const hasOwners = rowsHaveOwners(rows);
  const shownRows =
    filter.trim() === "" ? rows : rows.filter((row) => processMatches(row, filter, names));
  const available = columnsFor(names, palette).filter(
    (column) =>
      (hasGpu === true || !GPU_COLUMNS.has(column.id)) &&
      (table?.source === "host" || !HOST_COLUMNS.has(column.id)) &&
      (hasOwners || !OWNER_COLUMNS.has(column.id)),
  );
  const columns = available.filter((column) => !hidden.has(column.id));
  const columnOptions: ReadonlyArray<ColumnOption<ColumnId>> = available;
  // Servers before ownership send no owners, so only the provider grouping means anything there.
  const effectiveGroupBy = hasOwners ? groupBy : "provider";
  const groupOf =
    viewMode !== "grouped"
      ? undefined
      : effectiveGroupBy === "provider"
        ? machineProcessGroupOf(rows)
        : ownerGroupOf(effectiveGroupBy, names);

  const killTarget = (row: MachineProcessRow) => ({
    pid: row.pid,
    startTimeMs: row.startTimeMs,
    name: row.name,
    command: row.command,
    summary: `${formatPercent(row.cpu)} CPU · ${formatProcessMemory(row.rss)}`,
    childCount: rows.filter((other) => other.ppid === row.pid && other.pid !== row.pid).length,
  });

  return (
    <MachineSection
      title="Processes"
      detail={table && rows.length > 0 ? rows.length : undefined}
      actions={
        <>
          <Input
            size="compact"
            type="search"
            className="w-36"
            aria-label="Filter processes"
            placeholder="Filter"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
          {viewMode === "grouped" && hasOwners ? (
            <ToggleGroup
              aria-label="Group by"
              variant="segmented"
              value={[groupBy]}
              onValueChange={(next) => {
                const option = GROUP_BY.find((candidate) => candidate.value === next[0]);
                if (option) setGroupBy(option.value);
              }}
            >
              {GROUP_BY.map((option) => (
                <ToggleGroupItem key={option.value} value={option.value}>
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : null}
          <ProcessViewToggle value={viewMode} onValueChange={onViewModeChange} />
          <ColumnsMenu columns={columnOptions} hidden={hidden} onHiddenChange={setHidden} />
        </>
      }
    >
      {!canReadDiagnostics ? (
        <MachineSectionMessage>Process list needs diagnostics access</MachineSectionMessage>
      ) : table === null ? (
        hasGpu === null && unavailable !== null ? (
          <MachineSectionMessage tone="error">{unavailable}</MachineSectionMessage>
        ) : AsyncResult.isFailure(result) ? (
          <MachineSectionMessage tone="error">{errorMessage(result.cause)}</MachineSectionMessage>
        ) : (
          <MachineSectionMessage>Loading processes…</MachineSectionMessage>
        )
      ) : rows.length === 0 ? (
        // The T3 subtree always holds the server itself, so an empty table means no monitor.
        <MachineSectionMessage>Process list needs the resource monitor</MachineSectionMessage>
      ) : (
        <>
          <ProcessTable
            rows={shownRows}
            columns={columns}
            mode={viewMode}
            groupOf={groupOf}
            defaultSort={DEFAULT_SORT}
            state={state.table}
            kill={
              signal.canSignal
                ? {
                    canKill: () => true,
                    signalingKeys: signal.signalingKeys,
                    onKill: (row) => signal.requestKill(killTarget(row)),
                  }
                : undefined
            }
            empty="No matching processes"
          />
          {table.truncated ? (
            <MachineSectionMessage>Showing the busiest processes only</MachineSectionMessage>
          ) : null}
        </>
      )}
      {/* Outside the states above, so a confirm open when the table goes away closes with it. */}
      {signal.dialog}
    </MachineSection>
  );
}

function sum(rows: ReadonlyArray<MachineProcessRow>, value: (row: MachineProcessRow) => number) {
  return rows.reduce((total, row) => total + value(row), 0);
}

/** Null unless every row was measured: a total over unmeasured rows would understate. */
function measuredSum(
  rows: ReadonlyArray<MachineProcessRow>,
  value: (row: MachineProcessRow) => number | null | undefined,
): number | null {
  let total = 0;
  for (const row of rows) {
    const current = value(row);
    if (current == null) return null;
    total += current;
  }
  return total;
}

function errorMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message ? error.message : "Process list unavailable";
}
