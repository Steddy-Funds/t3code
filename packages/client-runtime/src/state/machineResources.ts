import {
  type EnvironmentId,
  type SubscribeMachineInput,
  type SubscribeMachineProcessesInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createMachineProcessFrameApplier,
  type MachineProcessTable,
} from "./machineProcessFrames.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

const MACHINE_STATUS_LABEL = "machine:status";
const MACHINE_PROCESSES_LABEL = "machine:processes";

export function createMachineResourcesAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // The verdict alone is cheap and reused across views; live samples stop as soon as a view closes.
  const status = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: MACHINE_STATUS_LABEL,
    tag: WS_METHODS.subscribeMachine,
    idleTtlMs: 60_000,
  });
  const live = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: MACHINE_STATUS_LABEL,
    tag: WS_METHODS.subscribeMachine,
    idleTtlMs: 0,
  });
  const machine = (environmentId: EnvironmentId, input: SubscribeMachineInput = {}) =>
    input.intervalMs === undefined
      ? status({ environmentId, input: {} })
      : live({ environmentId, input });

  // Frames are diffs against this subscription's own keys, so each stream folds through its own applier.
  const processes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: MACHINE_PROCESSES_LABEL,
    tag: WS_METHODS.subscribeMachineProcesses,
    idleTtlMs: 0,
    transform: (frames) =>
      Stream.suspend(() => {
        const applier = createMachineProcessFrameApplier();
        return frames.pipe(
          Stream.map(applier.apply),
          Stream.filter((table): table is MachineProcessTable => table !== null),
        );
      }),
  });
  const machineProcesses = (environmentId: EnvironmentId, input: SubscribeMachineProcessesInput) =>
    processes({ environmentId, input });

  return { machine, machineProcesses };
}
