import { it } from "@effect/vitest";
import type { MachineStatusSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { readCpuCounters, readHostTotals, type HostTotals } from "@t3tools/shared/hostTotals";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, vi } from "vite-plus/test";

import { Scheduler } from "../scheduling/Scheduler.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { HostResources, layer as hostResourcesLayer } from "./HostResources.ts";

vi.mock("@t3tools/shared/hostTotals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/shared/hostTotals")>()),
  readHostTotals: vi.fn(),
  readCpuCounters: vi.fn(),
}));

interface Host {
  /** Load average per core on the one fake core. */
  load: number;
}

// Each counter read advances one core by 100 ticks, half of them idle: 50 % busy.
function setup(): Host {
  const host: Host = { load: 1 };
  vi.mocked(readCpuCounters).mockReset();
  vi.mocked(readCpuCounters).mockImplementation(() => {
    const reads = vi.mocked(readCpuCounters).mock.calls.length;
    return [{ idle: reads * 50, total: reads * 100 }];
  });
  vi.mocked(readHostTotals).mockReset();
  vi.mocked(readHostTotals).mockImplementation(async (prev) => {
    const totals: HostTotals = {
      platform: "linux",
      sampledAt: 0,
      cpuCount: 1,
      cpuUtilization: prev === null ? null : 0.5,
      perCore: prev === null ? [] : [50],
      load: { one: host.load, five: host.load, fifteen: host.load },
      memoryTotalBytes: 1000,
      memoryAvailableBytes: 500,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      memoryPressure: null,
    };
    return { totals, next: [{ idle: 0, total: 0 }] };
  });
  return host;
}

// The scheduler stub hands the registered tick to the test instead of running it every 5 s.
function makeLayer() {
  const ticks: Array<Effect.Effect<void>> = [];
  const scheduler = Layer.succeed(
    Scheduler,
    Scheduler.of({
      register: <E, R>(_name: string, run: Effect.Effect<void, E, R>) =>
        Effect.map(Effect.context<R>(), (context) => {
          ticks.push(Effect.orDie(Effect.provideContext(run, context)));
        }),
    }),
  );
  const layer = hostResourcesLayer.pipe(
    Layer.provide(scheduler),
    Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        machineResources: { thresholds: { enterHoldMs: 0, exitHoldMs: 0 } },
      }),
    ),
  );
  const tick = Effect.suspend(() => {
    expect(ticks).toHaveLength(1);
    return ticks[0]!;
  });
  return { layer, tick };
}

const take = <A, E>(queue: Queue.Dequeue<A, E>) => Effect.orDie(Queue.take(queue));

const statusQueue = (stream: Stream.Stream<MachineStatusSnapshot>) =>
  Stream.toQueue(stream, { capacity: "unbounded" });

