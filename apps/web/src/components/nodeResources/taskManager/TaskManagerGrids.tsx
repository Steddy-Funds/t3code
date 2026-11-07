import {
  formatGiB,
  formatPercent,
  memoryUsedBytes,
} from "@t3tools/client-runtime/state/machineFormat";
import type { MachineStatusSnapshot, MachineVerdictRule } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { CellGrid } from "../charts/CellGrid";
import type { CellPool } from "../charts/CellPool";
import { vramTotal } from "../crossMachine/crossMachineModel";
import { MachineSection } from "../primitives/MachineSection";
import type { MachineSeries } from "./machineSeries";
import { type SnapshotResult, SnapshotText, useSnapshotValue } from "./snapshotValue";

const POOL_COLUMNS = 16;

function coreColumns(cores: number): number {
  if (cores <= 8) return Math.max(1, cores);
  return cores <= 32 ? 8 : 16;
}

const hasVram = (snapshot: MachineStatusSnapshot | null) =>
  vramTotal(snapshot?.sample?.gpus) !== null;
const memoryDetail = (snapshot: MachineStatusSnapshot | null) => {
  const totals = snapshot?.totals;
  return totals
    ? `${formatGiB(memoryUsedBytes(totals))} / ${formatGiB(totals.memoryTotalBytes)} GiB`
    : "";
};
const vramDetail = (snapshot: MachineStatusSnapshot | null) => {
  const vram = vramTotal(snapshot?.sample?.gpus);
  return vram ? `${formatGiB(vram.usedBytes)} / ${formatGiB(vram.totalBytes)} GiB` : "";
};

function poolLabel(name: string, pool: CellPool): string {
  const used = pool.segments.reduce((sum, segment) => sum + segment.cells, 0);
  return pool.total > 0 ? `${name} ${formatPercent((used / pool.total) * 100)} used` : name;
}

/** One sparkline cell per core, then the memory pool and, with a GPU that reports it, VRAM. */
export function TaskManagerGrids({
  series,
  source,
  rule,
}: {
  readonly series: MachineSeries;
  readonly source: Atom.Atom<SnapshotResult>;
  readonly rule: MachineVerdictRule | null;
}) {
  const vram = useSnapshotValue(source, hasVram);
  return (
    <div className="grid grid-cols-1 gap-3 @2xl/task-manager:grid-cols-3">
      <MachineSection
        title="Cores"
        detail={series.cores.columns}
        tripped={rule === "load" || rule === "cpu"}
      >
        <CellGrid
          ring={series.cores}
          columns={coreColumns(series.cores.columns)}
          max={100}
          label={() => `${series.cores.columns} cores`}
        />
      </MachineSection>
      <MachineSection
        title="Memory"
        tripped={rule === "memory" || rule === "memoryPressure"}
        detail={<SnapshotText source={source} select={memoryDetail} />}
      >
        <CellGrid
          pool={series.memoryPool}
          columns={POOL_COLUMNS}
          label={() => poolLabel("Memory", series.memoryPool)}
        />
      </MachineSection>
      {vram ? (
        <MachineSection
          title="VRAM"
          tripped={rule === "gpuVram"}
          detail={<SnapshotText source={source} select={vramDetail} />}
        >
          <CellGrid
            pool={series.vramPool}
            columns={POOL_COLUMNS}
            label={() => poolLabel("VRAM", series.vramPool)}
          />
        </MachineSection>
      ) : null}
    </div>
  );
}
