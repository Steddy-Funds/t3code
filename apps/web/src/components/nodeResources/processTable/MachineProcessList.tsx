import { useAtomValue } from "@effect/atom-react";
import { formatPercent, formatProcessMemory } from "@t3tools/client-runtime/state/machineFormat";
import type {
  MachineProcessRow,
  MachineProcessTable,
} from "@t3tools/client-runtime/state/machineProcessFrames";
import { AuthDiagnosticsReadScope, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { machineResources } from "~/state/machineResources";
import { useEnvironmentScope } from "~/state/session";

import { type ColumnOption, ColumnsMenu } from "../primitives/ColumnsMenu";
import { MachineSection, MachineSectionMessage } from "../primitives/MachineSection";
import { type ProcessViewMode, ProcessViewToggle } from "../primitives/ProcessViewToggle";
import type { TaskManagerTick } from "../taskManagerPreferences";
import { machineProcessGroupOf } from "./machineProcessGroups";
import { type ProcessColumn, ProcessTable, type ProcessTableSort } from "./ProcessTable";
import { useProcessSignal } from "./useProcessSignal";

type ProcessesResult = AsyncResult.AsyncResult<MachineProcessTable, unknown>;
const NO_PROCESSES: Atom.Atom<ProcessesResult> = Atom.make(AsyncResult.initial());

type ColumnId = "pid" | "ppid" | "user" | "cpu" | "memory" | "gpu" | "vram" | "command";

const COLUMNS: ReadonlyArray<ProcessColumn<MachineProcessRow> & { readonly id: ColumnId }> = [
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
    total: (rows) => formatPercent(sum(rows, (row) => row.gpuUtil ?? 0)),
  },
  {
    id: "vram",
    label: "VRAM",
    width: "4.5rem",
    align: "end",
    sortValue: (row) => row.vram ?? -1,
    render: (row) => (row.vram == null ? null : formatProcessMemory(row.vram)),
    total: (rows) => formatProcessMemory(sum(rows, (row) => row.vram ?? 0)),
  },
  {
    id: "command",
    label: "Command",
    width: "minmax(10rem, 3fr)",
    render: (row) => <span className="font-mono text-muted-foreground">{row.command}</span>,
  },
];

const GPU_COLUMNS: ReadonlySet<ColumnId> = new Set(["gpu", "vram"]);
const HOST_COLUMNS: ReadonlySet<ColumnId> = new Set(["user"]);
const DEFAULT_HIDDEN: ReadonlySet<ColumnId> = new Set(["ppid"]);
const DEFAULT_SORT: ProcessTableSort = { columnId: "cpu", descending: true };

/**
 * The task manager's process list: the whole table (or the T3 subtree on servers without the host
 * walk), streamed at the page's tick. The server never sends faster than once a second and only
 * whole frames reach React, so the list repaints at most once a second.
 */
export function MachineProcessList({
  environmentId,
  tick,
  viewMode,
  onViewModeChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly tick: TaskManagerTick;
  readonly viewMode: ProcessViewMode;
  readonly onViewModeChange: (mode: ProcessViewMode) => void;
}) {
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const result = useAtomValue(
    canReadDiagnostics
      ? machineResources.machineProcesses(environmentId, {
          intervalMs: Math.max(tick, 1000),
          gpuProcesses: true,
        })
      : NO_PROCESSES,
  );
  const [hidden, setHidden] = useState<ReadonlySet<ColumnId>>(DEFAULT_HIDDEN);
  const signal = useProcessSignal(environmentId);
  const table = Option.getOrNull(AsyncResult.value(result));
  const rows = table?.rows ?? [];
  const hasGpu = rows.some((row) => row.gpuUtil !== undefined);
  const available = COLUMNS.filter(
    (column) =>
      (hasGpu || !GPU_COLUMNS.has(column.id)) &&
      (table?.source === "host" || !HOST_COLUMNS.has(column.id)),
  );
  const columns = available.filter((column) => !hidden.has(column.id));
  const columnOptions: ReadonlyArray<ColumnOption<ColumnId>> = available;

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
          <ProcessViewToggle value={viewMode} onValueChange={onViewModeChange} />
          <ColumnsMenu columns={columnOptions} hidden={hidden} onHiddenChange={setHidden} />
        </>
      }
    >
      {!canReadDiagnostics ? (
        <MachineSectionMessage>Process list needs diagnostics access</MachineSectionMessage>
      ) : table === null ? (
        AsyncResult.isFailure(result) ? (
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
            rows={rows}
            columns={columns}
            mode={viewMode}
            groupOf={viewMode === "grouped" ? machineProcessGroupOf(rows) : undefined}
            defaultSort={DEFAULT_SORT}
            kill={
              signal.canSignal
                ? {
                    canKill: () => true,
                    signalingKeys: signal.signalingKeys,
                    onKill: (row) => signal.requestKill(killTarget(row)),
                  }
                : undefined
            }
            empty={null}
          />
          {table.truncated ? (
            <MachineSectionMessage>Showing the busiest processes only</MachineSectionMessage>
          ) : null}
          {signal.dialog}
        </>
      )}
    </MachineSection>
  );
}

function sum(rows: ReadonlyArray<MachineProcessRow>, value: (row: MachineProcessRow) => number) {
  return rows.reduce((total, row) => total + value(row), 0);
}

function errorMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message ? error.message : "Process list unavailable";
}
