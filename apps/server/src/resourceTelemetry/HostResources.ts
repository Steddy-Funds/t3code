import {
  DEFAULT_MACHINE_THRESHOLDS,
  type GpuDeviceSample,
  MACHINE_HISTORY_MAX_MS,
  MACHINE_HISTORY_STEP_MS,
  MACHINE_SAMPLE_MIN_INTERVAL_MS,
  type HostResourcesSnapshot,
  type MachineHistory,
  type MachineStatusSample,
  type MachineStatusSnapshot,
  type MachineTotalsSummary,
  type SubscribeMachineInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  cpuDeltas,
  hostGpuTotals,
  readCpuCounters,
  readHostTotals,
  type CpuCounters,
  type HostTotals,
  type NativeHostTotals,
} from "@t3tools/shared/hostTotals";
import {
  initialVerdictState,
  stepVerdict,
  verdictChanged,
  type VerdictState,
} from "@t3tools/shared/nodeVerdict";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { Scheduler } from "../scheduling/Scheduler.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const HEARTBEAT_INTERVAL = "30 seconds";

const HISTORY_CAPACITY = MACHINE_HISTORY_MAX_MS / MACHINE_HISTORY_STEP_MS;
const HISTORY_MAX_BYTES = 512 * 1024;
const HISTORY_MAX_GPUS = 8;
// cpu, memory, swap and load, plus two columns per GPU; per-core gets what is left.
const HISTORY_MAX_CORES =
  Math.floor(HISTORY_MAX_BYTES / (HISTORY_CAPACITY * Float32Array.BYTES_PER_ELEMENT)) -
  4 -
  2 * HISTORY_MAX_GPUS;

const toPermille = (percent: number) =>
  Number.isNaN(percent) ? -1 : Math.min(1000, Math.max(0, Math.round(percent * 10)));

const share = (part: number, total: number) => (total > 0 ? (part / total) * 100 : Number.NaN);

const nanColumn = (length: number) => new Float32Array(length).fill(Number.NaN);

/**
 * One hour of base ticks in Float32Array columns (percent; NaN where a tick had no reading).
 * Every tick writes a row, so row index maps to time.
 */
export class MachineHistoryRing {
  private head = 0;
  private count = 0;
  private endAtMs: number | null = null;
  private cores = 0;
  private readonly cpu = nanColumn(HISTORY_CAPACITY);
  private readonly memory = nanColumn(HISTORY_CAPACITY);
  private readonly swap = nanColumn(HISTORY_CAPACITY);
  private readonly load1 = nanColumn(HISTORY_CAPACITY);
  private perCore = new Float32Array(0);
  private readonly gpus = new Map<string, { util: Float32Array; vram: Float32Array }>();

  record(totals: HostTotals | null, atMs: number): void {
    const slot = this.head;
    if (totals !== null && this.cores === 0 && totals.perCore.length > 0) {
      this.cores = Math.min(totals.perCore.length, HISTORY_MAX_CORES);
      this.perCore = nanColumn(HISTORY_CAPACITY * this.cores);
    }
    this.cpu[slot] = totals?.cpuUtilization == null ? Number.NaN : totals.cpuUtilization * 100;
    this.memory[slot] =
      totals === null
        ? Number.NaN
        : share(totals.memoryTotalBytes - totals.memoryAvailableBytes, totals.memoryTotalBytes);
    this.swap[slot] =
      totals === null ? Number.NaN : share(totals.swapUsedBytes, totals.swapTotalBytes);
    this.load1[slot] = totals?.load == null ? Number.NaN : totals.load.one;
    for (let core = 0; core < this.cores; core++) {
      this.perCore[slot * this.cores + core] = totals?.perCore[core] ?? Number.NaN;
    }
    for (const columns of this.gpus.values()) {
      columns.util[slot] = Number.NaN;
      columns.vram[slot] = Number.NaN;
    }
    for (const gpu of totals?.gpus ?? []) {
      let columns = this.gpus.get(gpu.id);
      if (columns === undefined) {
        if (this.gpus.size >= HISTORY_MAX_GPUS) continue;
        columns = { util: nanColumn(HISTORY_CAPACITY), vram: nanColumn(HISTORY_CAPACITY) };
        this.gpus.set(gpu.id, columns);
      }
      columns.util[slot] = gpu.utilPercent ?? Number.NaN;
      columns.vram[slot] = gpu.vramUsedPercent ?? Number.NaN;
    }
    this.head = (this.head + 1) % HISTORY_CAPACITY;
    this.count = Math.min(this.count + 1, HISTORY_CAPACITY);
    this.endAtMs = atMs;
  }

