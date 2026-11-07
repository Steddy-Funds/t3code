import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";

import { MachineSection } from "../primitives/MachineSection";
import type { ProcessViewMode } from "../primitives/ProcessViewToggle";
import { MachineProcessList } from "../processTable/MachineProcessList";
import type { TaskManagerTick } from "../taskManagerPreferences";

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
  viewMode,
  onViewModeChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly tick: TaskManagerTick;
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
          tick={tick}
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
        />
      ) : (
        <MachineSection title="Threads on this machine">{null}</MachineSection>
      )}
    </div>
  );
}
