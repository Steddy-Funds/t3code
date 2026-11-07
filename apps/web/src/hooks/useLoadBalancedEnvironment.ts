import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  chooseLoadBalancedEnvironment,
  type LoadBalanceCandidate,
} from "@t3tools/client-runtime/load-balancing";
import { MACHINE_STATUS_STALE_MS } from "@t3tools/client-runtime/state/machineIndicator";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useContext } from "react";

import { machineIndicator, machineResources } from "../state/machineResources";
import { serverEnvironment } from "../state/server";

// Mirrors the freshness window in chooseLoadBalancedEnvironment.
const HOST_RESOURCES_FRESH_MS = 15_000;
// Capable machines push totals at this tick while a draft is choosing.
const MACHINE_TOTALS_INTERVAL_MS = 5_000;

interface CandidateResources extends Omit<LoadBalanceCandidate, "weight"> {
  readonly environmentId: EnvironmentId;
  readonly freshUntil: number;
  readonly pending: boolean;
  readonly failed: boolean;
}

// Keyed by content: callers derive the list every render.
const candidateResourcesAtom = Atom.family((environmentIdsKey: string) =>
  Atom.make((get) => {
    const evaluatedAt = Date.now();
    const resources = (
      environmentIdsKey === "" ? [] : (environmentIdsKey.split("\n") as EnvironmentId[])
    ).map((environmentId): CandidateResources => {
      if (get(machineIndicator.machineCapableAtom(environmentId))) {
        const result = get(
          machineResources.machine(environmentId, { intervalMs: MACHINE_TOTALS_INTERVAL_MS }),
        );
        const receivedAt = result._tag === "Success" ? result.timestamp : 0;
        return {
          environmentId,
          machine: { status: result._tag === "Success" ? result.value : null, receivedAt },
          freshUntil: receivedAt + MACHINE_STATUS_STALE_MS,
          pending: result._tag === "Initial",
          failed: result._tag === "Failure",
        };
      }
      const result = get(serverEnvironment.hostResources({ environmentId, input: {} }));
      const receivedAt = result._tag === "Success" ? result.timestamp : 0;
      return {
        environmentId,
        resources: result._tag === "Success" ? result.value : null,
        receivedAt,
        freshUntil: receivedAt + HOST_RESOURCES_FRESH_MS,
        pending: result._tag === "Initial" || result.waiting,
        failed: result._tag === "Failure",
      };
    });
    // Re-read when the next fresh snapshot ages out, so a frozen evaluatedAt never selects it.
    const nextExpiry = Math.min(
      ...resources
        .map((resource) => resource.freshUntil)
        .filter((expiresAt) => expiresAt >= evaluatedAt),
    );
    if (Number.isFinite(nextExpiry)) {
      const timer = setTimeout(() => get.refreshSelf(), nextExpiry - evaluatedAt + 1);
      get.addFinalizer(() => clearTimeout(timer));
    }
    return { evaluatedAt, resources };
  }),
);

/** Only mounted for unresolved automatic drafts, so idle clients do not poll hosts. */
export function useLoadBalancedEnvironment(
  environmentIds: readonly EnvironmentId[],
  weights: Readonly<Record<string, number>>,
) {
  const registry = useContext(RegistryContext);
  // Capable machines push their totals; only the others have a query to re-run.
  const refresh = (ids: readonly EnvironmentId[]) => {
    for (const environmentId of ids) {
      if (registry.get(machineIndicator.machineCapableAtom(environmentId))) continue;
      registry.refresh(serverEnvironment.hostResources({ environmentId, input: {} }));
    }
  };
  const { evaluatedAt, resources } = useAtomValue(
    candidateResourcesAtom(environmentIds.join("\n")),
  );
  const pending = resources.some((resource) => resource.pending);
  const environmentId = chooseLoadBalancedEnvironment(
    resources.map((resource) => ({
      ...resource,
      weight: weights[resource.environmentId] ?? 50,
    })),
    evaluatedAt,
  ) as EnvironmentId | null;
  return {
    refresh,
    pending,
    environmentId,
    failed: !pending && environmentId === null && resources.some((resource) => resource.failed),
  };
}
