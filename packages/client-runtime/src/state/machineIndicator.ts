// @effect-diagnostics globalTimers:off globalDate:off - Expiry timers for atoms, outside an Effect runtime.
import type {
  EnvironmentId,
  MachineStatusSnapshot,
  MachineVerdict,
  MachineVerdictReason,
  ServerConfig,
  SubscribeMachineInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE, type SupervisorConnectionState } from "../connection/model.ts";
import {
  type EnvironmentConnectionPhase,
  presentConnectionState,
} from "../connection/presentation.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";

/** Judged by this client's receipt time, so clock skew between machines never matters. */
export const MACHINE_STATUS_STALE_MS = 75_000;

type MachineStatusResult = AsyncResult.AsyncResult<MachineStatusSnapshot, unknown>;

export interface MachineLastSeen {
  readonly verdict: MachineVerdict;
  readonly ageMs: number;
}

export interface MachineIndicator {
  /** False for machines that do not serve the verdict: draw the plain icon. */
  readonly show: boolean;
  readonly verdict: MachineVerdict;
  readonly unreachable: boolean;
  readonly lastSeen: MachineLastSeen | null;
  /** Only while stressed. */
  readonly reason: MachineVerdictReason | null;
}

const PLAIN: MachineIndicator = {
  show: false,
  verdict: "ok",
  unreachable: false,
  lastSeen: null,
  reason: null,
};

const PENDING: MachineIndicator = {
  show: true,
  verdict: "unknown",
  unreachable: false,
  lastSeen: null,
  reason: null,
};

export function isMachineStatusFresh(receivedAt: number, now: number): boolean {
  return now - receivedAt < MACHINE_STATUS_STALE_MS;
}

export function resolveMachineIndicator(input: {
  readonly capable: boolean;
  readonly result: MachineStatusResult;
  /** When this client received the result's value. */
  readonly receivedAt: number;
  readonly connection: EnvironmentConnectionPhase;
  readonly now: number;
}): MachineIndicator {
  if (!input.capable || input.connection === "unsupported") return PLAIN;
  const snapshot = Option.getOrNull(AsyncResult.value(input.result));
  if (snapshot === null) {
    return input.connection === "connected" ||
      input.connection === "connecting" ||
      input.connection === "available"
      ? PENDING
      : { ...PENDING, unreachable: true };
  }
  if (input.connection === "connected" && isMachineStatusFresh(input.receivedAt, input.now)) {
    return {
      show: true,
      verdict: snapshot.verdict,
      unreachable: false,
      lastSeen: null,
      reason: snapshot.verdict === "stressed" ? snapshot.reason : null,
    };
  }
  // Never a frozen verdict: an old snapshot only says when it was last seen.
  return {
    ...PENDING,
    unreachable: true,
    lastSeen: { verdict: snapshot.verdict, ageMs: Math.max(0, input.now - input.receivedAt) },
  };
}

function sameReason(a: MachineVerdictReason | null, b: MachineVerdictReason | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.rule === b.rule &&
    a.value === b.value &&
    a.threshold === b.threshold &&
    a.heldForMs === b.heldForMs &&
    a.deviceId === b.deviceId &&
    a.deviceName === b.deviceName
  );
}

function sameIndicator(a: MachineIndicator, b: MachineIndicator): boolean {
  return (
    a.show === b.show &&
    a.verdict === b.verdict &&
    a.unreachable === b.unreachable &&
    a.lastSeen?.verdict === b.lastSeen?.verdict &&
    a.lastSeen?.ageMs === b.lastSeen?.ageMs &&
    sameReason(a.reason, b.reason)
  );
}

function lastSuccess(
  result: MachineStatusResult,
): AsyncResult.Success<MachineStatusSnapshot, unknown> | null {
  if (AsyncResult.isSuccess(result)) return result;
  if (AsyncResult.isFailure(result)) return Option.getOrNull(result.previousSuccess);
  return null;
}

interface MachineAvailability {
  readonly capable: boolean;
  readonly connection: EnvironmentConnectionPhase;
}

// The "last seen N ago" label moves on in whole minutes while a machine stays unreachable.
const LAST_SEEN_REFRESH_MS = 60_000;

