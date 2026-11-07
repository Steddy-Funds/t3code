import { useAtomSubscribe } from "@effect/atom-react";
import { decodeMachineHistory } from "@t3tools/client-runtime/state/machineHistory";
import type { MachineStatusSnapshot } from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";
import { useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { CellGrid } from "../charts/CellGrid";
import { SeriesRing } from "../charts/SeriesRing";
import { CORE_GRID_CELLS, coreCellCount, groupCoreRow, groupCoreSeries } from "./crossMachineModel";

export const CORE_HISTORY_MS = 300_000;
// Each 18 px tall at the column's fixed width, matching the 20-cell layout.
const CELL_ASPECT = 0.45;

type SnapshotResult = AsyncResult.AsyncResult<MachineStatusSnapshot, unknown>;

/**
 * A row's 20-cell core grid. The ring outlives the stream, so an unreachable row keeps the line
 * where it was last seen; CellGrid skips drawing while the row is off screen.
 */
export function CrossMachineCores({
  source,
  tickMs,
}: {
  readonly source: Atom.Atom<SnapshotResult>;
  readonly tickMs: number;
}) {
  const ringRef = useRef<SeriesRing | null>(null);
  const [ring, setRing] = useState<SeriesRing | null>(null);
  const capacity = Math.round(CORE_HISTORY_MS / tickMs);

  const receive = useStableCallback((result: SnapshotResult) => {
    if (!AsyncResult.isSuccess(result)) return;
    const snapshot = result.value;
    const perCore = snapshot.sample?.perCore;
    const cells = coreCellCount(snapshot.history?.cores ?? perCore?.length ?? 0);
    if (cells === 0) return;
    let target = ringRef.current;
    if (target === null || target.columns !== cells || target.capacity !== capacity) {
      target = SeriesRing.create({ columns: cells, capacity });
      ringRef.current = target;
      setRing(target);
    }
    if (snapshot.history) {
      const history = decodeMachineHistory(snapshot.history, result.timestamp);
      target.seed(groupCoreSeries(history.perCore, cells), history.stepMs, history.endAtMs);
    }
    if (perCore && perCore.length > 0) {
      target.push(groupCoreRow(perCore, cells), result.timestamp - snapshot.sampleAgeMs);
    }
  });
  useAtomSubscribe(source, receive, { immediate: true });

  if (ring === null) return <span />;
  return (
    <CellGrid
      ring={ring}
      columns={CORE_GRID_CELLS}
      aspect={CELL_ASPECT}
      label={() => coresLabel(ring)}
    />
  );
}

function coresLabel(ring: SeriesRing): string {
  let peak = Number.NaN;
  for (let column = 0; column < ring.columns; column++) {
    const value = ring.latest(column);
    if (!Number.isNaN(value) && !(value <= peak)) peak = value;
  }
  return Number.isNaN(peak) ? "Cores" : `Cores, busiest ${Math.round(peak)}%`;
}
