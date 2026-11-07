import { useAtomSubscribe } from "@effect/atom-react";
import type { MachineStatusSnapshot } from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";
import { useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import {
  createMachineSeries,
  type MachineSeries,
  receiveMachineSnapshot,
  snapshotCores,
} from "./machineSeries";

type SnapshotResult = AsyncResult.AsyncResult<MachineStatusSnapshot, unknown>;

/**
 * The overview's rings and pools, fed straight from the stream so a tick redraws the canvases
 * without a React render. Null until the first snapshot names the core count.
 */
export function useMachineSeries(
  source: Atom.Atom<SnapshotResult>,
  tickMs: number,
): MachineSeries | null {
  const seriesRef = useRef<MachineSeries | null>(null);
  const [series, setSeries] = useState<MachineSeries | null>(null);
  const receive = useStableCallback((result: SnapshotResult) => {
    if (!AsyncResult.isSuccess(result)) return;
    const snapshot = result.value;
    const cores = Math.max(1, snapshotCores(snapshot));
    let target = seriesRef.current;
    if (target === null || target.tickMs !== tickMs || target.cores.columns !== cores) {
      target = createMachineSeries(tickMs, cores);
      seriesRef.current = target;
      setSeries(target);
    }
    receiveMachineSnapshot(target, snapshot, result.timestamp);
  });
  useAtomSubscribe(source, receive, { immediate: true });
  return series;
}
