import type {
  GpuDeviceSample,
  HostPowerSnapshot,
  ResourceMonitorCapabilities,
  ResourceMonitorCommand,
  ResourceMonitorEvent,
  ResourceMonitorExternalProcess,
  ResourceMonitorGpuTotalsEvent,
  ResourceMonitorHelloEvent,
  ResourceMonitorHostProcessStatic,
  ResourceMonitorHostSampleEvent,
  ResourceMonitorHostSampleOptions,
  ResourceMonitorHostTotalsEvent,
  ResourceMonitorProcessTableEntry,
  ResourceMonitorProtocolVersion,
  ResourceMonitorSnapshotEvent,
  ResourceTelemetrySourceStatus,
} from "@t3tools/contracts";
import {
  MAX_CLAIMED_PROCESSES,
  RESOURCE_MONITOR_LEGACY_PROTOCOL_VERSION,
  RESOURCE_MONITOR_PROTOCOL_VERSION,
  ResourceMonitorCommand as ResourceMonitorCommandSchema,
  ResourceMonitorEvent as ResourceMonitorEventSchema,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";
import * as ServerConfig from "../config.ts";
import { subscribeBeforeSnapshotWithoutMutex } from "../utils/subscribeBeforeSnapshot.ts";

const SAMPLE_INTERVAL_MS = 1_000;
// The sidecar treats 0 as "sample only on request".
const IDLE_SAMPLE_INTERVAL_MS = 0;
const BATTERY_SAMPLE_INTERVAL_MS = 5_000;
const CONSTRAINED_SAMPLE_INTERVAL_MS = 15_000;
const HANDSHAKE_TIMEOUT = Duration.seconds(5);
const SAMPLE_REQUEST_TIMEOUT = Duration.seconds(5);
const PROCESS_TABLE_REQUEST_TIMEOUT = Duration.seconds(5);
const HISTORY_REQUEST_TIMEOUT = Duration.seconds(15);
// A one-shot host sample walks every process and reads static fields for all of them.
const HOST_SAMPLE_REQUEST_TIMEOUT = Duration.seconds(15);
const HOST_TOTALS_REQUEST_TIMEOUT = Duration.seconds(5);
const GPU_TOTALS_REQUEST_TIMEOUT = Duration.seconds(5);
// A full host sample with static fields for thousands of processes runs to a few MiB.
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const MIN_HOST_SAMPLE_INTERVAL_MS = 1_000;
const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 5;

export class NativeTelemetrySpawnFailed extends Schema.TaggedError<NativeTelemetrySpawnFailed>()(
  "NativeTelemetrySpawnFailed",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to start resource monitor '${this.path}'.`;
  }
}

export class NativeTelemetryHandshakeTimedOut extends Schema.TaggedError<NativeTelemetryHandshakeTimedOut>()(
  "NativeTelemetryHandshakeTimedOut",
  {
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor handshake timed out after ${this.timeoutMs}ms.`;
  }
}

class NativeTelemetryRequestTimedOut extends Schema.TaggedError<NativeTelemetryRequestTimedOut>()(
  "NativeTelemetryRequestTimedOut",
  {
    operation: Schema.Literals([
      "processTable",
      "readHistory",
      "sampleNow",
      "hostSampleNow",
      "hostTotals",
      "gpuTotals",
    ]),
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor '${this.operation}' request timed out after ${this.timeoutMs}ms.`;
  }
}

export class NativeTelemetryProtocolMismatch extends Schema.TaggedError<NativeTelemetryProtocolMismatch>()(
  "NativeTelemetryProtocolMismatch",
  {
    expectedVersion: Schema.Number,
    receivedVersion: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor protocol ${this.receivedVersion} is incompatible with expected protocol ${this.expectedVersion}.`;
  }
}

export class NativeTelemetryDecodeFailed extends Schema.TaggedError<NativeTelemetryDecodeFailed>()(
  "NativeTelemetryDecodeFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to decode resource monitor output.";
  }
}

export class NativeTelemetryCommandFailed extends Schema.TaggedError<NativeTelemetryCommandFailed>()(
  "NativeTelemetryCommandFailed",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Resource monitor command '${this.operation}' failed.`;
  }
}

export class NativeTelemetryExited extends Schema.TaggedError<NativeTelemetryExited>()(
  "NativeTelemetryExited",
  {
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor exited with code ${this.exitCode}.`;
  }
}

class NativeTelemetryStreamClosed extends Schema.TaggedError<NativeTelemetryStreamClosed>()(
  "NativeTelemetryStreamClosed",
  {},
) {
  override get message(): string {
    return "Resource monitor event stream closed unexpectedly.";
  }
}

