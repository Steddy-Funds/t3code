import type { EnvironmentId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { useState } from "react";

import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";

import type { ProcessViewMode } from "../primitives/ProcessViewToggle";
import {
  MachineProcessList,
  type MachineProcessListState,
  type ProcessesResult,
} from "../processTable/MachineProcessList";
import { TaskManagerBuckets } from "./TaskManagerBuckets";
import { TaskManagerThreads } from "./TaskManagerThreads";

const LISTS = [
  { value: "processes", label: "Processes" },
  { value: "threads", label: "Threads" },
  { value: "buckets", label: "Buckets & claims" },
] as const;
type TaskManagerList = (typeof LISTS)[number]["value"];

function isTaskManagerList(value: unknown): value is TaskManagerList {
  return LISTS.some((list) => list.value === value);
}

/** Tabs for the lists only, so the graphs and grids above stay in view while sorting. */
export function TaskManagerLists({
  environmentId,
  processes,
  processListState,
  hasGpu,
  processesUnavailable,
  viewMode,
  onViewModeChange,
}: {
  readonly environmentId: EnvironmentId;
  /** The page's one process stream; the memory pool reads it too, so it stays open on every tab. */
  readonly processes: Atom.Atom<ProcessesResult>;
  /** Held by the page so sort, columns and filter survive the other tabs. */
  readonly processListState: MachineProcessListState;
  /** The machine has a GPU that can be read; per-process GPU columns are offered only then. */
  readonly hasGpu: boolean | null;
  /** Why the process list can't open, such as an unreachable machine. */
  readonly processesUnavailable: string | null;
  readonly viewMode: ProcessViewMode;
  readonly onViewModeChange: (mode: ProcessViewMode) => void;
}) {
  const [list, setList] = useState<TaskManagerList>("processes");
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ToggleGroup
        aria-label="List"
        variant="segmented"
        value={[list]}
        onValueChange={(next) => {
          const value = next[0];
          if (isTaskManagerList(value)) setList(value);
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
          processes={processes}
          hasGpu={hasGpu}
          unavailable={processesUnavailable}
          state={processListState}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
        />
      ) : list === "threads" ? (
        <TaskManagerThreads environmentId={environmentId} />
      ) : (
        <TaskManagerBuckets environmentId={environmentId} processes={processes} />
      )}
    </div>
  );
}
