import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type MachineStatusSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { useQuietThreadShell } from "~/state/entities";
import { useEnvironmentIdentities } from "~/state/environments";
import { machineIndicator, machineResources } from "~/state/machineResources";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useKnownTerminalSessions } from "~/state/terminalSessions";

import { documentVisibleAtom } from "./documentVisible";
import { focusLineage } from "./machineFocus";
import { MachineSectionMessage } from "./primitives/MachineSection";
import type { ProcessViewMode } from "./primitives/ProcessViewToggle";
import {
  machineProcessesSource,
  useMachineProcessListState,
} from "./processTable/MachineProcessList";
import { TaskManagerGraphs } from "./taskManager/TaskManagerGraphs";
import { TaskManagerGrids } from "./taskManager/TaskManagerGrids";
import { TaskManagerHeader } from "./taskManager/TaskManagerHeader";
import { TaskManagerLists } from "./taskManager/TaskManagerLists";
import { hasReadableGpu } from "./taskManager/machineSeries";
import { MACHINE_TERMINAL_THREAD_ID, TaskManagerTerminal } from "./taskManager/TaskManagerTerminal";
import { useMachineSeries } from "./taskManager/useMachineSeries";
import {
  type TaskManagerRange,
  type TaskManagerTick,
  useTaskManagerPreferences,
} from "./taskManagerPreferences";

type SnapshotResult = AsyncResult.AsyncResult<MachineStatusSnapshot, unknown>;
const NO_SNAPSHOT: Atom.Atom<SnapshotResult> = Atom.make(AsyncResult.initial());

const allMachinesButton = (
  <Button variant="outline" size="sm" render={<Link to="/machines" />}>
    All machines
  </Button>
);

/**
 * One machine's task manager, shared by the /machines/$environmentId page and the right panel.
 * Focused on a thread (from its details), that thread's lineage is picked out and listed first.
 */
export function TaskManagerView({
  environmentId,
  focusThreadId,
  onClearFocus,
}: {
  readonly environmentId: EnvironmentId;
  readonly focusThreadId?: ThreadId | undefined;
  readonly onClearFocus?: (() => void) | undefined;
}) {
  const label = useEnvironmentIdentities().find(
    (identity) => identity.environmentId === environmentId,
  )?.label;
  const capable = useAtomValue(machineIndicator.machineCapableAtom(environmentId));
  const preferences = useTaskManagerPreferences();
  // The same query thread details reads, so the lineage usually arrives from cache.
  const lineageQuery = useEnvironmentQuery(
    focusThreadId === undefined
      ? null
      : machineResources.threadResources(environmentId, focusThreadId),
  );
  const focus = focusThreadId === undefined ? null : focusLineage(focusThreadId, lineageQuery.data);

  if (label === undefined) {
    return (
      <MachineSectionMessage action={allMachinesButton}>
        This machine isn't connected to this app.
      </MachineSectionMessage>
    );
  }
  if (!capable) {
    return (
      <MachineSectionMessage action={allMachinesButton}>
        {label} doesn't report machine resources. Update T3 Code there to see them.
      </MachineSectionMessage>
    );
  }
  return (
    <div className="@container/task-manager flex min-w-0 flex-col gap-4">
      {focusThreadId === undefined || focus === null ? null : (
        <TaskManagerFocusBar
          environmentId={environmentId}
          threadId={focusThreadId}
          lineageSize={focus.size}
          onClear={onClearFocus}
        />
      )}
      <TaskManagerOverview
        environmentId={environmentId}
        focus={focus}
        label={label}
        tick={preferences.tick}
        onTickChange={preferences.setTick}
        range={preferences.rangeMs}
        onRangeChange={preferences.setRange}
        viewMode={preferences.viewMode}
        onViewModeChange={preferences.setViewMode}
      />
      <div>{allMachinesButton}</div>
    </div>
  );
}

function TaskManagerFocusBar({
  environmentId,
  threadId,
  lineageSize,
  onClear,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly lineageSize: number;
  readonly onClear: (() => void) | undefined;
}) {
  const title = useQuietThreadShell({ environmentId, threadId })?.title ?? "This thread";
  const others = lineageSize - 1;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md bg-primary/8 px-2.5 py-1.5 text-xs">
      <span className="min-w-0 flex-1 truncate">
        Focused on <span className="font-medium">{title}</span>
        {others > 0 ? (
          <span className="text-muted-foreground">
            {` and ${others} ${others === 1 ? "subagent" : "subagents"}`}
          </span>
        ) : null}
      </span>
      {onClear ? (
        <Button variant="ghost" size="xs" onClick={onClear}>
          Clear focus
        </Button>
      ) : null}
    </div>
  );
}

