import {
  formatGiB,
  formatPercent,
  formatPerCore,
  memoryUsedBytes,
} from "@t3tools/client-runtime/state/machineFormat";
import type {
  MachineStatusSnapshot,
  MachineThresholds,
  MachineVerdictRule,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { TimeSeriesCanvas } from "../charts/TimeSeriesCanvas";
import { MachineSection } from "../primitives/MachineSection";
import { GPU_COLUMN, gpuReadings, MEMORY_COLUMN, type MachineSeries } from "./machineSeries";
import { type SnapshotResult, SnapshotText, useSnapshotValue } from "./snapshotValue";

const CHART = "h-28";
const percentLabel = (name: string, value: number) =>
  Number.isNaN(value) ? name : `${name} ${formatPercent(value)}`;

const hasSwap = (snapshot: MachineStatusSnapshot | null) =>
  (snapshot?.totals?.swapTotalBytes ?? 0) > 0;
const usesPressure = (snapshot: MachineStatusSnapshot | null) =>
  snapshot?.totals?.memoryPressure != null;

const cpuDetail = (snapshot: MachineStatusSnapshot | null) => {
  const cpu = snapshot?.totals?.cpuUtilization;
  return cpu == null ? "" : formatPercent(cpu * 100);
};
const memoryDetail = (snapshot: MachineStatusSnapshot | null) => {
  const totals = snapshot?.totals;
  if (!totals) return "";
  const swap = totals.swapTotalBytes > 0 ? ` · swap ${formatGiB(totals.swapUsedBytes)} GiB` : "";
  return `${formatGiB(memoryUsedBytes(totals))} / ${formatGiB(totals.memoryTotalBytes)} GiB${swap}`;
};
const loadDetail = (snapshot: MachineStatusSnapshot | null) => {
  const totals = snapshot?.totals;
  return totals?.load ? formatPerCore(totals.load.one, totals.cpuCount) : "";
};
const gpuDetail = (snapshot: MachineStatusSnapshot | null) => {
  const gpu = gpuReadings(snapshot?.sample?.gpus);
  return [
    Number.isNaN(gpu.util) ? null : formatPercent(gpu.util),
    Number.isNaN(gpu.vramPercent) ? null : `VRAM ${formatPercent(gpu.vramPercent)}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
};

/**
 * CPU, memory with swap dashed, load per core, and GPU with VRAM dashed (only with a GPU). The
 * canvases draw from the rings and the numbers are leaves on the stream, so a tick renders neither.
 */
export function TaskManagerGraphs({
  series,
  source,
  hasGpu,
  rule,
  thresholds,
  windows,
}: {
  readonly series: MachineSeries;
  readonly source: Atom.Atom<SnapshotResult>;
  readonly hasGpu: boolean;
  /** The rule that tripped the verdict; its graph is tinted. */
  readonly rule: MachineVerdictRule | null;
  readonly thresholds: MachineThresholds | undefined;
  /** The CPU rule judges Windows only, which has no load average. */
  readonly windows: boolean;
}) {
  const swap = useSnapshotValue(source, hasSwap);
  const pressure = useSnapshotValue(source, usesPressure);
  const memoryTripped = rule === "memory" || rule === "memoryPressure";
  return (
    <div className="grid grid-cols-1 gap-3 @2xl/task-manager:grid-cols-2">
      <MachineSection
        title="CPU"
        tripped={rule === "cpu"}
        detail={<SnapshotText source={source} select={cpuDetail} />}
      >
        <TimeSeriesCanvas
          ring={series.cpu}
          lines={[{ column: 0 }]}
          max={100}
          tripped={rule === "cpu"}
          {...(windows && thresholds ? { threshold: thresholds.windowsCpuPercent } : {})}
          label={() => percentLabel("CPU", series.cpu.latest())}
          className={CHART}
        />
      </MachineSection>
      <MachineSection
        title="Memory"
        tripped={memoryTripped}
        detail={<SnapshotText source={source} select={memoryDetail} />}
      >
        <TimeSeriesCanvas
          ring={series.memory}
          lines={[
            { column: MEMORY_COLUMN.used },
            ...(swap ? [{ column: MEMORY_COLUMN.swap, dashed: true }] : []),
          ]}
          max={100}
          tripped={memoryTripped}
          // macOS counts cache as used, so the pressure level replaces the RAM limit there.
          {...(!pressure && thresholds ? { threshold: thresholds.memoryUsedPercent } : {})}
          label={() => percentLabel("Memory", series.memory.latest(MEMORY_COLUMN.used))}
          className={CHART}
        />
      </MachineSection>
      {windows ? null : (
        <MachineSection
          title="Load / core"
          tripped={rule === "load"}
          detail={<SnapshotText source={source} select={loadDetail} />}
        >
          <TimeSeriesCanvas
            ring={series.load}
            lines={[{ column: 0 }]}
            tripped={rule === "load"}
            // The auto scale sits far below a 12.5 limit on a healthy machine; draw it once it's near.
            {...(rule === "load" && thresholds ? { threshold: thresholds.loadPerCore } : {})}
            label={() => {
              const load = series.load.latest();
              return Number.isNaN(load) ? "Load per core" : `Load per core ${load.toFixed(1)}`;
            }}
            className={CHART}
          />
        </MachineSection>
      )}
      {hasGpu ? (
        <MachineSection
          title="GPU"
          tripped={rule === "gpuUtil" || rule === "gpuVram"}
          detail={<SnapshotText source={source} select={gpuDetail} />}
        >
          <TimeSeriesCanvas
            ring={series.gpu}
            lines={[{ column: GPU_COLUMN.util }, { column: GPU_COLUMN.vram, dashed: true }]}
            max={100}
            tripped={rule === "gpuUtil" || rule === "gpuVram"}
            {...(thresholds ? { threshold: thresholds.gpuUtilPercent } : {})}
            label={() => percentLabel("GPU", series.gpu.latest(GPU_COLUMN.util))}
            className={CHART}
          />
        </MachineSection>
      ) : null}
    </div>
  );
}
