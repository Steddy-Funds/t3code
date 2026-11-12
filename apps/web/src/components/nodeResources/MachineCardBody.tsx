import {
  formatAge,
  formatGiB,
  formatPercent,
  formatPerCore,
  formatProcessMemory,
  gpuRowValues,
  gpuTrippedRule,
  type MachineIndicatorView,
  type MachineProcessSummary,
  memoryUsedBytes,
  memoryUsedPercent,
  type TopProcess,
  topProcessesByName,
} from "@t3tools/client-runtime/state/machineFormat";
import type {
  GpuDeviceSample,
  MachineStatusSnapshot,
  MachineTotalsSummary,
  MachineVerdictReason,
  ProcessOwner,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";

import { BurnRateValue } from "../sidebar/SidebarBurnRate";
import { MachineVerdictLine } from "./MachineVerdictLine";
import { ownersSummary } from "./ownership/processOwners";
import type { OwnerNames } from "./primitives/OwnerLabel";

export type MachineProcessList =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly source: "t3" | "host";
      readonly rows: ReadonlyArray<
        MachineProcessSummary & { readonly owner?: ProcessOwner | undefined }
      >;
    }
  | { readonly status: "needs-monitor" }
  | { readonly status: "needs-scope" }
  | { readonly status: "error"; readonly message: string };

export interface MachineLimits {
  readonly loadPerCore: number;
  readonly memoryUsedPercent: number;
}

const TOP_ROWS = 3;

/**
 * The hover card's content under its header: verdict, CPU and load, memory, top processes.
 * `snapshot` null means the first snapshot hasn't arrived. Unreachable shows the last one dimmed.
 */
export function MachineCardBody({
  view,
  snapshot,
  processes,
  limits,
  runningThreadCount,
  tokensPerMinute,
  ownerNames,
}: {
  readonly view: MachineIndicatorView;
  readonly snapshot: Pick<MachineStatusSnapshot, "totals" | "sample"> | null;
  /** Absent hides the section, as on a frozen snapshot. */
  readonly processes?: MachineProcessList;
  /** The machine's thresholds, when the caller knows them. */
  readonly limits?: MachineLimits;
  readonly runningThreadCount?: number;
  /** Shown beside the running threads while above zero. */
  readonly tokensPerMinute?: number;
  /** Resolves owner names; rows from a server with ownership then show who owns each top entry. */
  readonly ownerNames?: OwnerNames;
}) {
  const totals = snapshot?.totals ?? null;
  const staleAge = view.unreachable && view.lastSeen ? formatAge(view.lastSeen.ageMs) : null;
  const rule = view.unreachable ? null : view.reason?.rule;
  return (
    <div className="divide-y divide-border text-xs">
      <MachineVerdictLine view={view} className="block px-3 py-2.5" />
      {snapshot === null && !view.unreachable ? (
        <TotalsSkeleton />
      ) : totals ? (
        <div className={cn("divide-y divide-border", view.unreachable && "opacity-50")}>
          <CpuSection
            totals={totals}
            perCore={snapshot?.sample?.perCore}
            limits={limits}
            staleAge={staleAge}
            loadTripped={rule === "load"}
            cpuTripped={rule === "cpu"}
          />
          <MemorySection
            totals={totals}
            limits={limits}
            staleAge={staleAge}
            tripped={rule === "memory" || rule === "memoryPressure"}
          />
          {snapshot?.sample?.gpus && snapshot.sample.gpus.length > 0 ? (
            <GpuSection
              gpus={snapshot.sample.gpus}
              reason={view.unreachable ? null : view.reason}
            />
          ) : null}
        </div>
      ) : null}
      {view.unreachable || processes === undefined ? null : (
        <ProcessesSection processes={processes} ownerNames={ownerNames} />
      )}
      {runningThreadCount === undefined ? null : (
        <div className="flex items-center gap-2 px-3 py-2.5 text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">
            {runningThreadCount} T3 {runningThreadCount === 1 ? "thread" : "threads"} running
          </span>
          {tokensPerMinute !== undefined && tokensPerMinute > 0 ? (
            <BurnRateValue tokensPerMinute={tokensPerMinute} />
          ) : null}
        </div>
      )}
    </div>
  );
}

function Section({ children }: { readonly children: ReactNode }) {
  return <div className="px-3 py-2.5">{children}</div>;
}

function SectionTitle({
  title,
  value,
  className,
}: {
  readonly title: ReactNode;
  readonly value?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-1.5 flex items-baseline gap-1.5 text-2xs font-medium text-muted-foreground",
        className,
      )}
    >
      {title}
      {value === undefined ? null : (
        <span className="ms-auto text-foreground tabular-nums">{value}</span>
      )}
    </div>
  );
}