describe("HostResources status", () => {
  it.effect(
    "emits the current snapshot, then one per verdict change and none for a value drift",
    () => {
      const host = setup();
      const { layer, tick } = makeLayer();
      return Effect.gen(function* () {
        const resources = yield* HostResources;
        const queue = yield* statusQueue(resources.status);
        expect(yield* take(queue)).toMatchObject({ sequence: 0, verdict: "unknown", totals: null });

        yield* tick;
        expect(yield* take(queue)).toMatchObject({ sequence: 1, verdict: "ok", reason: null });

        host.load = 2;
        yield* tick;
        host.load = 20;
        yield* tick;
        const stressed = yield* take(queue);
        expect(stressed).toMatchObject({
          sequence: 2,
          verdict: "stressed",
          reason: { rule: "load", value: 20, threshold: 12.5 },
          totals: { load: { five: 20 }, memoryTotalBytes: 1000, memoryAvailableBytes: 500 },
        });
        expect(stressed).not.toHaveProperty("sample");

        host.load = 1;
        yield* tick;
        expect(yield* take(queue)).toMatchObject({ sequence: 3, verdict: "ok" });
        expect(yield* Queue.size(queue)).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(layer));
    },
  );

  it.effect("repeats the snapshot every 30 s with the same sequence and fresh ages", () => {
    setup();
    const { layer, tick } = makeLayer();
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      yield* tick;
      const queue = yield* statusQueue(resources.status);
      expect(yield* take(queue)).toMatchObject({ sequence: 1, verdictAgeMs: 0, sampleAgeMs: 0 });

      yield* TestClock.adjust("30 seconds");
      expect(yield* take(queue)).toMatchObject({
        sequence: 1,
        verdict: "ok",
        verdictAgeMs: 30_000,
        sampleAgeMs: 30_000,
      });
      yield* TestClock.adjust("30 seconds");
      expect(yield* take(queue)).toMatchObject({ sequence: 1, verdictAgeMs: 60_000 });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("delivers a change made while a subscriber is starting", () => {
    setup();
    const { layer, tick } = makeLayer();
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      const seen = yield* resources.status.pipe(
        Stream.takeUntil((snapshot) => snapshot.sequence >= 1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* tick;
      const snapshots = yield* Fiber.join(seen);
      expect(snapshots.at(-1)).toMatchObject({ sequence: 1, verdict: "ok" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("judges each tick against the current settings", () => {
    const host = setup();
    const { layer, tick } = makeLayer();
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      const settings = yield* ServerSettingsService;
      const changes = yield* statusQueue(resources.status);
      expect(yield* take(changes)).toMatchObject({ sequence: 0, verdict: "unknown" });
      host.load = 5;
      yield* tick;
      expect(yield* take(changes)).toMatchObject({ verdict: "ok" });

      yield* settings.updateSettings({ machineResources: { thresholds: { loadPerCore: 4 } } });
      yield* tick;
      expect(yield* take(changes)).toMatchObject({
        verdict: "stressed",
        reason: { rule: "load", value: 5, threshold: 4 },
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("is unknown while host totals cannot be read", () => {
    setup();
    const { layer, tick } = makeLayer();
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      const changes = yield* statusQueue(resources.status);
      expect(yield* take(changes)).toMatchObject({ sequence: 0, verdict: "unknown" });
      yield* tick;
      expect(yield* take(changes)).toMatchObject({ verdict: "ok" });
      vi.mocked(readHostTotals).mockRejectedValueOnce(new Error("no /proc"));
      yield* tick;
      expect(yield* take(changes)).toMatchObject({ verdict: "unknown", totals: null });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});

describe("HostResources read", () => {
  it.effect("samples on demand until two ticks have run, then serves the latest tick", () => {
    setup();
    const { layer, tick } = makeLayer();
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      const onDemand = Effect.gen(function* () {
        const reading = yield* Effect.forkChild(resources.read);
        yield* TestClock.adjust("200 millis");
        return yield* Fiber.join(reading);
      });

      expect(yield* onDemand).toMatchObject({ cpuUtilization: 0.5, totalMemoryBytes: 1000 });
      yield* tick;
      expect(yield* onDemand).toMatchObject({ cpuUtilization: 0.5 });

      yield* tick;
      const readsBefore = vi.mocked(readHostTotals).mock.calls.length;
      expect(yield* resources.read).toMatchObject({
        cpuUtilization: 0.5,
        cpuCount: 1,
        availableMemoryBytes: 500,
        totalMemoryBytes: 1000,
      });
      expect(vi.mocked(readHostTotals).mock.calls.length).toBe(readsBefore);
    }).pipe(Effect.provide(layer));
  });
});

describe("HostResources samples", () => {
  it.effect(
    "shares one loop per interval, clamps below 500 ms, and stops after the last release",
    () => {
      setup();
      const { layer } = makeLayer();
      const counterReads = () => vi.mocked(readCpuCounters).mock.calls.length;
      return Effect.gen(function* () {
        const resources = yield* HostResources;
        const first = yield* Scope.make();
        const second = yield* Scope.make();
        const open = (scope: Scope.Closeable, intervalMs: number) =>
          resources.samples(intervalMs).pipe(
            Effect.flatMap((stream) => Stream.toQueue(stream, { capacity: "unbounded" })),
            Scope.provide(scope),
          );
        const firstQueue = yield* open(first, 500);
        const secondQueue = yield* open(second, 120);

        yield* TestClock.adjust("500 millis");
        expect(yield* take(firstQueue)).toEqual({ perCore: [50] });
        expect(yield* take(secondQueue)).toEqual({ perCore: [50] });
        expect(counterReads()).toBe(2);

        yield* Scope.close(first, Exit.void);
        yield* TestClock.adjust("500 millis");
        expect(yield* take(secondQueue)).toEqual({ perCore: [50] });
        expect(counterReads()).toBe(3);

        yield* Scope.close(second, Exit.void);
        yield* TestClock.adjust("5 seconds");
        expect(counterReads()).toBe(3);

        const reopened = yield* Scope.make();
        const reopenedQueue = yield* open(reopened, 500);
        yield* TestClock.adjust("500 millis");
        expect(yield* take(reopenedQueue)).toEqual({ perCore: [50] });
        expect(counterReads()).toBe(5);
        yield* Scope.close(reopened, Exit.void);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("adds a sample to subscribe only when an interval is asked for", () => {
    setup();
    const { layer, tick } = makeLayer();
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      yield* tick;
      const statusOnly = yield* statusQueue(resources.subscribe({}));
      expect(yield* take(statusOnly)).not.toHaveProperty("sample");
      yield* TestClock.adjust("30 seconds");
      expect(yield* take(statusOnly)).not.toHaveProperty("sample");
      expect(vi.mocked(readCpuCounters)).not.toHaveBeenCalled();

      const sampled = yield* statusQueue(resources.subscribe({ intervalMs: 1_000 }));
      expect(yield* take(sampled)).not.toHaveProperty("sample");
      yield* TestClock.adjust("1 second");
      expect(yield* take(sampled)).toMatchObject({
        sequence: 1,
        verdict: "ok",
        sample: { perCore: [50] },
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
