import type {
  ResourceMonitorProcessTableEntry,
  ResourceTelemetryProcessCategory,
  ServerProcessDiagnosticsEntry,
  ServerProcessDiagnosticsResult,
  ServerProcessSignal,
  ServerSignalProcessResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";

// Snapshot and process-table start times come from different boot-epoch reads at 1 s precision.
const START_TIME_TOLERANCE_MS = 1_000;

export class ProcessSignalFailed extends Schema.TaggedError<ProcessSignalFailed>()(
  "ProcessSignalFailed",
  {
    pid: Schema.Number,
    signal: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to signal process ${this.pid} with ${this.signal}.`;
  }
}

export class ProcessDiagnostics extends Context.Service<
  ProcessDiagnostics,
  {
    readonly read: Effect.Effect<ServerProcessDiagnosticsResult>;
    readonly signal: (input: {
      readonly pid: number;
      readonly startTimeMs: number;
      readonly signal: ServerProcessSignal;
    }) => Effect.Effect<ServerSignalProcessResult>;
  }
>()("t3/diagnostics/ProcessDiagnostics") {}

function formatElapsed(runTimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(runTimeMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function canSignalCategory(category: ResourceTelemetryProcessCategory): boolean {
  return (
    category === "server-child" || category === "provider-root" || category === "terminal-root"
  );
}

const matchesStartTime = (actual: number, expected: number) =>
  Math.abs(actual - expected) <= START_TIME_TOLERANCE_MS;

/** The server and every process above it, followed through the table's ppids. */
export function serverLineage(
  table: ReadonlyArray<ResourceMonitorProcessTableEntry>,
  serverPid: number,
): ReadonlySet<number> {
  const parents = new Map(table.map((entry) => [entry.pid, entry.ppid]));
  const lineage = new Set<number>();
  let pid: number | undefined = serverPid;
  while (pid !== undefined && pid > 0 && !lineage.has(pid)) {
    lineage.add(pid);
    pid = parents.get(pid);
  }
  return lineage;
}

/** Why a host-wide signal is refused, or null when the identity checks out. */
export function refuseHostSignal(
  table: ReadonlyArray<ResourceMonitorProcessTableEntry>,
  input: { readonly pid: number; readonly startTimeMs: number },
  guards: { readonly serverPid: number; readonly monitorPid: number },
): string | null {
  if (input.pid === guards.monitorPid) return "Refusing to signal the resource monitor.";
  if (serverLineage(table, guards.serverPid).has(input.pid)) {
    return "Refusing to signal the T3 server or a process it runs under.";
  }
  const entry = table.find((row) => row.pid === input.pid);
  if (
    entry === undefined ||
    entry.startTimeMs === undefined ||
    !matchesStartTime(entry.startTimeMs, input.startTimeMs)
  ) {
    return `Process ${input.pid} no longer matches the selected process identity.`;
  }
  return null;
}

const isPermissionError = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause.code === "EPERM" || cause.code === "EACCES");

/** @public */
export const make = Effect.fn("makeProcessDiagnostics")(function* () {
  const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
  const native = yield* NativeTelemetryClient.NativeTelemetryClient;
  const refreshedTelemetry = telemetry.refresh.pipe(Effect.catch(() => telemetry.latest));
  const read: ProcessDiagnostics["Service"]["read"] = refreshedTelemetry.pipe(
    Effect.map((snapshot) => {
      const processes = snapshot.processes
        .filter((entry) => canSignalCategory(entry.category))
        .map((entry): ServerProcessDiagnosticsEntry => ({
          pid: entry.identity.pid,
          startTimeMs: entry.identity.startTimeMs,
          ppid: entry.ppid,
          pgid: Option.none(),
          status: entry.status || "Unknown",
          cpuPercent: entry.cpuPercent,
          rssBytes: entry.residentBytes,
          elapsed: formatElapsed(entry.runTimeMs),
          command: entry.command || entry.name || "unknown",
          depth: Math.max(0, entry.depth - 1),
          childPids: entry.childPids,
        }));
      return {
        serverPid: process.pid,
        readAt: snapshot.readAt,
        processCount: processes.length,
        totalRssBytes: processes.reduce((total, entry) => total + entry.rssBytes, 0),
        totalCpuPercent: processes.reduce((total, entry) => total + entry.cpuPercent, 0),
        processes,
        error: Option.map(snapshot.health.native.lastError, (message) => ({ message })),
      };
    }),
  );

  /** Today's rule: a T3 backend descendant, rechecked against a fresh snapshot. */
  const refuseSubtreeSignal = Effect.fn("ProcessDiagnostics.refuseSubtreeSignal")(
    function* (input: { readonly pid: number; readonly startTimeMs: number }) {
      const current = yield* telemetry.refresh.pipe(Effect.option);
      if (Option.isNone(current)) {
        return `Could not refresh process ${input.pid}; refusing to signal a stale identity.`;
      }
      const selected = current.value.processes.find(
        (entry) =>
          entry.identity.pid === input.pid && entry.identity.startTimeMs === input.startTimeMs,
      );
      if (!selected) return `Process ${input.pid} no longer matches the selected process identity.`;
      if (!canSignalCategory(selected.category)) {
        return `Process ${input.pid} is not a signalable T3 backend descendant.`;
      }
      return null;
    },
  );

  const refuse = Effect.fn("ProcessDiagnostics.refuse")(function* (input: {
    readonly pid: number;
    readonly startTimeMs: number;
  }) {
    if (input.pid <= 1) return `Refusing to signal process ${input.pid}.`;
    if (input.pid === process.pid) return "Refusing to signal the T3 server process.";
    const hello = (yield* native.health).hello;
    if (Option.isNone(hello) || hello.value.capabilities.hostProcesses !== true) {
      return yield* refuseSubtreeSignal(input);
    }
    // Rechecked right before the signal, so a pid reused since the user picked it is refused.
    const table = yield* native.processTable.pipe(Effect.option);
    if (Option.isNone(table)) {
      return `Could not refresh process ${input.pid}; refusing to signal a stale identity.`;
    }
    return refuseHostSignal(table.value, input, {
      serverPid: process.pid,
      monitorPid: hello.value.sidecarPid,
    });
  });

  const signal: ProcessDiagnostics["Service"]["signal"] = Effect.fn("ProcessDiagnostics.signal")(
    function* (input) {
      const refused = yield* refuse(input);
      if (refused !== null) {
        return {
          pid: input.pid,
          signal: input.signal,
          signaled: false,
          message: Option.some(refused),
        };
      }
      return yield* Effect.try({
        try: () => {
          process.kill(input.pid, input.signal);
          return {
            pid: input.pid,
            signal: input.signal,
            signaled: true,
            message: Option.none(),
          };
        },
        catch: (cause) =>
          new ProcessSignalFailed({
            pid: input.pid,
            signal: input.signal,
            cause,
          }),
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            pid: input.pid,
            signal: input.signal,
            signaled: false,
            message: Option.some(
              isPermissionError(error.cause)
                ? `Not permitted to signal process ${input.pid}.`
                : error.message,
            ),
          }),
        ),
      );
    },
  );

  return ProcessDiagnostics.of({ read, signal });
});

export const layer = Layer.effect(ProcessDiagnostics, make());
