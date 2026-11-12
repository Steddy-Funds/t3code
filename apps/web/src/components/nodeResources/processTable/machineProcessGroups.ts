import type { MachineProcessRow } from "@t3tools/client-runtime/state/machineProcessFrames";
import { processProviderGroup } from "@t3tools/shared/processProviderGroup";

import type { ProcessGroup } from "./processRows";

const OTHER: ProcessGroup = { id: "other", label: "Other" };

/**
 * Groups a frame's rows by provider, then container, then "Other". A process inherits the group of
 * its nearest ancestor that names one, so a provider's shells and tools land with the provider.
 */
export function machineProcessGroupOf(
  rows: ReadonlyArray<MachineProcessRow>,
): (row: MachineProcessRow) => ProcessGroup {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const groups = new Map<number, ProcessGroup>();

  const ownGroup = (row: MachineProcessRow): ProcessGroup | null => {
    const provider = processProviderGroup(row.name, row.command);
    if (provider !== undefined) {
      return { id: `provider:${provider}`, label: provider[0]!.toUpperCase() + provider.slice(1) };
    }
    if (row.containerId) {
      return {
        id: `container:${row.containerId}`,
        label: `container ${row.containerId.slice(0, 12)}`,
      };
    }
    return null;
  };

  return (row) => {
    const cached = groups.get(row.pid);
    if (cached) return cached;
    const chain: Array<MachineProcessRow> = [];
    const seen = new Set<number>();
    let current: MachineProcessRow | undefined = row;
    let group: ProcessGroup = OTHER;
    while (current !== undefined && !seen.has(current.pid)) {
      const known = groups.get(current.pid);
      if (known) {
        group = known;
        break;
      }
      seen.add(current.pid);
      chain.push(current);
      const own = ownGroup(current);
      if (own) {
        group = own;
        break;
      }
      current = byPid.get(current.ppid);
    }
    for (const visited of chain) groups.set(visited.pid, group);
    return group;
  };
}
