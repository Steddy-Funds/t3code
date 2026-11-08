import {
  type EnvironmentId,
  type MachineStatusSnapshot,
  type SubscribeMachineInput,
  type SubscribeMachineProcessesInput,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createMachineProcessFrameApplier,
  type MachineProcessTable,
} from "./machineProcessFrames.ts";
import { markMachineHistoryArrival } from "./machineHistory.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

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
  // Views with the same input share one stream, but the server sends history on the first
  // snapshot only, so every later snapshot keeps that same history object for a view that joins
  // late. Readers seed when the object changes, not on every snapshot.
  const live = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: MACHINE_STATUS_LABEL,
    tag: WS_METHODS.subscribeMachine,
    idleTtlMs: 0,
    transform: (snapshots) =>
      Stream.suspend(() => {
        let history: MachineStatusSnapshot["history"];
        return snapshots.pipe(
          Stream.mapEffect((snapshot) => {
            if (snapshot.history === undefined) {
              return Effect.succeed(history === undefined ? snapshot : { ...snapshot, history });
            }
            const first = snapshot.history;
            history = first;
            return Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                markMachineHistoryArrival(first, now);
                return snapshot;
              }),
            );
          }),
        );
      }),
  });
  const machine = (environmentId: EnvironmentId, input: SubscribeMachineInput = {}) =>
    input.intervalMs === undefined && input.historyMs === undefined
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

  // Guarded by `machine.claims.release`; read `releaseClaim.permissionAtom` for availability.
  const releaseClaim = createEnvironmentRpcCommand(runtime, {
    label: "machine:claims:release",
    tag: WS_METHODS.machineClaimsRelease,
  });

  // The server samples at most every 30 s; an idle thread's `current` is read when asked.
  const threadResourcesQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "machine:thread-resources",
    tag: WS_METHODS.serverGetThreadResources,
    staleTimeMs: 30_000,
  });
  const threadResources = (environmentId: EnvironmentId, threadId: ThreadId) =>
    threadResourcesQuery({ environmentId, input: { threadId } });

  return { machine, machineProcesses, releaseClaim, threadResources };
}
