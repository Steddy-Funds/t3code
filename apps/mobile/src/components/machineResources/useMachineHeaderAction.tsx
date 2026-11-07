import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useState } from "react";

import { environmentPresentations } from "../../state/presentation";
import { machineIndicator } from "../../state/machineResources";
import { serverEnvironment } from "../../state/server";
import { ENVIRONMENT_MACHINE_SYMBOLS, machineSymbolState } from "../EnvironmentMachineSymbol";
import { MachineResourcesSheet } from "./MachineResourcesSheet";
import { useMachineStressColor } from "./stressColor";

export interface MachineHeaderAction {
  readonly accessibilityLabel: string;
  readonly icon: (typeof ENVIRONMENT_MACHINE_SYMBOLS)[keyof typeof ENVIRONMENT_MACHINE_SYMBOLS];
  /** Set only while stressed: header items take a static tint, never the drip. */
  readonly tintColor: string | undefined;
  readonly onPress: () => void;
}

/** The thread header's machine action, for machines that serve the verdict, and its sheet. */
export function useMachineHeaderAction(environmentId: EnvironmentId) {
  const indicator = useAtomValue(machineIndicator.machineIndicatorAtom(environmentId));
  const presentation = useAtomValue(environmentPresentations.presentationAtom(environmentId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const stressColor = useMachineStressColor();
  const [open, setOpen] = useState(false);
  const label = presentation?.entry.target.label ?? config?.environment.label ?? "Machine";
  const action: MachineHeaderAction | null = indicator.show
    ? {
        accessibilityLabel: `${label} machine resources`,
        icon: ENVIRONMENT_MACHINE_SYMBOLS[resolveEnvironmentMachineKind(config)],
        tintColor: machineSymbolState(indicator) === "stressed" ? stressColor : undefined,
        onPress: () => setOpen(true),
      }
    : null;
  const sheet = open ? (
    <MachineResourcesSheet
      environmentId={environmentId}
      title={label}
      onClose={() => setOpen(false)}
    />
  ) : null;
  return { action, sheet };
}
