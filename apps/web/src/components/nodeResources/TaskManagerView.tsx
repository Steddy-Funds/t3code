import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";
import { useEnvironmentIdentities } from "~/state/environments";
import { machineIndicator } from "~/state/machineResources";

import { MachineSectionMessage } from "./primitives/MachineSection";
import { TaskManagerGraphs } from "./taskManager/TaskManagerGraphs";
import { TaskManagerGrids } from "./taskManager/TaskManagerGrids";
import { TaskManagerHeader } from "./taskManager/TaskManagerHeader";
import { TaskManagerLists } from "./taskManager/TaskManagerLists";
import { useTaskManagerPreferences } from "./taskManagerPreferences";

const allMachinesButton = (
  <Button variant="outline" size="sm" render={<Link to="/machines" />}>
    All machines
  </Button>
);

/** One machine's task manager, shared by the /machines/$environmentId page and the right panel. */
export function TaskManagerView({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const label = useEnvironmentIdentities().find(
    (identity) => identity.environmentId === environmentId,
  )?.label;
  const capable = useAtomValue(machineIndicator.machineCapableAtom(environmentId));
  const preferences = useTaskManagerPreferences();

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
      <TaskManagerHeader
        environmentId={environmentId}
        label={label}
        tick={preferences.tick}
        onTickChange={preferences.setTick}
      />
      <TaskManagerGraphs />
      <TaskManagerGrids />
      <TaskManagerLists
        viewMode={preferences.viewMode}
        onViewModeChange={preferences.setViewMode}
      />
      <div>{allMachinesButton}</div>
    </div>
  );
}
