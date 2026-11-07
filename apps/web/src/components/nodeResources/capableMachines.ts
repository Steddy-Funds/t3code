import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { machineIndicator } from "~/state/machineResources";
import { environmentSummaries } from "~/state/presentation";

interface MachineIdentity {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

const capableMachinesAtom = Atom.make((get) => {
  const next = get(environmentSummaries.identitiesAtom).filter((identity) =>
    get(machineIndicator.machineCapableAtom(identity.environmentId)),
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<MachineIdentity>>());
  return previous !== null &&
    previous.length === next.length &&
    next.every((identity, index) => identity === previous[index])
    ? previous
    : next;
}).pipe(Atom.withLabel("web-capable-machines"));

/** Machines that serve resource telemetry, in catalog order: the ones a task manager can open. */
export function useCapableMachines(): ReadonlyArray<MachineIdentity> {
  return useAtomValue(capableMachinesAtom);
}
