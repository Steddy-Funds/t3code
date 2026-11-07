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

import { TimeSeriesCanvas } from "../charts/TimeSeriesCanvas";
import { MachineSection } from "../primitives/MachineSection";
import {
  GPU_COLUMN,
  gpuReadings,
  hasReadableGpu,
  MEMORY_COLUMN,
  type MachineSeries,
} from "./machineSeries";

const CHART = "h-28";
const percentLabel = (name: string, value: number) =>
  Number.isNaN(value) ? name : `${name} ${formatPercent(value)}`;

/** CPU, memory with swap dashed, load per core, and GPU with VRAM dashed (only with a GPU). */
export function TaskManagerGraphs({
  series,
  snapshot,
  rule,
  thresholds,
  windows,
}: {
  readonly series: MachineSeries;
  readonly snapshot: MachineStatusSnapshot | null;
  /** The rule that tripped the verdict; its graph is tinted. */
  readonly rule: MachineVerdictRule | null;
  readonly thresholds: MachineThresholds | undefined;
  /** The CPU rule judges Windows only, which has no load average. */
  readonly windows: boolean;
}) {
  const totals = snapshot?.totals ?? null;
  const usesPressure = totals?.memoryPressure != null;
  const hasSwap = (totals?.swapTotalBytes ?? 0) > 0;
  const gpu = hasReadableGpu(snapshot) ? gpuReadings(snapshot?.sample?.gpus) : null;
  const memoryTripped = rule === "memory" || rule === "memoryPressure";
  return (
    <div className="grid grid-cols-1 gap-3 @2xl/task-manager:grid-cols-2">
      <MachineSection
        title="CPU"
        tripped={rule === "cpu"}
        detail={
          totals?.cpuUtilization == null ? undefined : formatPercent(totals.cpuUtilization * 100)
        }
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
        detail={
          totals
            ? `${formatGiB(memoryUsedBytes(totals))} / ${formatGiB(totals.memoryTotalBytes)} GiB${
                hasSwap ? ` · swap ${formatGiB(totals.swapUsedBytes)} GiB` : ""
              }`
            : undefined
        }
      >
        <TimeSeriesCanvas
          ring={series.memory}
          lines={[
            { column: MEMORY_COLUMN.used },
            ...(hasSwap ? [{ column: MEMORY_COLUMN.swap, dashed: true }] : []),
          ]}
          max={100}
          tripped={memoryTripped}
          // macOS counts cache as used, so the pressure level replaces the RAM limit there.
          {...(!usesPressure && thresholds ? { threshold: thresholds.memoryUsedPercent } : {})}
          label={() => percentLabel("Memory", series.memory.latest(MEMORY_COLUMN.used))}
          className={CHART}
        />
      </MachineSection>
      {windows ? null : (
        <MachineSection
          title="Load / core"
          tripped={rule === "load"}
          detail={totals?.load ? formatPerCore(totals.load.one, totals.cpuCount) : undefined}
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
      {gpu === null ? null : (
        <MachineSection
          title="GPU"
          tripped={rule === "gpuUtil" || rule === "gpuVram"}
          detail={[
            Number.isNaN(gpu.util) ? null : formatPercent(gpu.util),
            Number.isNaN(gpu.vramPercent) ? null : `VRAM ${formatPercent(gpu.vramPercent)}`,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
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
      )}
    </div>
  );
}