export class NativeTelemetryUnavailable extends Schema.TaggedError<NativeTelemetryUnavailable>()(
  "NativeTelemetryUnavailable",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Resource monitor is unavailable: ${this.reason}`;
  }
}

export type NativeTelemetryClientError =
  | ResourceMonitorBinary.ResourceMonitorBinaryError
  | NativeTelemetrySpawnFailed
  | NativeTelemetryHandshakeTimedOut
  | NativeTelemetryRequestTimedOut
  | NativeTelemetryProtocolMismatch
  | NativeTelemetryDecodeFailed
  | NativeTelemetryCommandFailed
  | NativeTelemetryExited
  | NativeTelemetryStreamClosed
  | NativeTelemetryUnavailable;

export interface NativeTelemetryClientHealth {
  readonly status: ResourceTelemetrySourceStatus;
  readonly hello: Option.Option<ResourceMonitorHelloEvent>;
  readonly lastSampleAt: Option.Option<DateTime.Utc>;
  readonly lastError: Option.Option<string>;
  readonly restartCount: number;
  readonly sampleIntervalMs: number;
}

export interface NativeTelemetrySnapshot {
  readonly generation: number;
  readonly snapshot: ResourceMonitorSnapshotEvent;
}

export type HostProcessStatics = ReadonlyMap<number, ResourceMonitorHostProcessStatic>;

export interface NativeHostSample {
  readonly generation: number;
  readonly sample: ResourceMonitorHostSampleEvent;
  /**
   * Static fields by pid for this generation, folded before publishing, so a subscriber that
   * missed a sample still has every identity. Check `startTimeMs` against the row.
   */
  readonly statics: HostProcessStatics;
}

export interface HostSampleDemand extends ResourceMonitorHostSampleOptions {
  /** Raised to at least 1 s. */
  readonly intervalMs: number;
}

export class NativeTelemetryClient extends Context.Service<
  NativeTelemetryClient,
  {
    readonly capabilities: Effect.Effect<ResourceMonitorCapabilities, NativeTelemetryClientError>;
    readonly snapshots: Stream.Stream<NativeTelemetrySnapshot, NativeTelemetryClientError>;
    readonly readHistory: (
      windowMs: number,
    ) => Effect.Effect<ReadonlyArray<ResourceMonitorSnapshotEvent>, NativeTelemetryClientError>;
    readonly setExternalProcesses: (
      processes: ReadonlyArray<ResourceMonitorExternalProcess>,
    ) => Effect.Effect<void, NativeTelemetryClientError>;
    readonly setHostPowerState: (
      snapshot: HostPowerSnapshot,
    ) => Effect.Effect<void, NativeTelemetryClientError>;
    readonly sampleNow: Effect.Effect<NativeTelemetrySnapshot, NativeTelemetryClientError>;
    readonly processTable: Effect.Effect<
      ReadonlyArray<ResourceMonitorProcessTableEntry>,
      NativeTelemetryClientError
    >;
    /**
     * Host-wide samples while the stream runs. Concurrent streams share one native stream at
     * the fastest interval and the union of fields. Emits nothing from a monitor without
     * `capabilities.hostProcesses`.
     */
    readonly hostSamples: (
      demand: HostSampleDemand,
    ) => Stream.Stream<NativeHostSample, NativeTelemetryClientError>;
    readonly hostSampleNow: (
      options: ResourceMonitorHostSampleOptions,
    ) => Effect.Effect<NativeHostSample, NativeTelemetryClientError>;
    /** macOS memory pressure, available memory and swap; null fields elsewhere. */
    readonly hostTotals: Effect.Effect<ResourceMonitorHostTotalsEvent, NativeTelemetryClientError>;
    /** Device totals only, no process walk; suspended devices are never woken. */
    readonly gpuTotals: Effect.Effect<ReadonlyArray<GpuDeviceSample>, NativeTelemetryClientError>;
    /** Claimed process roots; kept apart from Electron's external processes and resent on restart. */
    readonly setClaimedProcesses: (
      processes: ReadonlyArray<ResourceMonitorExternalProcess>,
    ) => Effect.Effect<void, NativeTelemetryClientError>;
    readonly retry: Effect.Effect<boolean>;
    readonly health: Effect.Effect<NativeTelemetryClientHealth>;
    readonly subscribeHealth: Effect.Effect<
      {
        readonly latest: NativeTelemetryClientHealth;
        readonly changes: Stream.Stream<NativeTelemetryClientHealth>;
      },
      never,
      Scope.Scope
    >;
  }
>()("t3/resourceTelemetry/NativeTelemetryClient") {}

interface ClientState {
  readonly status: ResourceTelemetrySourceStatus;
  readonly handle: Option.Option<ChildProcessSpawner.ChildProcessHandle>;
  readonly hello: Option.Option<ResourceMonitorHelloEvent>;
  readonly lastSampleAt: Option.Option<DateTime.Utc>;
  readonly lastError: Option.Option<string>;
  readonly restartCount: number;
}

export interface CollectionControl {
  readonly hostPower: HostPowerSnapshot;
  readonly liveSubscriberCount: number;
  readonly sampleIntervalMs: number;
}

interface PendingHistoryRequest {
  readonly deferred: Deferred.Deferred<
    ReadonlyArray<ResourceMonitorSnapshotEvent>,
    NativeTelemetryClientError
  >;
  readonly snapshots: ReadonlyArray<ResourceMonitorSnapshotEvent>;
}

type RequestOperation = NativeTelemetryRequestTimedOut["operation"];

type PendingReplies<A> = Ref.Ref<Map<string, Deferred.Deferred<A, NativeTelemetryClientError>>>;

const HOST_STREAMING_OFF: HostSampleDemand = {
  intervalMs: 0,
  processes: false,
  gpus: false,
  gpuProcesses: false,
};

/** The fastest interval and the union of fields over every open host stream. */
export function combineHostSampleDemand(
  demands: Iterable<HostSampleDemand>,
  gpusAllowed: boolean,
): HostSampleDemand {
  let combined = HOST_STREAMING_OFF;
  for (const demand of demands) {
    const intervalMs = Math.max(MIN_HOST_SAMPLE_INTERVAL_MS, Math.round(demand.intervalMs));
    combined = {
      intervalMs:
        combined.intervalMs === 0 ? intervalMs : Math.min(combined.intervalMs, intervalMs),
      processes: combined.processes || demand.processes,
      gpus: combined.gpus || (gpusAllowed && demand.gpus),
      gpuProcesses: combined.gpuProcesses || (gpusAllowed && demand.gpuProcesses),
    };
  }
  return combined;
}

function sameHostSampleDemand(left: HostSampleDemand, right: HostSampleDemand): boolean {
  return (
    left.intervalMs === right.intervalMs &&
    left.processes === right.processes &&
    left.gpus === right.gpus &&
    left.gpuProcesses === right.gpuProcesses
  );
}

/**
 * Applies one sample's static fields to the generation's table. Identities missing from the
 * sample's process columns are dropped; the previous table is reused when nothing changed.
 */
export function foldHostStatics(
  previous: HostProcessStatics,
  sample: ResourceMonitorHostSampleEvent,
): HostProcessStatics {
  const base = sample.staticReset ? new Map<number, ResourceMonitorHostProcessStatic>() : previous;
  const columns = sample.processes;
  if (!columns) return base;
  const live = new Set(columns.pid);
  const added = sample.added ?? [];
  let pruned = false;
  for (const pid of base.keys()) {
    if (!live.has(pid)) {
      pruned = true;
      break;
    }
  }
  if (!pruned && added.length === 0) return base;
  const next = new Map<number, ResourceMonitorHostProcessStatic>();
  for (const [pid, entry] of base) {
    if (live.has(pid)) next.set(pid, entry);
  }
  for (const entry of added) next.set(entry.pid, entry);
  return next;
}

function protocolVersionOf(current: ClientState): ResourceMonitorProtocolVersion {
  return Option.match(current.hello, {
    onNone: () => RESOURCE_MONITOR_LEGACY_PROTOCOL_VERSION,
    onSome: (hello) => hello.version,
  });
}

/** A monitor binary built before v4 lacks the host, claim and GPU commands. */
function speaksV4(current: ClientState): boolean {
  return protocolVersionOf(current) === RESOURCE_MONITOR_PROTOCOL_VERSION;
}

function isSupportedProtocolVersion(version: number): boolean {
  return (
    version === RESOURCE_MONITOR_PROTOCOL_VERSION ||
    version === RESOURCE_MONITOR_LEGACY_PROTOCOL_VERSION
  );
}

const initialState: ClientState = {
  status: "starting",
  handle: Option.none(),
  hello: Option.none(),
  lastSampleAt: Option.none(),
  lastError: Option.none(),
  restartCount: 0,
};

function toHealth(state: ClientState, sampleIntervalMs: number): NativeTelemetryClientHealth {
  return {
    status: state.status,
    hello: state.hello,
    lastSampleAt: state.lastSampleAt,
    lastError: state.lastError,
    restartCount: state.restartCount,
    sampleIntervalMs,
  };
}

function isThermallyConstrained(snapshot: HostPowerSnapshot): boolean {
  return snapshot.thermalState === "serious" || snapshot.thermalState === "critical";
}

// Without a live subscriber the sidecar does not sample on a timer, so an idle server
// never walks the process table. History then covers only time with a subscriber.
function resolveNativeSampleIntervalMs(
  snapshot: HostPowerSnapshot,
  liveSubscriberCount: number,
): number {
  if (liveSubscriberCount === 0) return IDLE_SAMPLE_INTERVAL_MS;
  if (snapshot.stale || snapshot.source === "unknown") return SAMPLE_INTERVAL_MS;
  if (
    snapshot.suspended ||
    snapshot.locked === "true" ||
    snapshot.lowPowerMode === "true" ||
    isThermallyConstrained(snapshot)
  ) {
    return CONSTRAINED_SAMPLE_INTERVAL_MS;
  }
  if (snapshot.onBattery === "true") return BATTERY_SAMPLE_INTERVAL_MS;
  return SAMPLE_INTERVAL_MS;
}

// Desktop power samples also commit control state; avoid a span for each sample.
export const commitCollectionControlUpdate = Effect.fnUntraced(function* <E, R>(
  desiredState: Ref.Ref<CollectionControl>,
  appliedState: Ref.Ref<CollectionControl>,
  update: (current: CollectionControl) => CollectionControl,
  apply: (previous: CollectionControl, next: CollectionControl) => Effect.Effect<void, E, R>,
): Effect.fn.Return<readonly [CollectionControl, CollectionControl], E, R> {
  const [previousDesired, next] = yield* Ref.modify(desiredState, (previous) => {
    const next = update(previous);
    return [[previous, next] as const, next];
  });
  const previousApplied = yield* Ref.get(appliedState);
  yield* apply(previousApplied, next);
  yield* Ref.set(appliedState, next);
  return [previousDesired, next] as const;
});

export function synchronizeCollectionControlOnStart<E1, R1, E2, R2>(
  mutex: Semaphore.Semaphore,
  desiredState: Ref.Ref<CollectionControl>,
  appliedState: Ref.Ref<CollectionControl>,
  apply: (control: CollectionControl) => Effect.Effect<void, E1, R1>,
  markReady: Effect.Effect<void, E2, R2>,
) {
  return mutex.withPermits(1)(
    Effect.gen(function* () {
      const control = yield* Ref.get(desiredState);
      yield* apply(control);
      yield* Ref.set(appliedState, control);
      yield* markReady;
      return control;
    }),
  );
}

const decodeMonitorEvent: (
  value: unknown,
) => Effect.Effect<ResourceMonitorEvent, Schema.SchemaError> = Schema.decodeUnknownEffect(
  ResourceMonitorEventSchema,
);
const encodeMonitorCommand = Schema.encodeEffect(
  Schema.fromJsonString(ResourceMonitorCommandSchema),
);
const isProtocolMismatch = Schema.is(NativeTelemetryProtocolMismatch);
const isDecodeFailed = Schema.is(NativeTelemetryDecodeFailed);
const isCommandFailed = Schema.is(NativeTelemetryCommandFailed);
const isExited = Schema.is(NativeTelemetryExited);
const isStreamClosed = Schema.is(NativeTelemetryStreamClosed);

export function eventVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = Reflect.get(value, "version");
  return typeof version === "number" ? version : undefined;
}

function restartDelay(attempt: number): Duration.Duration {
  return Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);
}

function retainRecentNativeTelemetryFailures(
  failures: ReadonlyArray<number>,
  now: number,
): ReadonlyArray<number> {
  return failures.filter((failedAt) => now - failedAt <= FAILURE_WINDOW_MS);
}

function errorMessage(error: NativeTelemetryClientError): string {
  return error.message;
}

function canRequestNativeTelemetryRetry(
  status: ResourceTelemetrySourceStatus,
  hasHandle: boolean,
): boolean {
  return status !== "healthy" && status !== "starting" && !hasHandle;
}

function canCommandNativeTelemetrySidecar(
  status: ResourceTelemetrySourceStatus,
  hasHandle: boolean,
): boolean {
  return hasHandle && (status === "healthy" || status === "degraded");
}

/** @public */
export const make = Effect.fn("resourceTelemetry.nativeTelemetryClient.make")(function* () {
  const binary = yield* ResourceMonitorBinary.ResourceMonitorBinary;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const random = yield* SecureRandom.SecureRandom;
  const config = yield* ServerConfig.ServerConfig;
  const initializedAt = yield* DateTime.now;
  const state = yield* Ref.make(initialState);
  const collectionControl = yield* Ref.make<CollectionControl>({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: initializedAt,
    },
    liveSubscriberCount: 0,
    sampleIntervalMs: IDLE_SAMPLE_INTERVAL_MS,
  });
  const appliedCollectionControl = yield* Ref.make(yield* Ref.get(collectionControl));
  const externalProcesses = yield* Ref.make<ReadonlyArray<ResourceMonitorExternalProcess>>([]);
  const pendingSamples = yield* Ref.make(
    new Map<string, Deferred.Deferred<NativeTelemetrySnapshot, NativeTelemetryClientError>>(),
  );
  const pendingProcessTables = yield* Ref.make(
    new Map<
      string,
      Deferred.Deferred<ReadonlyArray<ResourceMonitorProcessTableEntry>, NativeTelemetryClientError>
    >(),
  );
  const pendingHistories = yield* Ref.make(new Map<string, PendingHistoryRequest>());
  const pendingHostSamples: PendingReplies<NativeHostSample> = yield* Ref.make(new Map());
  const pendingHostTotals: PendingReplies<ResourceMonitorHostTotalsEvent> = yield* Ref.make(
    new Map(),
  );
  const pendingGpuTotals: PendingReplies<ResourceMonitorGpuTotalsEvent> = yield* Ref.make(
    new Map(),
  );
  const claimedProcesses = yield* Ref.make<ReadonlyArray<ResourceMonitorExternalProcess>>([]);
  const hostDemands = yield* Ref.make(new Map<number, HostSampleDemand>());
  const nextHostDemandId = yield* Ref.make(0);
  const appliedHostDemand = yield* Ref.make(HOST_STREAMING_OFF);
  const hostMutex = yield* Semaphore.make(1);
  const hostStatics = yield* Ref.make<{
    readonly generation: number;
    readonly table: HostProcessStatics;
  }>({ generation: -1, table: new Map() });
  const hostSamplePubSub = yield* PubSub.sliding<NativeHostSample>(4);
  // GPU code runs inside the monitor: after a crash with GPUs in use, or the monitor's own
  // `gpu-unavailable`, GPUs stay off until the server restarts.
  const gpuState = yield* Ref.make({ usedThisGeneration: false, off: false });
  const snapshots = yield* PubSub.sliding<NativeTelemetrySnapshot>(8);
  const healthChanges = yield* PubSub.sliding<NativeTelemetryClientHealth>(4);
  const retryQueue = yield* Queue.sliding<void>(1);
  const commandMutex = yield* Semaphore.make(1);
  const controlMutex = yield* Semaphore.make(1);
  const currentHealth = Effect.all([Ref.get(state), Ref.get(collectionControl)]).pipe(
    Effect.map(([current, control]) => toHealth(current, control.sampleIntervalMs)),
  );
  const publishHealth = currentHealth.pipe(
    Effect.flatMap((health) => PubSub.publish(healthChanges, health)),
    Effect.asVoid,
  );

  const failPending = Effect.fn("NativeTelemetryClient.failPending")(function* (
    error: NativeTelemetryClientError,
  ) {
    const samples = yield* Ref.getAndSet(pendingSamples, new Map());
    const processTables = yield* Ref.getAndSet(pendingProcessTables, new Map());
    const histories = yield* Ref.getAndSet(pendingHistories, new Map());
    const replies = [
      ...(yield* Ref.getAndSet(pendingHostSamples, new Map())).values(),
      ...(yield* Ref.getAndSet(pendingHostTotals, new Map())).values(),
      ...(yield* Ref.getAndSet(pendingGpuTotals, new Map())).values(),
    ];
    yield* Effect.forEach(replies, (deferred) => Deferred.fail(deferred, error), {
      discard: true,
    });
    yield* Effect.forEach(samples.values(), (deferred) => Deferred.fail(deferred, error), {
      discard: true,
    });
    yield* Effect.forEach(processTables.values(), (deferred) => Deferred.fail(deferred, error), {
      discard: true,
    });
    yield* Effect.forEach(histories.values(), (request) => Deferred.fail(request.deferred, error), {
      discard: true,
    });
  });

  const writeCommand = (
    handle: ChildProcessSpawner.ChildProcessHandle,
    command: ResourceMonitorCommand,
  ): Effect.Effect<void, NativeTelemetryClientError> =>
    commandMutex.withPermits(1)(
      encodeMonitorCommand(command).pipe(
        Effect.map((encoded) => `${encoded}\n`),
        Effect.mapError(
          (cause) =>
            new NativeTelemetryCommandFailed({
              operation: command.type,
              cause,
            }),
        ),
        Effect.flatMap((encoded) =>
          Stream.run(Stream.encodeText(Stream.make(encoded)), handle.stdin),
        ),
        Effect.mapError(
          (cause) =>
            new NativeTelemetryCommandFailed({
              operation: command.type,
              cause,
            }),
        ),
      ),
    );

  const resolvePending = <A>(pending: PendingReplies<A>, requestId: string, value: A) =>
    Ref.modify(pending, (current) => {
      const deferred = current.get(requestId);
      if (!deferred) return [undefined, current] as const;
      const next = new Map(current);
      next.delete(requestId);
      return [deferred, next] as const;
    }).pipe(
      Effect.flatMap((deferred) => (deferred ? Deferred.succeed(deferred, value) : Effect.void)),
      Effect.asVoid,
    );

  const commandableV4Handle = Ref.get(state).pipe(
    Effect.map((current) =>
      canCommandNativeTelemetrySidecar(current.status, Option.isSome(current.handle)) &&
      speaksV4(current)
        ? current.handle
        : Option.none(),
    ),
  );

  const gpusAllowed = Ref.get(gpuState).pipe(Effect.map((gpu) => !gpu.off));

  const markGpusUsed = (used: boolean) =>
    used
      ? Ref.update(gpuState, (current) => ({ ...current, usedThisGeneration: true }))
      : Effect.void;

  /** Sends the combined host demand when it differs from what the monitor already has. */
  const applyHostDemand: Effect.Effect<void, NativeTelemetryClientError> = hostMutex.withPermits(1)(
    Effect.gen(function* () {
      const handle = yield* commandableV4Handle;
      if (Option.isNone(handle)) return;
      const demand = combineHostSampleDemand(
        (yield* Ref.get(hostDemands)).values(),
        yield* gpusAllowed,
      );
      if (sameHostSampleDemand(demand, yield* Ref.get(appliedHostDemand))) return;
      yield* markGpusUsed(demand.gpus || demand.gpuProcesses);
      yield* writeCommand(handle.value, {
        version: RESOURCE_MONITOR_PROTOCOL_VERSION,
        type: "setHostStreaming",
        ...demand,
      });
      yield* Ref.set(appliedHostDemand, demand);
    }),
  );

  const processEvent = (
    event: ResourceMonitorEvent,
    helloDeferred: Deferred.Deferred<ResourceMonitorHelloEvent>,
    generation: number,
  ): Effect.Effect<void, NativeTelemetryClientError> => {
    switch (event.type) {
      case "hello":
        return Ref.update(state, (current) => ({
          ...current,
          status: "starting" as const,
          hello: Option.some(event),
          lastError: Option.none(),
        })).pipe(
          Effect.andThen(publishHealth),
          Effect.andThen(Deferred.succeed(helloDeferred, event)),
          Effect.asVoid,
        );
      case "snapshot":
        return Effect.gen(function* () {
          const nativeSnapshot = { generation, snapshot: event } satisfies NativeTelemetrySnapshot;
          const sampledAt = DateTime.makeUnsafe(event.sampledAtUnixMs);
          const healthChanged = yield* Ref.modify(state, (current) => [
            current.status !== "healthy" || Option.isSome(current.lastError),
            {
              ...current,
              status: "healthy" as const,
              lastSampleAt: Option.some(sampledAt),
              lastError: Option.none(),
            },
          ]);
          if (healthChanged) yield* publishHealth;
          yield* PubSub.publish(snapshots, nativeSnapshot);
          if (event.requestId) {
            const deferred = yield* Ref.modify(pendingSamples, (pending) => {
              const next = new Map(pending);
              const current = next.get(event.requestId!);
              next.delete(event.requestId!);
              return [Option.fromUndefinedOr(current), next];
            });
            if (Option.isSome(deferred)) {
              yield* Deferred.succeed(deferred.value, nativeSnapshot);
            }
          }
        });
      case "processTable":
        return Ref.modify(pendingProcessTables, (pending) => {
          const next = new Map(pending);
          const deferred = next.get(event.requestId);
          next.delete(event.requestId);
          return [Option.fromUndefinedOr(deferred), next] as const;
        }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (deferred) => Deferred.succeed(deferred, event.processes),
            }),
          ),
          Effect.asVoid,
        );
      case "historyChunk":
        return Effect.gen(function* () {
          const latestSnapshot = event.snapshots.at(-1);
          const healthChanged = yield* Ref.modify(state, (current) => [
            current.status !== "healthy" || Option.isSome(current.lastError),
            {
              ...current,
              status: "healthy" as const,
              lastSampleAt: latestSnapshot
                ? Option.some(DateTime.makeUnsafe(latestSnapshot.sampledAtUnixMs))
                : current.lastSampleAt,
              lastError: Option.none(),
            },
          ]);
          if (healthChanged) yield* publishHealth;
          const completed = yield* Ref.modify(pendingHistories, (pending) => {
            const request = pending.get(event.requestId);
            if (!request) return [Option.none(), pending] as const;
            const snapshots = [...request.snapshots, ...event.snapshots];
            const next = new Map(pending);
            if (event.done) {
              next.delete(event.requestId);
              return [Option.some({ deferred: request.deferred, snapshots }), next] as const;
            }
            next.set(event.requestId, { deferred: request.deferred, snapshots });
            return [Option.none(), next] as const;
          });
          if (Option.isSome(completed)) {
            yield* Deferred.succeed(completed.value.deferred, completed.value.snapshots);
          }
        });
      case "hostSample":
        return Effect.gen(function* () {
          const statics = yield* Ref.modify(hostStatics, (current) => {
            const table = foldHostStatics(
              current.generation === generation ? current.table : new Map(),
              event,
            );
            return [table, { generation, table }] as const;
          });
          const hostSample = { generation, sample: event, statics } satisfies NativeHostSample;
          // A requested sample carries the caller's fields, not the streams' combined ones.
          if (event.requestId) {
            yield* resolvePending(pendingHostSamples, event.requestId, hostSample);
          } else {
            yield* PubSub.publish(hostSamplePubSub, hostSample);
          }
        });
      case "hostTotals":
        return resolvePending(pendingHostTotals, event.requestId, event);
      case "gpuTotals":
        return resolvePending(pendingGpuTotals, event.requestId, event);
      case "error":
        if (event.code === "gpu-unavailable") {
          // The monitor turned its GPUs off; the rest of it is healthy.
          return Ref.update(gpuState, (current) => ({ ...current, off: true })).pipe(
            Effect.andThen(
              Effect.logWarning("Resource monitor turned GPUs off", { message: event.message }),
            ),
            Effect.andThen(applyHostDemand),
          );
        }
        return Ref.update(state, (current) => ({
          ...current,
          status: "degraded" as const,
          lastError: Option.some(event.message),
        })).pipe(
          Effect.andThen(publishHealth),
          Effect.andThen(
            event.recoverable
              ? Effect.void
              : Effect.fail(
                  new NativeTelemetryCommandFailed({
                    operation: event.code,
                    cause: event.message,
                  }),
                ),
          ),
        );
    }
  };

  const runAttempt: Effect.Effect<void, NativeTelemetryClientError> = Effect.scoped(
    Effect.gen(function* () {
      const executablePath = yield* binary.resolve;
      const command = ChildProcess.make(executablePath, [], {
        cwd: config.cwd,
        stdin: {
          stream: "pipe",
          endOnDone: false,
        },
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: Duration.seconds(2),
      });
      const handle = yield* Effect.acquireRelease(
        spawner
          .spawn(command)
          .pipe(
            Effect.mapError(
              (cause) => new NativeTelemetrySpawnFailed({ path: executablePath, cause }),
            ),
          ),
        (child) => child.kill().pipe(Effect.ignore),
      );
      yield* Ref.update(state, (current) => ({
        ...current,
        status: "starting" as const,
        handle: Option.some(handle),
        hello: Option.none(),
      }));
      yield* publishHealth;
      const generation = (yield* Ref.get(state)).restartCount;

      const helloDeferred = yield* Deferred.make<ResourceMonitorHelloEvent>();
      const eventFiber = yield* handle.stdout.pipe(
        Stream.pipeThroughChannel(
          Ndjson.decode({ ignoreEmptyLines: true, maxLineBytes: MAX_LINE_BYTES }),
        ),
        Stream.mapEffect(
          (
            value,
          ): Effect.Effect<
            ResourceMonitorEvent,
            NativeTelemetryProtocolMismatch | NativeTelemetryDecodeFailed
          > => {
            const version = eventVersion(value);
            if (version !== undefined && !isSupportedProtocolVersion(version)) {
              return Effect.fail(
                new NativeTelemetryProtocolMismatch({
                  expectedVersion: RESOURCE_MONITOR_PROTOCOL_VERSION,
                  receivedVersion: version,
                }),
              );
            }
            return decodeMonitorEvent(value).pipe(
              Effect.mapError((cause) => new NativeTelemetryDecodeFailed({ cause })),
            );
          },
        ),
        Stream.runForEach((event) => processEvent(event, helloDeferred, generation)),
        Effect.mapError((cause) =>
          isProtocolMismatch(cause) || isDecodeFailed(cause) || isCommandFailed(cause)
            ? cause
            : new NativeTelemetryDecodeFailed({ cause }),
        ),
        Effect.forkScoped,
      );
      yield* handle.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);

      // A reader that fails before hello (protocol mismatch, bad JSON) explains the failure;
      // waiting on hello alone would report it as a handshake timeout.
      const decoderEffect = Fiber.join(eventFiber).pipe(
        Effect.andThen(Effect.fail(new NativeTelemetryStreamClosed())),
      );
      const hello = yield* Effect.raceFirst(Deferred.await(helloDeferred), decoderEffect).pipe(
        Effect.timeoutOption(HANDSHAKE_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new NativeTelemetryHandshakeTimedOut({
                  timeoutMs: Duration.toMillis(HANDSHAKE_TIMEOUT),
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      yield* synchronizeCollectionControlOnStart(
        controlMutex,
        collectionControl,
        appliedCollectionControl,
        (control) =>
          Effect.gen(function* () {
            yield* writeCommand(handle, {
              version: hello.version,
              type: "configure",
              rootPid: process.pid,
              sampleIntervalMs: control.sampleIntervalMs,
              externalProcesses: [...(yield* Ref.get(externalProcesses))],
            });
            if (control.liveSubscriberCount > 0) {
              yield* writeCommand(handle, {
                version: hello.version,
                type: "setStreaming",
                enabled: true,
              });
            }
            const claimed = yield* Ref.get(claimedProcesses);
            if (hello.version === RESOURCE_MONITOR_PROTOCOL_VERSION && claimed.length > 0) {
              yield* writeCommand(handle, {
                version: hello.version,
                type: "setClaimedProcesses",
                processes: [...claimed],
              });
            }
          }),
        Ref.update(state, (current) => ({
          ...current,
          status: "healthy" as const,
          hello: Option.some(hello),
        })).pipe(Effect.andThen(publishHealth)),
      );

      yield* writeCommand(handle, {
        version: hello.version,
        type: "setExternalProcesses",
        processes: [...(yield* Ref.get(externalProcesses))],
      });
      // A new monitor starts with host streaming off.
      yield* Ref.set(appliedHostDemand, HOST_STREAMING_OFF);
      yield* applyHostDemand;

      const exitEffect = handle.exitCode.pipe(
        Effect.mapError(
          (cause) =>
            new NativeTelemetryCommandFailed({
              operation: "waitForExit",
              cause,
            }),
        ),
        Effect.flatMap((exitCode) =>
          Effect.fail(new NativeTelemetryExited({ exitCode: Number(exitCode) })),
        ),
      );
      return yield* Effect.raceFirst(exitEffect, decoderEffect);
    }),
  ).pipe(
    Effect.ensuring(
      Ref.update(state, (current) => ({
        ...current,
        handle: Option.none(),
      })),
    ),
  );

  yield* Effect.gen(function* () {
    let failures: ReadonlyArray<number> = [];
    let restartAttempt = 0;

    while (true) {
      const result = yield* Effect.result(runAttempt);
      if (Result.isSuccess(result)) {
        return;
      }

      const error = result.failure;
      const crashed = (isExited(error) && error.exitCode !== 0) || isStreamClosed(error);
      yield* Ref.update(gpuState, (gpu) => ({
        usedThisGeneration: false,
        off: gpu.off || (crashed && gpu.usedThisGeneration),
      }));
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const recentFailures = retainRecentNativeTelemetryFailures(failures, now);
      if (recentFailures.length === 0) {
        restartAttempt = 0;
      }
      failures = [...recentFailures, now];
      const exhausted = failures.length >= MAX_FAILURES_PER_WINDOW;
      yield* Ref.update(state, (current) => ({
        ...current,
        status: exhausted ? ("unavailable" as const) : ("degraded" as const),
        hello: Option.none(),
        lastError: Option.some(errorMessage(error)),
        restartCount: current.restartCount + 1,
      }));
      yield* publishHealth;
      yield* failPending(error);

      if (exhausted) {
        yield* Queue.take(retryQueue);
        failures = [];
        restartAttempt = 0;
        yield* Ref.update(state, (current) => ({
          ...current,
          status: "starting" as const,
          hello: Option.none(),
          lastError: Option.none(),
        }));
        yield* publishHealth;
        continue;
      }

      const manuallyRetried = yield* Effect.raceFirst(
        Effect.sleep(restartDelay(restartAttempt)).pipe(Effect.as(false)),
        Queue.take(retryQueue).pipe(Effect.as(true)),
      );
      restartAttempt = manuallyRetried ? 0 : restartAttempt + 1;
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.void
        : Ref.update(state, (current) => ({
            ...current,
            status: "unavailable" as const,
            hello: Option.none(),
            lastError: Option.some("Resource monitor supervisor stopped unexpectedly."),
          })).pipe(
            Effect.andThen(publishHealth),
            Effect.andThen(
              Effect.logWarning("Resource monitor supervisor failed", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
    ),
    Effect.forkScoped,
  );

  // Desktop power samples reach this even when the control state has not changed.
  const applyCollectionControl = Effect.fnUntraced(function* (
    previous: CollectionControl,
    next: CollectionControl,
  ) {
    const current = yield* Ref.get(state);
    if (canCommandNativeTelemetrySidecar(current.status, Option.isSome(current.handle))) {
      const handle = Option.getOrThrow(current.handle);
      if (previous.sampleIntervalMs !== next.sampleIntervalMs) {
        yield* writeCommand(handle, {
          version: protocolVersionOf(current),
          type: "setSampleInterval",
          sampleIntervalMs: next.sampleIntervalMs,
        });
      }
      const wasStreaming = previous.liveSubscriberCount > 0;
      const isStreaming = next.liveSubscriberCount > 0;
      if (wasStreaming !== isStreaming) {
        yield* writeCommand(handle, {
          version: protocolVersionOf(current),
          type: "setStreaming",
          enabled: isStreaming,
        });
      }
    }
  });

  const updateCollectionControl = (update: (current: CollectionControl) => CollectionControl) =>
    controlMutex.withPermits(1)(
      commitCollectionControlUpdate(
        collectionControl,
        appliedCollectionControl,
        update,
        applyCollectionControl,
      ).pipe(Effect.ensuring(publishHealth), Effect.asVoid),
    );

  const setHostPowerState: NativeTelemetryClient["Service"]["setHostPowerState"] = (hostPower) =>
    updateCollectionControl((current) => ({
      ...current,
      hostPower,
      sampleIntervalMs: resolveNativeSampleIntervalMs(hostPower, current.liveSubscriberCount),
    }));

  const changeLiveSubscriberCount = Effect.fn(
    "resourceTelemetry.nativeTelemetryClient.changeLiveSubscriberCount",
  )(function* (delta: 1 | -1) {
    yield* updateCollectionControl((current) => {
      const liveSubscriberCount = Math.max(0, current.liveSubscriberCount + delta);
      return {
        ...current,
        liveSubscriberCount,
        sampleIntervalMs: resolveNativeSampleIntervalMs(current.hostPower, liveSubscriberCount),
      };
    });
  });

  const liveSnapshots = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(snapshots);
      yield* Effect.acquireRelease(changeLiveSubscriberCount(1), () =>
        changeLiveSubscriberCount(-1).pipe(Effect.ignore),
      );
      return Stream.fromSubscription(subscription);
    }),
  );

  // Desktop telemetry refreshes this process set on every sample.
  const setExternalProcesses: NativeTelemetryClient["Service"]["setExternalProcesses"] =
    Effect.fnUntraced(function* (processes) {
      yield* Ref.set(externalProcesses, [...processes]);
      const current = yield* Ref.get(state);
      if (!canCommandNativeTelemetrySidecar(current.status, Option.isSome(current.handle))) return;
      yield* writeCommand(Option.getOrThrow(current.handle), {
        version: protocolVersionOf(current),
        type: "setExternalProcesses",
        processes: [...processes],
      });
    });

  const readHistory: NativeTelemetryClient["Service"]["readHistory"] = Effect.fn(
    "NativeTelemetryClient.readHistory",
  )(function* (windowMs) {
    const current = yield* Ref.get(state);
    if (!canCommandNativeTelemetrySidecar(current.status, Option.isSome(current.handle))) {
      return yield* new NativeTelemetryUnavailable({
        reason: Option.getOrElse(current.lastError, () => "sidecar is not running"),
      });
    }
    const requestId = yield* random.uuidV4().pipe(
      Effect.mapError(
        (cause) =>
          new NativeTelemetryCommandFailed({
            operation: "createHistoryRequestId",
            cause,
          }),
      ),
    );
    const deferred = yield* Deferred.make<
      ReadonlyArray<ResourceMonitorSnapshotEvent>,
      NativeTelemetryClientError
    >();
    yield* Ref.update(pendingHistories, (pending) => {
      const next = new Map(pending);
      next.set(requestId, { deferred, snapshots: [] });
      return next;
    });
    return yield* writeCommand(Option.getOrThrow(current.handle), {
      version: protocolVersionOf(current),
      type: "readHistory",
      requestId,
      windowMs: Math.max(0, Math.round(windowMs)),
    }).pipe(
      Effect.andThen(
        Deferred.await(deferred).pipe(
          Effect.timeoutOption(HISTORY_REQUEST_TIMEOUT),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new NativeTelemetryRequestTimedOut({
                    operation: "readHistory",
                    timeoutMs: Duration.toMillis(HISTORY_REQUEST_TIMEOUT),
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
      ),
      Effect.ensuring(
        Ref.update(pendingHistories, (pending) => {
          const next = new Map(pending);
          next.delete(requestId);
          return next;
        }),
      ),
    );
  });

  const sampleNow: NativeTelemetryClient["Service"]["sampleNow"] = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (!canCommandNativeTelemetrySidecar(current.status, Option.isSome(current.handle))) {
      return yield* new NativeTelemetryUnavailable({
        reason: Option.getOrElse(current.lastError, () => "sidecar is not running"),
      });
    }

    const requestId = yield* random.uuidV4().pipe(
      Effect.mapError(
        (cause) =>
          new NativeTelemetryCommandFailed({
            operation: "createRequestId",
            cause,
          }),
      ),
    );
    const deferred = yield* Deferred.make<NativeTelemetrySnapshot, NativeTelemetryClientError>();
    yield* Ref.update(pendingSamples, (pending) => {
      const next = new Map(pending);
      next.set(requestId, deferred);
      return next;
    });
    return yield* writeCommand(Option.getOrThrow(current.handle), {
      version: protocolVersionOf(current),
      type: "sampleNow",
      requestId,
    }).pipe(
      Effect.andThen(
        Deferred.await(deferred).pipe(
          Effect.timeoutOption(SAMPLE_REQUEST_TIMEOUT),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new NativeTelemetryRequestTimedOut({
                    operation: "sampleNow",
                    timeoutMs: Duration.toMillis(SAMPLE_REQUEST_TIMEOUT),
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
      ),
      Effect.ensuring(
        Ref.update(pendingSamples, (pending) => {
          const next = new Map(pending);
          next.delete(requestId);
          return next;
        }),
      ),
    );
  });

  const processTable: NativeTelemetryClient["Service"]["processTable"] = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (!canCommandNativeTelemetrySidecar(current.status, Option.isSome(current.handle))) {
      return yield* new NativeTelemetryUnavailable({
        reason: Option.getOrElse(current.lastError, () => "sidecar is not running"),
      });
    }

    const requestId = yield* random
      .uuidV4()
      .pipe(
        Effect.mapError(
          (cause) => new NativeTelemetryCommandFailed({ operation: "createRequestId", cause }),
        ),
      );
    const deferred = yield* Deferred.make<
      ReadonlyArray<ResourceMonitorProcessTableEntry>,
      NativeTelemetryClientError
    >();
    yield* Ref.update(pendingProcessTables, (pending) => {
      const next = new Map(pending);
      next.set(requestId, deferred);
      return next;
    });
    return yield* writeCommand(Option.getOrThrow(current.handle), {
      version: protocolVersionOf(current),
      type: "processTable",
      requestId,
    }).pipe(
      Effect.andThen(
        Deferred.await(deferred).pipe(
          Effect.timeoutOption(PROCESS_TABLE_REQUEST_TIMEOUT),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new NativeTelemetryRequestTimedOut({
                    operation: "processTable",
                    timeoutMs: Duration.toMillis(PROCESS_TABLE_REQUEST_TIMEOUT),
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
      ),
      Effect.ensuring(
        Ref.update(pendingProcessTables, (pending) => {
          const next = new Map(pending);
          next.delete(requestId);
          return next;
        }),
      ),
    );
  });

  const requestV4 = Effect.fn("NativeTelemetryClient.requestV4")(function* <A>(
    operation: RequestOperation,
    pending: PendingReplies<A>,
    timeout: Duration.Duration,
    command: (requestId: string) => ResourceMonitorCommand,
  ) {
    const current = yield* Ref.get(state);
    if (!canCommandNativeTelemetrySidecar(current.status, Option.isSome(current.handle))) {
      return yield* new NativeTelemetryUnavailable({
        reason: Option.getOrElse(current.lastError, () => "sidecar is not running"),
      });
    }
    if (!speaksV4(current)) {
      return yield* new NativeTelemetryUnavailable({
        reason: `the resource monitor binary predates '${operation}'; rebuild it with \`vp run build:resource-monitor\``,
      });
    }
    const requestId = yield* random
      .uuidV4()
      .pipe(
        Effect.mapError(
          (cause) => new NativeTelemetryCommandFailed({ operation: "createRequestId", cause }),
        ),
      );
    const deferred = yield* Deferred.make<A, NativeTelemetryClientError>();
    yield* Ref.update(pending, (replies) => new Map(replies).set(requestId, deferred));
    return yield* writeCommand(Option.getOrThrow(current.handle), command(requestId)).pipe(
      Effect.andThen(
        Deferred.await(deferred).pipe(
          Effect.timeoutOption(timeout),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new NativeTelemetryRequestTimedOut({
                    operation,
                    timeoutMs: Duration.toMillis(timeout),
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        ),
      ),
      Effect.ensuring(
        Ref.update(pending, (replies) => {
          const next = new Map(replies);
          next.delete(requestId);
          return next;
        }),
      ),
    );
  });

  const hostSamples: NativeTelemetryClient["Service"]["hostSamples"] = (demand) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(hostSamplePubSub);
        yield* Effect.acquireRelease(
          Ref.modify(nextHostDemandId, (id) => [id, id + 1] as const).pipe(
            Effect.tap((id) =>
              Ref.update(hostDemands, (demands) => new Map(demands).set(id, demand)),
            ),
          ),
          (id) =>
            Ref.update(hostDemands, (demands) => {
              const next = new Map(demands);
              next.delete(id);
              return next;
            }).pipe(Effect.andThen(applyHostDemand), Effect.ignore),
        );
        yield* applyHostDemand;
        return Stream.fromSubscription(subscription);
      }),
    );

  const hostSampleNow: NativeTelemetryClient["Service"]["hostSampleNow"] = Effect.fn(
    "NativeTelemetryClient.hostSampleNow",
  )(function* (options) {
    const allowed = yield* gpusAllowed;
    const fields = {
      processes: options.processes,
      gpus: allowed && options.gpus,
      gpuProcesses: allowed && options.gpuProcesses,
    };
    yield* markGpusUsed(fields.gpus || fields.gpuProcesses);
    return yield* requestV4(
      "hostSampleNow",
      pendingHostSamples,
      HOST_SAMPLE_REQUEST_TIMEOUT,
      (requestId) => ({
        version: RESOURCE_MONITOR_PROTOCOL_VERSION,
        type: "hostSampleNow",
        requestId,
        ...fields,
      }),
    );
  });

  const hostTotals: NativeTelemetryClient["Service"]["hostTotals"] = requestV4(
    "hostTotals",
    pendingHostTotals,
    HOST_TOTALS_REQUEST_TIMEOUT,
    (requestId) => ({ version: RESOURCE_MONITOR_PROTOCOL_VERSION, type: "hostTotals", requestId }),
  );

  const gpuTotals: NativeTelemetryClient["Service"]["gpuTotals"] = Effect.gen(function* () {
    if (!(yield* gpusAllowed)) return [];
    yield* markGpusUsed(true);
    const reply = yield* requestV4(
      "gpuTotals",
      pendingGpuTotals,
      GPU_TOTALS_REQUEST_TIMEOUT,
      (requestId) => ({ version: RESOURCE_MONITOR_PROTOCOL_VERSION, type: "gpuTotals", requestId }),
    );
    // No `gpus` means this one query failed, which is not the same as no GPUs.
    if (reply.gpus === undefined) {
      return yield* new NativeTelemetryCommandFailed({
        operation: "gpuTotals",
        cause: "GPU query failed",
      });
    }
    return reply.gpus;
  });

  const setClaimedProcesses: NativeTelemetryClient["Service"]["setClaimedProcesses"] =
    Effect.fnUntraced(function* (processes) {
      const claimed = processes.slice(0, MAX_CLAIMED_PROCESSES);
      yield* Ref.set(claimedProcesses, claimed);
      const handle = yield* commandableV4Handle;
      if (Option.isNone(handle)) return;
      yield* writeCommand(handle.value, {
        version: RESOURCE_MONITOR_PROTOCOL_VERSION,
        type: "setClaimedProcesses",
        processes: [...claimed],
      });
    });

  const health = currentHealth;

  return NativeTelemetryClient.of({
    capabilities: Ref.get(state).pipe(
      Effect.flatMap((current) =>
        Option.match(current.hello, {
          onNone: () =>
            Effect.fail(
              new NativeTelemetryUnavailable({
                reason: Option.getOrElse(current.lastError, () => "handshake is incomplete"),
              }),
            ),
          onSome: (hello) => Effect.succeed(hello.capabilities),
        }),
      ),
    ),
    snapshots: liveSnapshots,
    readHistory,
    setExternalProcesses,
    setHostPowerState,
    sampleNow,
    processTable,
    hostSamples,
    hostSampleNow,
    hostTotals,
    gpuTotals,
    setClaimedProcesses,
    retry: Ref.get(state).pipe(
      Effect.flatMap((current) =>
        !canRequestNativeTelemetryRetry(current.status, Option.isSome(current.handle))
          ? Effect.succeed(false)
          : Queue.offer(retryQueue, undefined).pipe(Effect.as(true)),
      ),
    ),
    health,
    subscribeHealth: subscribeBeforeSnapshotWithoutMutex(healthChanges, health),
  });
});