function withAge(value: string, staleAge: string | null): string {
  return staleAge ? `${value} · ${staleAge} old` : value;
}

function CpuSection({
  totals,
  perCore,
  limits,
  staleAge,
  loadTripped,
  cpuTripped,
}: {
  readonly totals: MachineTotalsSummary;
  readonly perCore: ReadonlyArray<number> | undefined;
  readonly limits: MachineLimits | undefined;
  readonly staleAge: string | null;
  readonly loadTripped: boolean;
  readonly cpuTripped: boolean;
}) {
  const cpu = totals.cpuUtilization === null ? null : formatPercent(totals.cpuUtilization * 100);
  const tripped = (on: boolean) => (on ? "text-error-foreground" : undefined);
  const load = totals.load;
  const details = [
    "per core",
    `${totals.cpuCount} cores`,
    limits ? `limit ${limits.loadPerCore}` : null,
  ].filter((part) => part !== null);
  return (
    <Section>
      <SectionTitle
        title="CPU"
        value={
          cpu === null ? undefined : (
            <span className={tripped(cpuTripped)}>{withAge(cpu, staleAge)}</span>
          )
        }
      />
      {load ? (
        <div className="flex items-baseline gap-2 tabular-nums">
          <span className="text-muted-foreground">Load</span>
          <span className={tripped(loadTripped)}>{formatPerCore(load.one, totals.cpuCount)}</span>
          <span className={cn("font-semibold", tripped(loadTripped))}>
            {formatPerCore(load.five, totals.cpuCount)}
          </span>
          <span>{formatPerCore(load.fifteen, totals.cpuCount)}</span>
          <span className="truncate text-muted-foreground">{details.join(" · ")}</span>
        </div>
      ) : null}
      {perCore && perCore.length > 0 ? <PerCoreStrip values={perCore} /> : null}
    </Section>
  );
}

function PerCoreStrip({ values }: { readonly values: ReadonlyArray<number> }) {
  return (
    <div className="mt-1.5 grid h-3.5 auto-cols-fr grid-flow-col gap-px">
      {values.map((percent, index) => (
        <i
          // oxlint-disable-next-line react/no-array-index-key -- the index is the core number
          key={index}
          className="block rounded-xs"
          style={{
            backgroundColor: `color-mix(in oklab, var(--primary) ${Math.max(5, Math.round(percent))}%, var(--accent))`,
          }}
        />
      ))}
    </div>
  );
}

function MemorySection({
  totals,
  limits,
  staleAge,
  tripped,
}: {
  readonly totals: MachineTotalsSummary;
  readonly limits: MachineLimits | undefined;
  readonly staleAge: string | null;
  readonly tripped: boolean;
}) {
  const usedPercent = memoryUsedPercent(totals);
  const used = `${formatGiB(memoryUsedBytes(totals))} / ${formatGiB(totals.memoryTotalBytes)} GiB`;
  // macOS counts cache as used, so pressure replaces the percent and the RAM limit.
  const usesPressure = totals.memoryPressure !== null;
  const available = [
    `${formatGiB(totals.memoryAvailableBytes)} GiB available`,
    !usesPressure && limits ? `limit ${limits.memoryUsedPercent}%` : null,
  ].filter((part) => part !== null);
  const pressure =
    totals.memoryPressure === "warn" || totals.memoryPressure === "critical"
      ? `Pressure ${totals.memoryPressure}`
      : null;
  return (
    <Section>
      <SectionTitle
        title="Memory"
        value={withAge(usesPressure ? used : `${used} · ${formatPercent(usedPercent)}`, staleAge)}
      />
      <div className="flex h-1.5 overflow-hidden rounded-full bg-accent">
        <span
          className={cn("block h-full", tripped ? "bg-(--machine-stress)" : "bg-primary")}
          style={{ width: `${Math.min(100, usedPercent)}%` }}
        />
      </div>
      <div className="mt-1 flex gap-2 text-2xs text-muted-foreground">
        <span>{available.join(" · ")}</span>
        {pressure ? (
          <span className={cn(tripped && "text-error-foreground")}>{pressure}</span>
        ) : null}
        {totals.swapTotalBytes > 0 ? (
          <span className="ms-auto tabular-nums">
            Swap {formatGiB(totals.swapUsedBytes)} / {formatGiB(totals.swapTotalBytes)} GiB
          </span>
        ) : null}
      </div>
    </Section>
  );
}

