import type { HostResourcesSnapshot, MachineStatusSnapshot } from "@t3tools/contracts";

import { isMachineStatusFresh } from "./state/machineIndicator.ts";

interface Capacity {
  readonly cpuCount: number;
  readonly cpuUtilization: number;
  readonly memoryAvailable: number;
}

export interface LoadBalanceCandidate {
  readonly environmentId: string;
  readonly weight: number;
  readonly resources?: HostResourcesSnapshot | null;
  /** Client receipt time avoids comparing clocks on different machines. */
  readonly receivedAt?: number;
  /** Set for machines that push a verdict; replaces `resources` and its cut-offs. */
  readonly machine?: {
    readonly status: MachineStatusSnapshot | null;
    readonly receivedAt: number;
  };
}

function hostResourcesCapacity(candidate: LoadBalanceCandidate, now: number): Capacity | null {
  const resources = candidate.resources;
  if (!resources) return null;
  const sampledAt = candidate.receivedAt ?? resources.sampledAt;
  if (
    now - sampledAt > 15_000 ||
    sampledAt > now + 5_000 ||
    resources.cpuUtilization === null ||
    resources.cpuUtilization >= 0.95 ||
    resources.totalMemoryBytes <= 0 ||
    resources.cpuCount <= 0
  ) {
    return null;
  }
  const memoryAvailable = resources.availableMemoryBytes / resources.totalMemoryBytes;
  if (memoryAvailable <= 0.05) return null;
  return {
    cpuCount: resources.cpuCount,
    cpuUtilization: resources.cpuUtilization,
    memoryAvailable,
  };
}

// The verdict is the cut-off here, so the client, the server and `t3 guard` agree.
function machineCapacity(
  machine: NonNullable<LoadBalanceCandidate["machine"]>,
  now: number,
): Capacity | null {
  const totals = machine.status?.totals;
  if (
    machine.status?.verdict !== "ok" ||
    !isMachineStatusFresh(machine.receivedAt, now) ||
    !totals ||
    totals.cpuUtilization === null ||
    totals.cpuCount <= 0 ||
    totals.memoryTotalBytes <= 0
  ) {
    return null;
  }
  return {
    cpuCount: totals.cpuCount,
    cpuUtilization: totals.cpuUtilization,
    memoryAvailable: totals.memoryAvailableBytes / totals.memoryTotalBytes,
  };
}

/** Callers supply only connected machines hosting the project and selected provider. */
export function chooseLoadBalancedEnvironment(
  candidates: ReadonlyArray<LoadBalanceCandidate>,
  now: number,
): string | null {
  let selected: string | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.weight) || candidate.weight <= 0) continue;
    const capacity = candidate.machine
      ? machineCapacity(candidate.machine, now)
      : hostResourcesCapacity(candidate, now);
    if (!capacity) continue;
    const score =
      candidate.weight *
      capacity.cpuCount *
      (1 - capacity.cpuUtilization) *
      capacity.memoryAvailable;
    if (score > bestScore) {
      selected = candidate.environmentId;
      bestScore = score;
    }
  }
  return selected;
}