function TaskManagerOverview({
  environmentId,
  focus,
  label,
  tick,
  onTickChange,
  range,
  onRangeChange,
  viewMode,
  onViewModeChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly focus: ReadonlySet<ThreadId> | null;
  readonly label: string;
  readonly tick: TaskManagerTick;
  readonly onTickChange: (tick: TaskManagerTick) => void;
  readonly range: TaskManagerRange;
  readonly onRangeChange: (range: TaskManagerRange) => void;
  readonly viewMode: ProcessViewMode;
  readonly onViewModeChange: (mode: ProcessViewMode) => void;
}) {
  const view = useAtomValue(machineIndicator.machineIndicatorAtom(environmentId));
  const visible = useAtomValue(documentVisibleAtom);
  // An unreachable machine or a hidden tab isn't subscribed; the rings keep what was last drawn,
  // and the reopened stream's history fills the gap.
  const source =
    view.unreachable || !visible
      ? NO_SNAPSHOT
      : machineResources.machine(environmentId, { intervalMs: tick, historyMs: range });
  const series = useMachineSeries(source, tick, range);
  // Primitives only, so a tick doesn't render the overview; per-tick text lives in leaves.
  const sampledGpu = useAtomValue(source, selectSampledGpu);
  const failure = useAtomValue(source, selectFailure);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const rule = view.unreachable ? null : (view.reason?.rule ?? null);
  // Remembered across tick and range re-keys, whose fresh streams start empty, so the process
  // stream isn't reopened without and then with GPU columns.
  const [knownGpu, setKnownGpu] = useState<{
    readonly environmentId: EnvironmentId;
    readonly hasGpu: boolean;
  } | null>(null);
  if (
    sampledGpu !== null &&
    (knownGpu?.environmentId !== environmentId || knownGpu.hasGpu !== sampledGpu)
  ) {
    setKnownGpu({ environmentId, hasGpu: sampledGpu });
  }
  const hasGpu = knownGpu?.environmentId === environmentId ? knownGpu.hasGpu : null;
  // Without a GPU flag the process list waits for one; say why when no sample is coming.
  const processesUnavailable =
    hasGpu !== null ? null : view.unreachable ? "Machine unreachable" : failure;
  // One process stream for the list, the memory pool's owner colours and Buckets & claims. It
  // closes on the Threads tab and in a hidden browser tab; sort, columns and filter stay.
  const processListState = useMachineProcessListState();
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const processes = machineProcessesSource({
    environmentId,
    tick,
    hasGpu: visible ? hasGpu : null,
    canReadDiagnostics,
    hidden: processListState.hidden,
    tab: processListState.tab,
  });

  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const terminalSessions = useKnownTerminalSessions({
    environmentId,
    threadId: MACHINE_TERMINAL_THREAD_ID,
  });
  // Null until the user picks: a shell still running from an earlier visit opens again.
  const [terminalChoice, setTerminalChoice] = useState<boolean | null>(null);
  const terminalOpen =
    canOperateTerminal &&
    (terminalChoice ??
      (terminalSessions ?? []).some((session) => session.state.status === "running"));

  return (
    <>
      <TaskManagerHeader
        environmentId={environmentId}
        label={label}
        tick={tick}
        onTickChange={onTickChange}
        range={range}
        onRangeChange={onRangeChange}
        {...(canOperateTerminal && !terminalOpen
          ? { onOpenTerminal: () => setTerminalChoice(true) }
          : {})}
      />
      {terminalOpen ? (
        <TaskManagerTerminal
          environmentId={environmentId}
          autoFocus={terminalChoice === true}
          onClose={() => setTerminalChoice(false)}
        />
      ) : null}
      {series === null ? null : (
        <>
          <TaskManagerGraphs
            series={series}
            source={source}
            hasGpu={hasGpu === true}
            rule={rule}
            thresholds={config?.settings.machineResources.thresholds}
            windows={config?.environment.platform.os === "windows"}
          />
          <TaskManagerGrids
            environmentId={environmentId}
            series={series}
            source={source}
            processes={processes}
            rule={rule}
          />
        </>
      )}
      <TaskManagerLists
        environmentId={environmentId}
        focus={focus}
        processes={processes}
        processListState={processListState}
        hasGpu={visible ? hasGpu : null}
        processesUnavailable={processesUnavailable}
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
      />
    </>
  );
}

function selectSampledGpu(result: SnapshotResult): boolean | null {
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  return snapshot?.sample ? hasReadableGpu(snapshot) : null;
}

function selectFailure(result: SnapshotResult): string | null {
  return AsyncResult.isFailure(result) ? errorMessage(result.cause) : null;
}

function errorMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message ? error.message : "Process list unavailable";
}