export function createMachineIndicatorAtoms(input: {
  readonly machine: (
    environmentId: EnvironmentId,
    input?: SubscribeMachineInput,
  ) => Atom.Atom<MachineStatusResult>;
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly connectionStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<SupervisorConnectionState, unknown>>;
  readonly configValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  const machineAvailabilityAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): MachineAvailability => {
      const entry = get(input.catalogValueAtom).entries.get(environmentId);
      const capable =
        entry?.enabled === true &&
        entry.unsupportedReason === undefined &&
        get(input.configValueAtom(environmentId))?.environment.capabilities.machineResources ===
          true;
      const connection = presentConnectionState(
        AsyncResult.getOrElse(
          get(input.connectionStateAtom(environmentId)),
          () => AVAILABLE_CONNECTION_STATE,
        ),
      ).phase;
      return { capable, connection };
    }).pipe(
      Atom.withEquality<MachineAvailability>(
        (a, b) => a.capable === b.capable && a.connection === b.connection,
      ),
      Atom.withLabel(`machine:availability:${environmentId}`),
    ),
  );

  /** Whether the machine serves the verdict; others keep `getHostResources`. */
  const machineCapableAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(machineAvailabilityAtom(environmentId)).capable),
  );

  // Survives the status subscription idling out, so an unreachable machine can say what it was.
  const remembered = new Map<EnvironmentId, AsyncResult.Success<MachineStatusSnapshot, unknown>>();

  const machineIndicatorAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): MachineIndicator => {
      const { capable, connection } = get(machineAvailabilityAtom(environmentId));
      if (!capable) return PLAIN;
      // Read only while connected, so the indicator never opens a subscription to a dead link.
      if (connection === "connected") {
        const success = lastSuccess(get(input.machine(environmentId)));
        if (success !== null) remembered.set(environmentId, success);
      }
      const success = remembered.get(environmentId) ?? null;
      const now = Date.now();
      const indicator = resolveMachineIndicator({
        capable,
        result: success ?? AsyncResult.initial(),
        receivedAt: success?.timestamp ?? 0,
        connection,
        now,
      });
      const delayMs =
        success === null
          ? null
          : !indicator.unreachable
            ? success.timestamp + MACHINE_STATUS_STALE_MS - now
            : indicator.lastSeen === null
              ? null
              : LAST_SEEN_REFRESH_MS - (indicator.lastSeen.ageMs % LAST_SEEN_REFRESH_MS);
      if (delayMs !== null) {
        const timer = setTimeout(() => get.refreshSelf(), Math.max(0, delayMs) + 1);
        get.addFinalizer(() => clearTimeout(timer));
      }
      return indicator;
    }).pipe(Atom.withEquality(sameIndicator), Atom.withLabel(`machine:indicator:${environmentId}`)),
  );

  const statusTargetsAtom = Atom.make((get) =>
    [...enabledEnvironmentIds(get(input.catalogValueAtom))].filter((environmentId) => {
      const { capable, connection } = get(machineAvailabilityAtom(environmentId));
      return capable && connection === "connected";
    }),
  ).pipe(Atom.withLabel("machine:status-targets"));

  /** Keeps the verdict stream open for every connected, capable machine for the app's life. */
  function startMachineStatus(registry: AtomRegistry.AtomRegistry): () => void {
    const mounted = new Map<EnvironmentId, () => void>();
    const unsubscribe = registry.subscribe(
      statusTargetsAtom,
      (environmentIds) => {
        const targets = new Set(environmentIds);
        for (const [environmentId, unmount] of mounted) {
          if (targets.has(environmentId)) continue;
          unmount();
          mounted.delete(environmentId);
        }
        for (const environmentId of targets) {
          if (!mounted.has(environmentId)) {
            mounted.set(environmentId, registry.mount(input.machine(environmentId)));
          }
        }
      },
      { immediate: true },
    );
    return () => {
      unsubscribe();
      for (const unmount of mounted.values()) unmount();
      mounted.clear();
    };
  }

  return { machineIndicatorAtom, machineCapableAtom, startMachineStatus };
}
