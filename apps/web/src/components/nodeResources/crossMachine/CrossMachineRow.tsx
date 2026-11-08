import { useAtomValue } from "@effect/atom-react";
import {
  formatGiB,
  formatPercent,
  type MachineIndicatorView,
  machineVerdictText,
  memoryUsedBytes,
  memoryUsedPercent,
  topProcessesByName,
} from "@t3tools/client-runtime/state/machineFormat";
import type { MachineProcessTable } from "@t3tools/client-runtime/state/machineProcessFrames";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  MachineBucketId,
  type MachineStatusSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { Link } from "@tanstack/react-router";

import { EnvironmentMachineIcon } from "~/components/EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useEnvironmentMachines } from "~/state/environments";
import { machineIndicator, machineResources } from "~/state/machineResources";
import { useEnvironmentScope } from "~/state/session";

import { documentVisibleAtom } from "../documentVisible";
import { ownerNamesAtom } from "../ownership/ownerNames";
import { ownerBucketId, ownerThreadId } from "../ownership/processOwners";
import { OwnerChip } from "../primitives/OwnerChip";
import { ownerLabel } from "../primitives/OwnerLabel";
import { runningThreadCountAtom } from "../runningThreads";
import { CORE_HISTORY_MS, CrossMachineCores } from "./CrossMachineCores";
import { loadPerCore, topOwnerShare, vramTotal } from "./crossMachineModel";

type SnapshotResult = AsyncResult.AsyncResult<MachineStatusSnapshot, unknown>;
type ProcessesResult = AsyncResult.AsyncResult<MachineProcessTable, unknown>;

const NO_SNAPSHOT: Atom.Atom<SnapshotResult> = Atom.make(AsyncResult.initial());
const NO_PROCESSES: Atom.Atom<ProcessesResult> = Atom.make(AsyncResult.initial());
const POOL_CELLS = 20;
const TOP_PROCESSES = 3;
// Owner sums are over the busiest rows only (shown as "≥"); ten keeps the stream small.
const TOP_OWNER_ROWS = 10;

/** What the "Top consumer" column sums by; owner modes fall back to processes on older servers. */
export type TopConsumerBy = "thread" | "bucket" | "process";

/** Shared by the row and the view's ordering, so both read one stream per machine. */
export function crossMachineSnapshotAtom(
  environmentId: EnvironmentId,
  view: MachineIndicatorView,
  tickMs: number,
  visible: boolean,
): Atom.Atom<SnapshotResult> {
  // An unreachable machine is never subscribed, as the indicator never opens a dead link.
  return view.unreachable || !visible
    ? NO_SNAPSHOT
    : machineResources.machine(environmentId, { intervalMs: tickMs, historyMs: CORE_HISTORY_MS });
}

export const CROSS_MACHINE_GRID =
  // Minimums sum to 934 px with gaps and padding, so the row fits beside the sidebar at 1280 px.
  "grid grid-cols-[16px_minmax(96px,140px)_minmax(120px,1.2fr)_244px_minmax(120px,1fr)_minmax(100px,0.8fr)_minmax(110px,1fr)_48px] items-center gap-2";

/** One dense row: verdict first, the core grid, memory and VRAM pools, top process, threads. */
export function CrossMachineRow({
  environmentId,
  label,
  tickMs,
  topBy,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly tickMs: number;
  readonly topBy: TopConsumerBy;
}) {
  const view = useAtomValue(machineIndicator.machineIndicatorAtom(environmentId));
  const kind = useEnvironmentMachines().get(environmentId) ?? "server";
  const visible = useAtomValue(documentVisibleAtom);
  const source = crossMachineSnapshotAtom(environmentId, view, tickMs, visible);
  const snapshot = Option.getOrNull(AsyncResult.value(useAtomValue(source)));
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const processes = useAtomValue(
    canReadDiagnostics && !view.unreachable && visible
      ? machineResources.machineProcesses(environmentId, {
          intervalMs: tickMs,
          top: topBy === "process" ? TOP_PROCESSES : TOP_OWNER_ROWS,
        })
      : NO_PROCESSES,
  );
  const threads = useAtomValue(runningThreadCountAtom(environmentId));
  const totals = view.unreachable ? null : (snapshot?.totals ?? null);
  const rule = view.unreachable ? null : (view.reason?.rule ?? null);
  const stressed = !view.unreachable && view.verdict === "stressed";
  const stale = view.unreachable || view.verdict === "unknown";
  return (
    <li>
      <Link
        to="/machines/$environmentId"
        params={{ environmentId }}
        data-stressed={stressed || undefined}
        className={cn(
          CROSS_MACHINE_GRID,
          "px-3 py-1.5 text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none data-stressed:bg-linear-to-r data-stressed:from-(--machine-stress)/10 data-stressed:to-transparent data-stressed:to-60%",
          stale && "text-muted-foreground",
        )}
      >
        <EnvironmentMachineIcon
          kind={kind}
          environmentId={environmentId}
          className="size-4 shrink-0"
        />
        <span className="truncate font-medium">{label}</span>
        <VerdictCell view={view} totals={totals} />
        <div className={cn(stale && "opacity-50")}>
          <CrossMachineCores source={source} tickMs={tickMs} />
        </div>
        {totals ? (
          <PoolCell
            percent={memoryUsedPercent(totals)}
            tripped={rule === "memory" || rule === "memoryPressure"}
            text={`${formatGiB(memoryUsedBytes(totals))}/${formatGiB(totals.memoryTotalBytes)} G`}
          />
        ) : (
          <Empty />
        )}
        <VramCell snapshot={view.unreachable ? null : snapshot} tripped={rule === "gpuVram"} />
        <TopConsumerCell
          environmentId={environmentId}
          processes={processes}
          canRead={canReadDiagnostics}
          topBy={topBy}
        />
        <span className="text-end tabular-nums">{threads}</span>
      </Link>
    </li>
  );
}

