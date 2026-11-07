import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";

import type { ProcessViewMode } from "../primitives/ProcessViewToggle";
import { MachineProcessList, useMachineProcessListState } from "../processTable/MachineProcessList";
import type { TaskManagerTick } from "../taskManagerPreferences";
import { TaskManagerThreads } from "./TaskManagerThreads";

const LISTS = [
  { value: "processes", label: "Processes" },
  { value: "threads", label: "Threads" },
] as const;
type TaskManagerList = (typeof LISTS)[number]["value"];

function isTaskManagerList(value: unknown): value is TaskManagerList {
  return LISTS.some((list) => list.value === value);
}

/** Tabs for the lists only, so the graphs and grids above stay in view while sorting. */
export function TaskManagerLists({
  environmentId,
  tick,
  hasGpu,
  processesUnavailable,
  viewMode,
  onViewModeChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly tick: TaskManagerTick;
  /** The machine has a GPU that can be read; per-process GPU columns are offered only then. */
  readonly hasGpu: boolean | null;
  /** Why the process list can't open, such as an unreachable machine. */
  readonly processesUnavailable: string | null;
  readonly viewMode: ProcessViewMode;
  readonly onViewModeChange: (mode: ProcessViewMode) => void;
}) {
  const [list, setList] = useState<TaskManagerList>("processes");
  // Kept here so sort and columns survive Threads; the stream itself closes while hidden.
  const processListState = useMachineProcessListState();
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
          tick={tick}
          hasGpu={hasGpu}
          unavailable={processesUnavailable}
          state={processListState}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
        />
      ) : (
        <TaskManagerThreads environmentId={environmentId} />
      )}
    </div>
  );
}
