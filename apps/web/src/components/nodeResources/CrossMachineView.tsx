import { Link } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";

import { useCapableMachines } from "./capableMachines";
import { CrossMachineList } from "./crossMachine/CrossMachineList";
import { MachineSectionMessage } from "./primitives/MachineSection";

/** Every machine that reports resources, one row each; a row opens that machine's task manager. */
export function CrossMachineView() {
  const machines = useCapableMachines();
  if (machines.length === 0) {
    return (
      <MachineSectionMessage
        action={
          <Button variant="outline" size="sm" render={<Link to="/settings/connections" />}>
            Connections
          </Button>
        }
      >
        No connected machine reports resources yet.
      </MachineSectionMessage>
    );
  }
  return <CrossMachineList />;
}
