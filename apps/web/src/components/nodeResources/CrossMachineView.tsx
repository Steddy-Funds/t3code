import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { EnvironmentMachineIcon } from "~/components/EnvironmentMachineIcon";
import { Button } from "~/components/ui/button";
import { useEnvironmentMachines } from "~/state/environments";
import { machineIndicator } from "~/state/machineResources";

import { useCapableMachines } from "./capableMachines";
import { MachineVerdictLine } from "./MachineVerdictLine";
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
  return (
    <ul className="flex min-w-0 flex-col divide-y rounded-xl border bg-card">
      {machines.map((machine) => (
        <CrossMachineRow
          key={machine.environmentId}
          environmentId={machine.environmentId}
          label={machine.label}
        />
      ))}
    </ul>
  );
}

function CrossMachineRow({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const view = useAtomValue(machineIndicator.machineIndicatorAtom(environmentId));
  const kind = useEnvironmentMachines().get(environmentId) ?? "server";
  return (
    <li>
      <Link
        to="/machines/$environmentId"
        params={{ environmentId }}
        className="flex min-w-0 items-center gap-2 px-3 py-2 text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
      >
        <EnvironmentMachineIcon
          kind={kind}
          environmentId={environmentId}
          className="size-4 shrink-0"
        />
        <span className="shrink-0 font-medium">{label}</span>
        <MachineVerdictLine view={view} className="min-w-0 text-xs" />
      </Link>
    </li>
  );
}
