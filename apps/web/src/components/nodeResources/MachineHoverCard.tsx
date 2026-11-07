import { useAtomValue } from "@effect/atom-react";
import { formatGiB, type MachineIndicatorView } from "@t3tools/client-runtime/state/machineFormat";
import type { MachineProcessTable } from "@t3tools/client-runtime/state/machineProcessFrames";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ExecutionEnvironmentPlatformOs,
  type MachineStatusSnapshot,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useEnvironment } from "~/state/environments";
import { machineIndicator, machineResources } from "~/state/machineResources";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";

import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { MachineCardBody, type MachineLimits, type MachineProcessList } from "./MachineCardBody";
import { runningThreadCountAtom } from "./runningThreads";

const LIVE_SAMPLES = { intervalMs: 1000 } as const;
const TOP_PROCESSES = { intervalMs: 2000, top: 5 } as const;

type ProcessesResult = AsyncResult.AsyncResult<MachineProcessTable, unknown>;
const NO_PROCESSES: Atom.Atom<ProcessesResult> = Atom.make(AsyncResult.initial());

const OS_LABELS: Record<ExecutionEnvironmentPlatformOs, string | null> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
  unknown: null,
};

/** The machine card's content. Mount it only while the card is open: it holds live streams. */
export function MachineHoverCard({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const indicator = useAtomValue(machineIndicator.machineIndicatorAtom(environmentId));
  const environment = useEnvironment(environmentId);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const thresholds = config?.settings.machineResources.thresholds;
  const limits: MachineLimits | undefined = thresholds && {
    loadPerCore: thresholds.loadPerCore,
    memoryUsedPercent: thresholds.memoryUsedPercent,
  };
  const os = config ? OS_LABELS[config.environment.platform.os] : null;
  const label = environment?.label ?? null;
  const kind = resolveEnvironmentMachineKind(environment?.serverConfig ?? null);
  return (
    <div className="w-[372px] max-w-full">
      {indicator.unreachable ? (
        <>
          <MachineCardHeader environmentId={environmentId} label={label} kind={kind} details={os} />
          <MachineCardBody view={indicator} snapshot={null} processes={{ status: "loading" }} />
        </>
      ) : (
        <LiveMachineCard
          environmentId={environmentId}
          view={indicator}
          label={label}
          kind={kind}
          os={os}
          limits={limits}
        />
      )}
    </div>
  );
}

function LiveMachineCard({
  environmentId,
  view,
  label,
  kind,
  os,
  limits,
}: {
  readonly environmentId: EnvironmentId;
  readonly view: MachineIndicatorView;
  readonly label: string | null;
  readonly kind: EnvironmentMachineKind;
  readonly os: string | null;
  readonly limits: MachineLimits | undefined;
}) {
  // The verdict stream already holds the latest totals, so the card fills before live samples land.
  const cached = latestSnapshot(useAtomValue(machineResources.machine(environmentId)));
  const live = latestSnapshot(useAtomValue(machineResources.machine(environmentId, LIVE_SAMPLES)));
  const snapshot = live ?? cached;
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const processesResult = useAtomValue(
    canReadDiagnostics
      ? machineResources.machineProcesses(environmentId, TOP_PROCESSES)
      : NO_PROCESSES,
  );
  const runningThreadCount = useAtomValue(runningThreadCountAtom(environmentId));
  const totals = snapshot?.totals ?? null;
  const details = [
    os,
    totals ? `${totals.cpuCount} cores` : null,
    totals ? `${formatGiB(totals.memoryTotalBytes)} GiB` : null,
  ].filter((part) => part !== null);
  return (
    <>
      <MachineCardHeader
        environmentId={environmentId}
        label={label}
        kind={kind}
        details={details.length > 0 ? details.join(" · ") : null}
      />
      <MachineCardBody
        view={view}
        snapshot={snapshot}
        processes={canReadDiagnostics ? processList(processesResult) : { status: "needs-scope" }}
        runningThreadCount={runningThreadCount}
        {...(limits ? { limits } : {})}
      />
    </>
  );
}

function MachineCardHeader({
  environmentId,
  label,
  kind,
  details,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly kind: EnvironmentMachineKind;
  readonly details: string | null;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2.5 text-xs">
      <EnvironmentMachineIcon
        aria-hidden
        kind={kind}
        environmentId={environmentId}
        className="size-4 shrink-0 text-muted-foreground"
      />
      <span className="shrink-0 font-semibold text-foreground">{label ?? "Machine"}</span>
      {details ? <span className="min-w-0 truncate text-muted-foreground">{details}</span> : null}
    </div>
  );
}

function latestSnapshot(
  result: AsyncResult.AsyncResult<MachineStatusSnapshot, unknown>,
): MachineStatusSnapshot | null {
  return Option.getOrNull(AsyncResult.value(result));
}

function processList(result: ProcessesResult): MachineProcessList {
  const table = Option.getOrNull(AsyncResult.value(result));
  if (table !== null) {
    // The T3 subtree always holds the server itself, so an empty table means no monitor.
    return table.rows.length === 0
      ? { status: "needs-monitor" }
      : { status: "ready", source: table.source, rows: table.rows };
  }
  if (AsyncResult.isFailure(result)) {
    return { status: "error", message: errorMessage(result.cause) };
  }
  return { status: "loading" };
}

function errorMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message ? error.message : "Process list unavailable";
}
