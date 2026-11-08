import { useAtomValue } from "@effect/atom-react";
import {
  formatAge,
  formatPercent,
  formatProcessMemory,
} from "@t3tools/client-runtime/state/machineFormat";
import type { MachineProcessTable } from "@t3tools/client-runtime/state/machineProcessFrames";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ThreadId,
  type ThreadResourcePoint,
  type ThreadResources,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { useQuietThreadShell } from "../../state/entities";
import { machineResources } from "../../state/machineResources";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { SeriesRing } from "../nodeResources/charts/SeriesRing";
import { Sparkline } from "../nodeResources/primitives/Sparkline";
import { seedSparkline } from "../nodeResources/primitives/SparklineSeries";
import { Badge } from "../ui/badge";
import {
  idleSummary,
  RESOURCE_STEP_MS,
  RESOURCE_WINDOW_POINTS,
  threadProcessTree,
} from "./ThreadDetailsResources.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const PROCESS_INTERVAL_MS = 2_000;
const NO_PROCESSES: Atom.Atom<AsyncResult.AsyncResult<MachineProcessTable, unknown>> = Atom.make(
  AsyncResult.initial(),
);

const READERS = [
  (point: ThreadResourcePoint) => point.cpuPercent,
  (point: ThreadResourcePoint) => point.memoryBytes,
  (point: ThreadResourcePoint) => point.gpuUtilPercent,
] as const;

/** Mount only while the panel shows it: it holds the thread's process stream. */
export function ThreadDetailsResources({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  if (!canRead) return null;
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
  const running = shell?.runtime?.activeRunId != null;
  const { refresh } = query;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server rolls up every 30 s while a turn runs
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(refresh, RESOURCE_STEP_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  const driver = useAtomValue(serverEnvironment.providersValueAtom(environmentId), (providers) =>
    shell === null
      ? undefined
      : providers?.find((provider) => provider.instanceId === shell.providerInstanceId)?.driver,
  );
  const canReadProcesses = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const processes = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(
        canReadProcesses
          ? machineResources.machineProcesses(environmentId, {
              intervalMs: PROCESS_INTERVAL_MS,
              threadId,
            })
          : NO_PROCESSES,
      ),
    ),
  );

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
        processes={processes}
        cursor={driver === "cursor"}
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
  processes,
  cursor,
}: {
  readonly resources: ThreadResources;
  readonly updatedAt: number;
  readonly processes: MachineProcessTable | null;
  readonly cursor: boolean;
}) {
  // Seeded once per answer, so the sparklines draw on arrival and stay still in between.
  const ring = useMemo(() => {
    const next = SeriesRing.create({ columns: READERS.length, capacity: RESOURCE_WINDOW_POINTS });
    seedSparkline(next, resources.history, READERS, RESOURCE_STEP_MS, updatedAt);
    return next;
  }, [resources.history, updatedAt]);
  const current = resources.current;
  const rows = processes?.rows ?? [];

  if (cursor && (current === null || current.processCount === 0)) {
    return (
      <p className="px-2.5 text-xs text-muted-foreground">
        Cursor runs inside the T3 server, so only the shells it starts are counted. None are running
        now. To count a dev server it started, ask the agent to claim it, or claim it from the task
        manager.
      </p>
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
      <div className="flex flex-col gap-1 px-2.5">
        <p className="text-xs text-muted-foreground tabular-nums">{parts.join(" · ")}</p>
        {resources.history.length > 0 ? (
          <Sparkline ring={ring} idle label={() => parts.join(", ")} />
        ) : null}
      </div>
    );
  }

  const tree = threadProcessTree(rows);
  const claims = rows.filter((row) => row.owner?.type === "claimed").length;
  const count =
    claims > 0 ? `${current.processCount - claims} + ${claims} claimed` : current.processCount;
  const metrics = [
    { label: "CPU", column: 0, value: formatPercent(current.cpuPercent) },
    { label: "Mem", column: 1, value: formatProcessMemory(current.memoryBytes) },
    ...(current.gpuUtilPercent === null
      ? []
      : [{ label: "GPU", column: 2, value: formatPercent(current.gpuUtilPercent) }]),
  ];
  return (
    <div className="flex flex-col gap-2 px-2.5 text-xs tabular-nums">
      <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_3.25rem] items-center gap-x-2 gap-y-1">
        {metrics.map((metric) => (
          <MetricRow key={metric.label} ring={ring} {...metric} />
        ))}
      </div>
      {tree.lines.length === 0 ? null : (
        <div className="flex flex-col gap-0.5">
          <div className="text-2xs text-muted-foreground">Processes · {count}</div>
          {tree.lines.map((line) => (
            <div
              key={line.key}
              className="flex min-w-0 items-center gap-1.5"
              style={{ paddingInlineStart: `${line.depth * 0.75}rem` }}
            >
              <span
                className={
                  line.shared
                    ? "min-w-0 flex-1 truncate text-muted-foreground italic"
                    : "min-w-0 flex-1 truncate"
                }
              >
                {line.text}
              </span>
              {line.claimed ? (
                <Badge variant="info" size="sm">
                  claimed
                </Badge>
              ) : null}
              <span className="w-9 shrink-0 text-end text-muted-foreground">
                {line.cpu === null ? null : formatPercent(line.cpu)}
              </span>
            </div>
          ))}
          {tree.hidden > 0 ? (
            <div className="text-2xs text-muted-foreground">{tree.hidden} more</div>
          ) : null}
        </div>
      )}
    </div>
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
  readonly value: string;
}) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <Sparkline ring={ring} column={column} label={() => `${label} ${value}`} />
      <span className="text-end">{value}</span>
    </>
  );
}
