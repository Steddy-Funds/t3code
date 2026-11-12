import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";

import type { ProcessViewMode } from "../primitives/ProcessViewToggle";
import {
  MachineProcessList,
  type MachineProcessListState,
  type ProcessesResult,
  type TaskManagerTab,
} from "../processTable/MachineProcessList";
import { TaskManagerBuckets } from "./TaskManagerBuckets";
import { TaskManagerThreads } from "./TaskManagerThreads";

const LISTS = [
  { value: "processes", label: "Processes" },
  { value: "threads", label: "Threads" },
  { value: "buckets", label: "Buckets & claims" },
] as const satisfies ReadonlyArray<{ value: TaskManagerTab; label: string }>;

function isTaskManagerTab(value: unknown): value is TaskManagerTab {
  return LISTS.some((list) => list.value === value);
}

/** Tabs for the lists only, so the graphs and grids above stay in view while sorting. */
export function TaskManagerLists({
  environmentId,
  focus,
  processes,
  processListState,
  hasGpu,
  processesUnavailable,
  viewMode,
  onViewModeChange,
}: {
  readonly environmentId: EnvironmentId;
  /** The focused thread's lineage, picked out and listed first. */
  readonly focus: ReadonlySet<ThreadId> | null;
  /** The page's one process stream, shared with the memory pool; the page closes it on Threads. */
  readonly processes: Atom.Atom<ProcessesResult>;
  /** Held by the page, with the open tab, so sort, columns and filter survive the other tabs. */
  readonly processListState: MachineProcessListState;
  /** The machine has a GPU that can be read; per-process GPU columns are offered only then. */
  readonly hasGpu: boolean | null;
  /** Why the process list can't open, such as an unreachable machine. */
  readonly processesUnavailable: string | null;
  readonly viewMode: ProcessViewMode;
  readonly onViewModeChange: (mode: ProcessViewMode) => void;
}) {
  const list = processListState.tab;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ToggleGroup
        aria-label="List"
        variant="segmented"
        value={[list]}
        onValueChange={(next) => {
          const value = next[0];
          if (isTaskManagerTab(value)) processListState.setTab(value);
        }}
      >
        {LISTS.map((option) => (
          <ToggleGroupItem key={option.value} value={option.value}>
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {list === "processes" ? (
        <MachineProcessList
          environmentId={environmentId}
          focus={focus}
          processes={processes}
          hasGpu={hasGpu}
          unavailable={processesUnavailable}
          state={processListState}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
        />
      ) : list === "threads" ? (
        <TaskManagerThreads environmentId={environmentId} focus={focus} />
      ) : (
        <TaskManagerBuckets environmentId={environmentId} processes={processes} />
      )}
    </div>
  );
}