export const layer = Layer.effect(NativeTelemetryClient, make());

export const layerTest = (
  overrides: Partial<NativeTelemetryClient["Service"]> = {},
): Layer.Layer<NativeTelemetryClient> => {
  const health =
    overrides.health ??
    Effect.succeed({
      status: "unavailable" as const,
      hello: Option.none<ResourceMonitorHelloEvent>(),
      lastSampleAt: Option.none<DateTime.Utc>(),
      lastError: Option.some("Resource monitor test implementation is unavailable."),
      restartCount: 0,
      sampleIntervalMs: IDLE_SAMPLE_INTERVAL_MS,
    });
  return Layer.succeed(
    NativeTelemetryClient,
    NativeTelemetryClient.of({
      capabilities: Effect.succeed({
        cumulativeCpuTime: true,
        currentCpuPercent: true,
        residentMemory: true,
        virtualMemory: true,
        ioBytes: true,
        processStartTime: true,
        processTree: true,
      }),
      snapshots: Stream.empty,
      readHistory: Effect.fn("NativeTelemetryClient.readHistory")(function () {
        return Effect.fail(
          new NativeTelemetryUnavailable({
            reason: "No resource monitor history was configured for this test.",
          }),
        );
      }),
      setExternalProcesses: Effect.fn("NativeTelemetryClient.setExternalProcesses")(function () {
        return Effect.void;
      }),
      setHostPowerState: Effect.fn("NativeTelemetryClient.setHostPowerState")(function () {
        return Effect.void;
      }),
      sampleNow: Effect.fail(
        new NativeTelemetryUnavailable({
          reason: "No resource monitor sample was configured for this test.",
        }),
      ),
      processTable: Effect.fail(
        new NativeTelemetryUnavailable({
          reason: "No resource monitor process table was configured for this test.",
        }),
      ),
      hostSamples: () => Stream.empty,
      hostSampleNow: Effect.fn("NativeTelemetryClient.hostSampleNow")(function () {
        return Effect.fail(
          new NativeTelemetryUnavailable({
            reason: "No resource monitor host sample was configured for this test.",
          }),
        );
      }),
      hostTotals: Effect.fail(
        new NativeTelemetryUnavailable({
          reason: "No resource monitor host totals were configured for this test.",
        }),
      ),
      gpuTotals: Effect.succeed([]),
      setClaimedProcesses: Effect.fn("NativeTelemetryClient.setClaimedProcesses")(function () {
        return Effect.void;
      }),
      retry: Effect.succeed(false),
      health,
      subscribeHealth:
        overrides.subscribeHealth ??
        health.pipe(
          Effect.map((initial) => ({
            latest: initial,
            changes: Stream.empty,
          })),
        ),
      ...overrides,
    }),
  );
};