function GpuSection({
  gpus,
  reason,
}: {
  readonly gpus: ReadonlyArray<GpuDeviceSample>;
  readonly reason: MachineVerdictReason | null;
}) {
  return (
    <Section>
      <SectionTitle title={gpus.length === 1 ? "GPU" : "GPUs"} />
      <div className="flex flex-col gap-1">
        {gpus.map((gpu) => {
          const values = gpuRowValues(gpu);
          const tripped = gpuTrippedRule(reason, gpu.id);
          return (
            <div key={gpu.id} className="flex min-w-0 items-baseline gap-2 tabular-nums">
              <span className="min-w-0 flex-1 truncate">{gpu.name}</span>
              {values.note ? <span className="text-muted-foreground">{values.note}</span> : null}
              {values.vram ? (
                <span className={cn(tripped === "gpuVram" && "text-error-foreground")}>
                  {values.vram}
                </span>
              ) : null}
              {values.util ? (
                <span
                  className={cn("w-9 text-end", tripped === "gpuUtil" && "text-error-foreground")}
                >
                  {values.util}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function ProcessesSection({
  processes,
  ownerNames,
}: {
  readonly processes: MachineProcessList;
  readonly ownerNames: OwnerNames | undefined;
}) {
  switch (processes.status) {
    case "needs-monitor":
      return <ProcessNotice>Process list needs the resource monitor</ProcessNotice>;
    case "needs-scope":
      return <ProcessNotice>Process list needs diagnostics access</ProcessNotice>;
    case "error":
      return <ProcessNotice>{processes.message}</ProcessNotice>;
    case "loading":
      return (
        <Section>
          <div className="grid grid-cols-2 gap-3">
            <TopColumn title="Top by CPU" rows={null} />
            <TopColumn title="Top by memory" rows={null} />
          </div>
        </Section>
      );
    case "ready": {
      const scope = processes.source === "t3" ? " · T3" : "";
      const ownerOf = topOwnerSummary(processes.rows, ownerNames);
      return (
        <Section>
          <div className="grid grid-cols-2 gap-3">
            <TopColumn
              title={`Top by CPU${scope}`}
              rows={topProcessesByName(processes.rows, "cpu", TOP_ROWS).map((top) => ({
                top,
                value: formatPercent(top.value),
                owner: ownerOf(top.name),
              }))}
            />
            <TopColumn
              title={`Top by memory${scope}`}
              rows={topProcessesByName(processes.rows, "rss", TOP_ROWS).map((top) => ({
                top,
                value: formatProcessMemory(top.value),
                owner: ownerOf(top.name),
              }))}
            />
          </div>
        </Section>
      );
    }
  }
}

type CardProcessRows = Extract<MachineProcessList, { status: "ready" }>["rows"];

function topOwnerSummary(
  rows: CardProcessRows,
  names: OwnerNames | undefined,
): (name: string) => string | null {
  if (names === undefined || !rows.some((row) => row.owner !== undefined)) return () => null;
  const ownersByName = new Map<string, Array<ProcessOwner | undefined>>();
  for (const row of rows) {
    const owners = ownersByName.get(row.name);
    if (owners) owners.push(row.owner);
    else ownersByName.set(row.name, [row.owner]);
  }
  return (name) => ownersSummary(ownersByName.get(name) ?? [], names);
}

function ProcessNotice({ children }: { readonly children: ReactNode }) {
  return <div className="px-3 py-2.5 text-muted-foreground">{children}</div>;
}

const SKELETON_WIDTHS = ["85%", "70%", "78%"] as const;

function TopColumn({
  title,
  rows,
}: {
  readonly title: string;
  readonly rows: ReadonlyArray<{
    readonly top: TopProcess;
    readonly value: string;
    readonly owner?: string | null;
  }> | null;
}) {
  return (
    <div className="min-w-0">
      <SectionTitle title={title} className="mb-1" />
      {rows === null ? (
        <div className="mt-1 flex flex-col gap-1.75">
          {SKELETON_WIDTHS.map((width) => (
            <Skeleton key={width} className="h-2.5" style={{ width }} />
          ))}
        </div>
      ) : (
        rows.map(({ top, value, owner }) => (
          <div key={top.name} className="py-0.5">
            <div className="flex items-baseline gap-1.5">
              <span className="min-w-0 flex-1 truncate">
                {top.count > 1 ? `${top.name} ×${top.count}` : top.name}
              </span>
              <span className="tabular-nums">{value}</span>
            </div>
            {owner ? <div className="truncate text-muted-foreground">{owner}</div> : null}
          </div>
        ))
      )}
    </div>
  );
}

function TotalsSkeleton() {
  return (
    <div className="divide-y divide-border">
      <Section>
        <SectionTitle title="CPU" />
        <Skeleton className="h-3.5" />
      </Section>
      <Section>
        <SectionTitle title="Memory" />
        <Skeleton className="h-1.5" shape="pill" />
      </Section>
    </div>
  );
}
