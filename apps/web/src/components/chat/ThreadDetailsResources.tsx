import { useAtomValue } from "@effect/atom-react";
import {
  formatAge,
  formatPercent,
  formatProcessMemory,
} from "@t3tools/client-runtime/state/machineFormat";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ThreadId,
  type ThreadResourcePoint,
  type ThreadResources,
} from "@t3tools/contracts";
import { useEffect, type ReactNode } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadShell, useServerConfigs } from "../../state/entities";
import { machineResources } from "../../state/machineResources";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { SeriesRing } from "../nodeResources/charts/SeriesRing";
import { documentVisibleAtom } from "../nodeResources/documentVisible";
import { Sparkline } from "../nodeResources/primitives/Sparkline";
import { Unmeasured } from "../nodeResources/primitives/Unmeasured";
import { seedSparkline } from "../nodeResources/primitives/SparklineSeries";
import {
  idleSummary,
  RESOURCE_STEP_MS,
  RESOURCE_WINDOW_POINTS,
} from "./ThreadDetailsResources.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const READERS = [
  (point: ThreadResourcePoint) => point.cpuPercent,
  (point: ThreadResourcePoint) => point.memoryBytes,
  (point: ThreadResourcePoint) => point.gpuUtilPercent,
] as const;

/** A summary of the thread's resources; clicking it opens the machine tab focused on the thread. */
export function ThreadDetailsResources({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  // An older server has no thread resources.
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.machineOwnership === true;
  if (!canRead || !supported) return null;
  return <ResourcesSection environmentId={environmentId} threadId={threadId} />;
}

function ResourcesSection({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const query = useEnvironmentQuery(machineResources.threadResources(environmentId, threadId));
  const shell = useQuietThreadShell({ environmentId, threadId });
  const visible = useAtomValue(documentVisibleAtom);
  const { refresh } = query;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the server's 30 s measurements, which also cover terminals outside a turn
  useEffect(() => {
    if (!visible) return;
    const timer = setInterval(refresh, RESOURCE_STEP_MS);
    return () => clearInterval(timer);
  }, [visible, refresh]);

  const driver = useAtomValue(serverEnvironment.providersValueAtom(environmentId), (providers) =>
    shell === null
      ? undefined
      : providers?.find((provider) => provider.instanceId === shell.providerInstanceId)?.driver,
  );
  const openMachine = () =>
    useRightPanelStore.getState().openMachine({ environmentId, threadId }, environmentId, threadId);

  const resources = query.data;
  const body =
    resources === null ? (
      query.error === null ? null : (
        <p role="alert" className="px-2.5 text-xs text-error-foreground">
          Could not read this thread's resources.
        </p>
      )
    ) : (
      <ResourcesBody
        resources={resources}
        updatedAt={query.dataUpdatedAt}
        cursor={driver === "cursor"}
        onOpen={openMachine}
      />
    );
  return (
    <ThreadDetailsSection
      headingId="thread-details-resources-heading"
      title="Resources"
      actions={<span className="text-2xs text-muted-foreground">last 10 m</span>}
    >
      <div className="flex flex-col gap-2">{body}</div>
    </ThreadDetailsSection>
  );
}

function ResourcesBody({
  resources,
  updatedAt,
  cursor,
  onOpen,
}: {
  readonly resources: ThreadResources;
  readonly updatedAt: number;
  readonly cursor: boolean;
  readonly onOpen: () => void;
}) {
  // Seeded once per answer, so the sparklines draw on arrival and stay still in between.
  const ring = SeriesRing.create({ columns: READERS.length, capacity: RESOURCE_WINDOW_POINTS });
  seedSparkline(ring, resources.history, READERS, RESOURCE_STEP_MS, updatedAt);
  const current = resources.current;

  if (cursor && (current === null || current.processCount === 0)) {
    return (
      <OpenMachineButton summary="No processes" onOpen={onOpen}>
        <span className="text-muted-foreground">
          Cursor runs inside the T3 server, so only the shells it starts are counted. None are
          running now. To count a dev server it started, ask the agent to claim it.
        </span>
      </OpenMachineButton>
    );
  }
  if (current === null || current.processCount === 0) {
    const idle = idleSummary(resources.history);
    const parts = [
      "0 processes",
      idle.lastActiveMs === null ? null : `last active ${formatAge(idle.lastActiveMs)} ago`,
      idle.peakCpuPercent === null || idle.peakMemoryBytes === null
        ? null
        : `peak ${formatPercent(idle.peakCpuPercent)} CPU, ${formatProcessMemory(idle.peakMemoryBytes)}`,
    ].filter((part) => part !== null);
    return (
      <OpenMachineButton summary={parts.join(", ")} onOpen={onOpen}>
        <span className="text-muted-foreground">{parts.join(" · ")}</span>
        {resources.history.length > 0 ? (
          <Sparkline ring={ring} idle label={() => parts.join(", ")} />
        ) : null}
      </OpenMachineButton>
    );
  }

  const metrics = [
    {
      label: "CPU",
      column: 0,
      // Null when an idle read had no earlier sample to measure against.
      value: current.cpuPercent === null ? null : formatPercent(current.cpuPercent),
    },
    { label: "Mem", column: 1, value: formatProcessMemory(current.memoryBytes) },
    ...(current.gpuUtilPercent === null
      ? []
      : [{ label: "GPU", column: 2, value: formatPercent(current.gpuUtilPercent) }]),
  ];
  const count = current.processCount === 1 ? "1 process" : `${current.processCount} processes`;
  const summary = [
    count,
    ...metrics.map((metric) => `${metric.label} ${metric.value ?? "unmeasured"}`),
  ].join(", ");
  return (
    <OpenMachineButton summary={summary} onOpen={onOpen}>
      <span className="text-muted-foreground">{count}</span>
      <span className="grid grid-cols-[2.25rem_minmax(0,1fr)_3.25rem] items-center gap-x-2 gap-y-1">
        {metrics.map((metric) => (
          <MetricRow key={metric.label} ring={ring} {...metric} />
        ))}
      </span>
    </OpenMachineButton>
  );
}

/** The whole summary is one target; the machine tab holds the processes. */
function OpenMachineButton({
  summary,
  onOpen,
  children,
}: {
  readonly summary: string;
  readonly onOpen: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={`${summary}. Show on the machine tab`}
      onClick={onOpen}
      className="flex w-full flex-col gap-1 rounded-md px-2.5 py-1 text-start text-xs tabular-nums outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {children}
    </button>
  );
}

function MetricRow({
  ring,
  label,
  column,
  value,
}: {
  readonly ring: SeriesRing;
  readonly label: string;
  readonly column: number;
  /** Null when unmeasured; the cell shows a dash. */
  readonly value: string | null;
}) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <Sparkline ring={ring} column={column} label={() => `${label} ${value ?? "unmeasured"}`} />
      <span className="text-end">{value ?? <Unmeasured />}</span>
    </>
  );
}