function VerdictCell({
  view,
  totals,
}: {
  readonly view: MachineIndicatorView;
  readonly totals: MachineStatusSnapshot["totals"];
}) {
  const text = machineVerdictText(view);
  if (text !== null) {
    const stressed = !view.unreachable && view.verdict === "stressed";
    return <span className={cn("truncate", stressed && "text-error-foreground")}>{text}</span>;
  }
  // Ok: the number the order is by, and nothing else.
  const load = loadPerCore(totals);
  if (load === null) return <Empty />;
  return <span className="truncate tabular-nums">load {load.toFixed(1)}/core</span>;
}

function PoolCell({
  percent,
  tripped,
  text,
}: {
  readonly percent: number;
  readonly tripped: boolean;
  readonly text: string;
}) {
  const filled = Math.min(POOL_CELLS, Math.round((percent / 100) * POOL_CELLS));
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div
        role="img"
        aria-label={`${formatPercent(percent)} used`}
        className="grid h-2 min-w-0 flex-1 grid-cols-20 gap-px"
      >
        {Array.from({ length: POOL_CELLS }, (_, index) => (
          <i
            key={index}
            className={cn(
              "block rounded-xs",
              index >= filled ? "bg-muted" : tripped ? "bg-(--machine-stress)" : "bg-primary",
            )}
          />
        ))}
      </div>
      <span
        className={cn(
          "shrink-0 font-mono text-2xs tabular-nums",
          tripped && "text-error-foreground",
        )}
      >
        {text}
      </span>
    </div>
  );
}

function VramCell({
  snapshot,
  tripped,
}: {
  readonly snapshot: MachineStatusSnapshot | null;
  readonly tripped: boolean;
}) {
  const vram = vramTotal(snapshot?.sample?.gpus);
  if (vram === null) return <Empty />;
  return (
    <PoolCell
      percent={(vram.usedBytes / vram.totalBytes) * 100}
      tripped={tripped}
      text={`${formatGiB(vram.usedBytes)}/${formatGiB(vram.totalBytes)} G`}
    />
  );
}

function TopConsumerCell({
  environmentId,
  processes,
  canRead,
  topBy,
}: {
  readonly environmentId: EnvironmentId;
  readonly processes: ProcessesResult;
  readonly canRead: boolean;
  readonly topBy: TopConsumerBy;
}) {
  const names = useAtomValue(ownerNamesAtom(environmentId));
  if (!canRead)
    return <span className="truncate text-muted-foreground">No diagnostics access</span>;
  const table = Option.getOrNull(AsyncResult.value(processes));
  if (table === null) {
    return AsyncResult.isFailure(processes) ? (
      <span className="truncate text-muted-foreground">Process list unavailable</span>
    ) : (
      <Empty />
    );
  }
  // The T3 subtree always holds the server itself, so an empty table means no monitor.
  if (table.rows.length === 0) {
    return <span className="truncate text-muted-foreground">Needs the resource monitor</span>;
  }
  if (topBy !== "process") {
    const share = topOwnerShare(table.rows, (row) =>
      topBy === "thread" ? ownerThreadId(row.owner) : ownerBucketId(row.owner),
    );
    if (share !== null) {
      const owner =
        topBy === "thread"
          ? ({ type: "thread", threadId: ThreadId.make(share.key) } as const)
          : ({ type: "bucket", bucketId: MachineBucketId.make(share.key) } as const);
      return (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <OwnerChip label={ownerLabel(owner, names)} />
          <Tooltip>
            <TooltipTrigger render={<span className="shrink-0 font-mono text-2xs tabular-nums" />}>
              {share.text}
            </TooltipTrigger>
            <TooltipPopup side="top">
              At least this much, from the {TOP_OWNER_ROWS} busiest processes
            </TooltipPopup>
          </Tooltip>
        </span>
      );
    }
  }
  const top = topProcessesByName(table.rows, "cpu", 1)[0];
  if (top === undefined) return <Empty />;
  const name = top.count > 1 ? `${top.name} ×${top.count}` : top.name;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0 font-mono text-2xs tabular-nums">{formatPercent(top.value)}</span>
    </span>
  );
}

function Empty() {
  return <span />;
}
