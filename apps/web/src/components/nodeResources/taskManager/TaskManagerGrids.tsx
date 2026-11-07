import { formatGiB, memoryUsedBytes } from "@t3tools/client-runtime/state/machineFormat";
import type { MachineStatusSnapshot, MachineVerdictRule } from "@t3tools/contracts";

import { CellGrid } from "../charts/CellGrid";
import { vramTotal } from "../crossMachine/crossMachineModel";
import { MachineSection } from "../primitives/MachineSection";
import type { MachineSeries } from "./machineSeries";

const POOL_COLUMNS = 16;

function coreColumns(cores: number): number {
  if (cores <= 8) return Math.max(1, cores);
  return cores <= 32 ? 8 : 16;
}

/** One sparkline cell per core, then the memory pool and, with a GPU that reports it, VRAM. */
export function TaskManagerGrids({
  series,
  snapshot,
  rule,
}: {
  readonly series: MachineSeries;
  readonly snapshot: MachineStatusSnapshot | null;
  readonly rule: MachineVerdictRule | null;
}) {
  const totals = snapshot?.totals ?? null;
  const vram = vramTotal(snapshot?.sample?.gpus);
  return (
    <div className="grid grid-cols-1 gap-3 @2xl/task-manager:grid-cols-3">
      <MachineSection
        title="Cores"
        detail={totals ? `${totals.cpuCount}` : undefined}
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
        detail={
          totals
            ? `${formatGiB(memoryUsedBytes(totals))} / ${formatGiB(totals.memoryTotalBytes)} GiB`
            : undefined
        }
      >
        <CellGrid
          pool={series.memoryPool}
          columns={POOL_COLUMNS}
          label={() =>
            totals ? `Memory ${formatGiB(memoryUsedBytes(totals))} GiB used` : "Memory"
          }
        />
      </MachineSection>
      {vram === null ? null : (
        <MachineSection
          title="VRAM"
          tripped={rule === "gpuVram"}
          detail={`${formatGiB(vram.usedBytes)} / ${formatGiB(vram.totalBytes)} GiB`}
        >
          <CellGrid
            pool={series.vramPool}
            columns={POOL_COLUMNS}
            label={() => `VRAM ${formatGiB(vram.usedBytes)} GiB used`}
          />
        </MachineSection>
      )}
    </div>
  );
}