  /** The newest `historyMs` of ticks, permille-quantised; every column has `count` entries. */
  read(historyMs: number, nowMs: number): MachineHistory {
    const count = Math.min(this.count, Math.floor(historyMs / MACHINE_HISTORY_STEP_MS));
    const slots = Array.from(
      { length: count },
      (_, index) => (this.head - count + index + HISTORY_CAPACITY) % HISTORY_CAPACITY,
    );
    const column = (values: Float32Array) => slots.map((slot) => toPermille(values[slot]!));
    const perCore: Array<number> = [];
    for (const slot of slots) {
      for (let core = 0; core < this.cores; core++) {
        perCore.push(toPermille(this.perCore[slot * this.cores + core]!));
      }
    }
    return {
      stepMs: MACHINE_HISTORY_STEP_MS,
      count,
      endAgeMs: this.endAtMs === null ? 0 : Math.max(0, Math.round(nowMs - this.endAtMs)),
      cpu: column(this.cpu),
      perCore,
      cores: this.cores,
      memoryUsed: column(this.memory),
      swapUsed: column(this.swap),
      load1: slots.map((slot) => {
        const load = this.load1[slot]!;
        return Number.isNaN(load) ? -1 : Math.round(load * 100) / 100;
      }),
      gpus: [...this.gpus].map(([id, columns]) => ({
        id,
        util: column(columns.util),
        vramUsed: column(columns.vram),
      })),
    };
  }
}

export class HostResources extends Context.Service<
  HostResources,
  {
    /** Served from the latest base tick; samples on demand until two ticks have run. */
    readonly read: Effect.Effect<HostResourcesSnapshot>;
    /** The current snapshot, then verdict changes, plus a 30 s heartbeat. */
    readonly status: Stream.Stream<MachineStatusSnapshot>;
    /** Verdict or reason-rule changes only. */
    readonly statusChanges: Stream.Stream<MachineStatusSnapshot>;
    /** Every 5 s base tick. */
    readonly ticks: Stream.Stream<HostTotals>;
    /** Per-core and GPU device samples at `intervalMs` (at least 500 ms), shared per interval. */
    readonly samples: (
      intervalMs: number,
    ) => Effect.Effect<Stream.Stream<MachineStatusSample>, never, Scope.Scope>;
    /**
     * `subscribeMachine`: status alone, or status plus a sample at each interval. With
     * `historyMs`, the first snapshot carries that much history.
     */
    readonly subscribe: (input: SubscribeMachineInput) => Stream.Stream<MachineStatusSnapshot>;
  }
>()("t3/resourceTelemetry/HostResources") {}

interface TickState {
  readonly counters: CpuCounters | null;
  readonly totals: HostTotals | null;
  readonly verdict: VerdictState;
  readonly sequence: number;
}

interface SampleSource {
  count: number;
  readonly pubsub: PubSub.PubSub<MachineStatusSample>;
  readonly fiber: Fiber.Fiber<never>;
}

function summarize(totals: HostTotals): MachineTotalsSummary {
  return {
    cpuUtilization: totals.cpuUtilization,
    cpuCount: totals.cpuCount,
    load: totals.load,
    memoryTotalBytes: totals.memoryTotalBytes,
    memoryAvailableBytes: totals.memoryAvailableBytes,
    swapTotalBytes: totals.swapTotalBytes,
    swapUsedBytes: totals.swapUsedBytes,
    memoryPressure: totals.memoryPressure,
  };
}

function toHostResourcesSnapshot(totals: HostTotals): HostResourcesSnapshot {
  return {
    sampledAt: totals.sampledAt,
    cpuUtilization: totals.cpuUtilization,
    cpuCount: totals.cpuCount,
    availableMemoryBytes: totals.memoryAvailableBytes,
    totalMemoryBytes: totals.memoryTotalBytes,
  };
}

