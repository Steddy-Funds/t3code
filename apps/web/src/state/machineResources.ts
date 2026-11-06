import { createMachineIndicatorAtoms } from "@t3tools/client-runtime/state/machineIndicator";
import { createMachineResourcesAtoms } from "@t3tools/client-runtime/state/machineResources";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { serverEnvironment } from "./server";

export const machineResources = createMachineResourcesAtoms(connectionAtomRuntime);

export const machineIndicator = createMachineIndicatorAtoms({
  machine: machineResources.machine,
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  connectionStateAtom: environmentCatalog.stateAtom,
  configValueAtom: serverEnvironment.configValueAtom,
});
