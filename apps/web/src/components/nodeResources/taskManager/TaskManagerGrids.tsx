import {
  formatGiB,
  formatPercent,
  memoryUsedBytes,
} from "@t3tools/client-runtime/state/machineFormat";
import { useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MachineStatusSnapshot, MachineVerdictRule } from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";

import { useStableCallback } from "~/hooks/useStableCallback";

import { CellGrid } from "../charts/CellGrid";
import type { CellPool } from "../charts/CellPool";
import { vramTotal } from "../crossMachine/crossMachineModel";
import { ownerNamesAtom } from "../ownership/ownerNames";
import { ownerPaletteAtom, type ProcessesResult } from "../ownership/ownerPalette";
import { OTHER_OWNER_COLOR, topMemoryOwners } from "../ownership/processOwners";
import { MachineSection } from "../primitives/MachineSection";
import { OwnerChip } from "../primitives/OwnerChip";
import { ownerLabel } from "../primitives/OwnerLabel";
import { type MachineSeries, setMemoryOwners } from "./machineSeries";
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

/**
 * One sparkline cell per core, then the memory pool (used memory coloured by its top owners) and,
 * with a GPU that reports it, VRAM.
 */
export function TaskManagerGrids({
  environmentId,
  series,
  source,
  processes,
  rule,
}: {
  readonly environmentId: EnvironmentId;
  readonly series: MachineSeries;
  readonly source: Atom.Atom<SnapshotResult>;
  readonly processes: Atom.Atom<ProcessesResult>;
  readonly rule: MachineVerdictRule | null;
}) {
  const vram = useSnapshotValue(source, hasVram);
  // Frames recolour the pool straight from the stream, so a frame redraws the canvas without a render.
  const receiveProcesses = useStableCallback((result: ProcessesResult) => {
    const rows = AsyncResult.isSuccess(result) ? result.value.rows : null;
    setMemoryOwners(series, rows === null ? null : topMemoryOwners(rows));
  });
  useAtomSubscribe(processes, receiveProcesses, { immediate: true });
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
        <MemoryOwnerLegend environmentId={environmentId} processes={processes} />
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

/** The pool's owner colours; renders only when the top owners or their names change. */
function MemoryOwnerLegend({
  environmentId,
  processes,
}: {
  readonly environmentId: EnvironmentId;
  readonly processes: Atom.Atom<ProcessesResult>;
}) {
  const palette = useAtomValue(ownerPaletteAtom(processes));
  const names = useAtomValue(ownerNamesAtom(environmentId));
  if (palette.entries.length === 0) return null;
  return (
    <ul aria-label="Memory by owner" className="flex min-w-0 flex-wrap gap-1">
      {palette.entries.map((entry) => (
        <li key={entry.key} className="min-w-0">
          <OwnerChip label={ownerLabel(entry.owner, names)} color={`var(${entry.color})`} />
        </li>
      ))}
      <li>
        <OwnerChip label={{ kind: "other", text: "other" }} color={`var(${OTHER_OWNER_COLOR})`} />
      </li>
    </ul>
  );
}