function toStatusSnapshot(state: TickState, now: number): MachineStatusSnapshot {
  return {
    sequence: state.sequence,
    verdict: state.verdict.verdict,
    verdictAgeMs: Math.max(0, now - state.verdict.since),
    reason: state.verdict.reason,
    sampleAgeMs: state.totals === null ? 0 : Math.max(0, now - state.totals.sampledAt),
    totals: state.totals === null ? null : summarize(state.totals),
  };
}

const make = Effect.fn("makeHostResources")(function* () {
  const platform = yield* HostProcess.Platform;
  const settings = yield* ServerSettingsService;
  const scheduler = yield* Scheduler;
  const native = yield* NativeTelemetryClient.NativeTelemetryClient;
  const layerScope = yield* Effect.scope;
  const history = new MachineHistoryRing();

  const state = yield* Ref.make<TickState>({
    counters: null,
    totals: null,
    verdict: initialVerdictState(yield* Clock.currentTimeMillis),
    sequence: 0,
  });
  const changes = yield* PubSub.sliding<MachineStatusSnapshot>(16);
  const tickTotals = yield* PubSub.sliding<HostTotals>(1);

  const readTotals = (prev: CpuCounters | null, nativeTotals: NativeHostTotals | null = null) =>
    Effect.tryPromise({
      try: () => readHostTotals(prev, { platform, native: nativeTotals }),
      catch: () => "unavailable" as const,
    }).pipe(Effect.option);

  // Only macOS needs the monitor for memory; without it (or mid-restart) memory reads unknown.
  const readNativeTotals: Effect.Effect<NativeHostTotals | null> =
    platform === "darwin"
      ? native.hostTotals.pipe(
          Effect.map((totals): NativeHostTotals | null => totals),
          Effect.orElseSucceed(() => null),
        )
      : Effect.succeed(null);

  // Device totals only, never a process walk; absent without a v4 monitor, so GPU rules skip.
  const readGpus = native.gpuTotals.pipe(Effect.option);
  // Live samples reuse the base tick's reading: GPU queries stay at 5 s however many views are open.
  const latestGpus = yield* Ref.make<Option.Option<ReadonlyArray<GpuDeviceSample>>>(Option.none());

  const thresholds = settings.getSettings.pipe(
    Effect.map((current) => current.machineResources.thresholds),
    Effect.orElseSucceed(() => DEFAULT_MACHINE_THRESHOLDS),
  );

  // Runs every 5 s for the server's lifetime; a span per tick would only add noise.
  const tick = Effect.fnUntraced(function* () {
    const th = yield* thresholds;
    const prev = yield* Ref.get(state);
    const [nativeTotals, gpus] = yield* Effect.all([readNativeTotals, readGpus], {
      concurrency: "unbounded",
    });
    yield* Ref.set(latestGpus, gpus);
    const read = yield* readTotals(prev.counters, nativeTotals);
    const now = yield* Clock.currentTimeMillis;
    const totals: HostTotals | null =
      read._tag === "Some"
        ? {
            ...read.value.totals,
            sampledAt: now,
            ...(Option.isSome(gpus) ? { gpus: hostGpuTotals(gpus.value) } : {}),
          }
        : null;
    history.record(totals, now);
    const verdict = stepVerdict(prev.verdict, totals, th, now);
    const changed = verdictChanged(prev.verdict, verdict);
    const next: TickState = {
      counters: read._tag === "Some" ? read.value.next : prev.counters,
      totals,
      verdict,
      sequence: changed ? prev.sequence + 1 : prev.sequence,
    };
    yield* Ref.set(state, next);
    if (totals !== null) yield* PubSub.publish(tickTotals, totals);
    if (changed) yield* PubSub.publish(changes, toStatusSnapshot(next, now));
  });
  yield* scheduler.register("HostResources.tick", tick());

  const currentSnapshot = Effect.gen(function* () {
    return toStatusSnapshot(yield* Ref.get(state), yield* Clock.currentTimeMillis);
  });

  const sampleOnDemand = Effect.gen(function* () {
    const first = readCpuCounters();
    yield* Effect.sleep("200 millis");
    const read = yield* readTotals(first);
    if (read._tag === "Some") return toHostResourcesSnapshot(read.value.totals);
    return yield* Effect.die(new Error("Host totals are unavailable."));
  });

  const read = Effect.fn("HostResources.read")(function* () {
    const { totals } = yield* Ref.get(state);
    if (totals !== null && totals.cpuUtilization !== null) {
      return toHostResourcesSnapshot(totals);
    }
    return yield* sampleOnDemand;
  });

  // Subscribe first, so a change between the subscription and the first snapshot is not lost.
  const status = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.merge(
        Stream.fromSubscription(subscription),
        Stream.tick(HEARTBEAT_INTERVAL),
      ).pipe(Stream.mapEffect(() => currentSnapshot));
    }),
  );

  const sampleLock = yield* Semaphore.make(1);
  const sampleSources = new Map<number, SampleSource>();

  // Per-frame work at up to 2 Hz per open view; spans per frame would swamp tracing.
  const sampleLoop = Effect.fnUntraced(function* (
    pubsub: PubSub.PubSub<MachineStatusSample>,
    intervalMs: number,
  ) {
    let prev = readCpuCounters();
    while (true) {
      yield* Effect.sleep(intervalMs);
      const next = readCpuCounters();
      const gpus = yield* Ref.get(latestGpus);
      yield* PubSub.publish(pubsub, {
        perCore: cpuDeltas(prev, next).perCore,
        ...(Option.isSome(gpus) ? { gpus: gpus.value } : {}),
      });
      prev = next;
    }
  });

  const samples = Effect.fn("HostResources.samples")(function* (requestedMs: number) {
    const intervalMs = Math.max(MACHINE_SAMPLE_MIN_INTERVAL_MS, Math.round(requestedMs));
    const source = yield* sampleLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = sampleSources.get(intervalMs);
        if (existing !== undefined) {
          existing.count += 1;
          return existing;
        }
        const pubsub = yield* PubSub.sliding<MachineStatusSample>(1);
        const fiber = yield* Effect.forkIn(sampleLoop(pubsub, intervalMs), layerScope);
        const created: SampleSource = { count: 1, pubsub, fiber };
        sampleSources.set(intervalMs, created);
        return created;
      }),
    );
    yield* Effect.addFinalizer(() =>
      sampleLock.withPermits(1)(
        Effect.gen(function* () {
          source.count -= 1;
          if (source.count > 0) return;
          sampleSources.delete(intervalMs);
          yield* Fiber.interrupt(source.fiber);
          yield* PubSub.shutdown(source.pubsub);
        }),
      ),
    );
    return Stream.fromPubSub(source.pubsub);
  });

  const withHistoryOnFirst = (
    snapshots: Stream.Stream<MachineStatusSnapshot>,
    historyMs: number | undefined,
  ) => {
    if (historyMs === undefined || historyMs === 0) return snapshots;
    let sent = false;
    return snapshots.pipe(
      Stream.mapEffect((snapshot) => {
        if (sent) return Effect.succeed(snapshot);
        sent = true;
        return Clock.currentTimeMillis.pipe(
          Effect.map((now) => ({ ...snapshot, history: history.read(historyMs, now) })),
        );
      }),
    );
  };

  const subscribe = Effect.fn("HostResources.subscribe")(function* (input: SubscribeMachineInput) {
    if (input.intervalMs === undefined) return withHistoryOnFirst(status, input.historyMs);
    const live = yield* samples(input.intervalMs);
    // Heartbeats and verdict changes keep the last sample, so an open view never loses per-core.
    let lastSample: MachineStatusSample | undefined;
    const withSample = live.pipe(
      Stream.mapEffect((sample) => {
        lastSample = sample;
        return currentSnapshot.pipe(Effect.map((snapshot) => ({ ...snapshot, sample })));
      }),
    );
    const statusWithLastSample = status.pipe(
      Stream.map((snapshot) =>
        lastSample === undefined ? snapshot : { ...snapshot, sample: lastSample },
      ),
    );
    return withHistoryOnFirst(Stream.merge(statusWithLastSample, withSample), input.historyMs);
  });

  return HostResources.of({
    read: read(),
    status,
    statusChanges: Stream.fromPubSub(changes),
    ticks: Stream.fromPubSub(tickTotals),
    samples,
    subscribe: (input) => Stream.unwrap(subscribe(input)),
  });
});

export const layer = Layer.effect(HostResources, make());
