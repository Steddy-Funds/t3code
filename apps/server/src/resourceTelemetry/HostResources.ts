import {
  DEFAULT_MACHINE_THRESHOLDS,
  MACHINE_SAMPLE_MIN_INTERVAL_MS,
  type HostResourcesSnapshot,
  type MachineStatusSample,
  type MachineStatusSnapshot,
  type MachineTotalsSummary,
  type SubscribeMachineInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  cpuDeltas,
  readCpuCounters,
  readHostTotals,
  startDarwinPressureReader,
  type CpuCounters,
  type HostTotals,
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
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { Scheduler } from "../scheduling/Scheduler.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const HEARTBEAT_INTERVAL = "30 seconds";

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
    /** Per-core samples at `intervalMs` (at least 500 ms), shared by subscribers to one interval. */
    readonly samples: (
      intervalMs: number,
    ) => Effect.Effect<Stream.Stream<MachineStatusSample>, never, Scope.Scope>;
    /** `subscribeMachine`: status alone, or status plus a sample at each interval. */
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
  const layerScope = yield* Effect.scope;

  const darwin =
    platform === "darwin"
      ? yield* Effect.acquireRelease(
          Effect.sync(() => startDarwinPressureReader()),
          (reader) => Effect.sync(() => reader.stop()),
        )
      : undefined;

  const state = yield* Ref.make<TickState>({
    counters: null,
    totals: null,
    verdict: initialVerdictState(yield* Clock.currentTimeMillis),
    sequence: 0,
  });
  const changes = yield* PubSub.sliding<MachineStatusSnapshot>(16);
  const tickTotals = yield* PubSub.sliding<HostTotals>(1);

  const readTotals = (prev: CpuCounters | null) =>
    Effect.tryPromise({
      try: () => readHostTotals(prev, { platform, darwin }),
      catch: () => "unavailable" as const,
    }).pipe(Effect.option);

  const thresholds = settings.getSettings.pipe(
    Effect.map((current) => current.machineResources.thresholds),
    Effect.orElseSucceed(() => DEFAULT_MACHINE_THRESHOLDS),
  );

  // Runs every 5 s for the server's lifetime; a span per tick would only add noise.
  const tick = Effect.fnUntraced(function* () {
    const th = yield* thresholds;
    const prev = yield* Ref.get(state);
    const read = yield* readTotals(prev.counters);
    const now = yield* Clock.currentTimeMillis;
    const totals = read._tag === "Some" ? { ...read.value.totals, sampledAt: now } : null;
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
      yield* PubSub.publish(pubsub, { perCore: cpuDeltas(prev, next).perCore });
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

  const subscribe = Effect.fn("HostResources.subscribe")(function* (
    input: SubscribeMachineInput,
  ) {
    if (input.intervalMs === undefined) return status;
    const live = yield* samples(input.intervalMs);
    const withSample = live.pipe(
      Stream.mapEffect((sample) =>
        currentSnapshot.pipe(Effect.map((snapshot) => ({ ...snapshot, sample }))),
      ),
    );
    return Stream.merge(status, withSample);
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
