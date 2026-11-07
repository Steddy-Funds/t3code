import { it } from "@effect/vitest";
import type {
  GpuDeviceSample,
  MachineStatusSnapshot,
  ResourceMonitorHostTotalsEvent,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  readCpuCounters,
  readHostTotals,
  type HostGpuTotals,
  type HostTotals,
} from "@t3tools/shared/hostTotals";
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
import { HostResources, MachineHistoryRing, layer as hostResourcesLayer } from "./HostResources.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";

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
  vi.mocked(readHostTotals).mockImplementation(async (prev, options) => {
    const totals: HostTotals = {
      platform: options?.platform ?? "linux",
      sampledAt: 0,
      cpuCount: 1,
      cpuUtilization: prev === null ? null : 0.5,
      perCore: prev === null ? [] : [50],
      load: { one: host.load, five: host.load, fifteen: host.load },
      memoryTotalBytes: 1000,
      memoryAvailableBytes: 500,
      swapTotalBytes: 0,
      swapUsedBytes: 0,
      memoryPressure: options?.native?.memoryPressure ?? null,
    };
    return { totals, next: [{ idle: 0, total: 0 }] };
  });
  return host;
}

// The scheduler stub hands the registered tick to the test instead of running it every 5 s.
function makeLayer(
  options: {
    platform?: NodeJS.Platform;
    native?: Partial<NativeTelemetryClient.NativeTelemetryClient["Service"]>;
  } = {},
) {
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
    Layer.provide(Layer.succeed(HostProcess.Platform, options.platform ?? "linux")),
    Layer.provide(NativeTelemetryClient.layerTest(options.native)),
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
        expect(yield* take(firstQueue)).toEqual({ perCore: [50], gpus: [] });
        expect(yield* take(secondQueue)).toEqual({ perCore: [50], gpus: [] });
        expect(counterReads()).toBe(2);

        yield* Scope.close(first, Exit.void);
        yield* TestClock.adjust("500 millis");
        expect(yield* take(secondQueue)).toEqual({ perCore: [50], gpus: [] });
        expect(counterReads()).toBe(3);

        yield* Scope.close(second, Exit.void);
        yield* TestClock.adjust("5 seconds");
        expect(counterReads()).toBe(3);

        const reopened = yield* Scope.make();
        const reopenedQueue = yield* open(reopened, 500);
        yield* TestClock.adjust("500 millis");
        expect(yield* take(reopenedQueue)).toEqual({ perCore: [50], gpus: [] });
        expect(counterReads()).toBe(5);
        yield* Scope.close(reopened, Exit.void);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("every snapshot after the first sample has `sample`", () => {
    setup();
    const { layer, tick } = makeLayer();
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      const sampled = yield* statusQueue(resources.subscribe({ intervalMs: 500 }));
      const statusOnly = yield* statusQueue(resources.subscribe({}));
      expect(yield* take(sampled)).not.toHaveProperty("sample");

      yield* TestClock.adjust("500 millis");
      expect(yield* take(sampled)).toMatchObject({ sequence: 0, sample: { perCore: [50] } });

      yield* tick;
      expect(yield* take(sampled)).toMatchObject({
        sequence: 1,
        verdict: "ok",
        sample: { perCore: [50] },
      });

      // 60 samples from 1 s to 30.5 s, plus the heartbeat at 30 s.
      yield* TestClock.adjust("30 seconds");
      const later = yield* Effect.orDie(Queue.clear(sampled));
      expect(later).toHaveLength(61);
      for (const snapshot of later) {
        expect(snapshot).toMatchObject({ sequence: 1, sample: { perCore: [50] } });
      }

      const statusSnapshots = yield* Effect.orDie(Queue.clear(statusOnly));
      expect(statusSnapshots.map((snapshot) => snapshot.sequence)).toEqual([0, 1, 1]);
      for (const snapshot of statusSnapshots) expect(snapshot).not.toHaveProperty("sample");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

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

const unavailable = Effect.fail(
  new NativeTelemetryClient.NativeTelemetryUnavailable({ reason: "monitor restarting" }),
);

const nvidia = (overrides: Partial<GpuDeviceSample> = {}): GpuDeviceSample => ({
  id: "0000:01:00.0",
  vendor: "nvidia",
  name: "RTX 4090",
  status: "active",
  utilPercent: 20,
  vramTotalBytes: 1000,
  vramUsedBytes: 990,
  sharedMemory: false,
  ...overrides,
});

const nativeTotals = (
  overrides: Partial<ResourceMonitorHostTotalsEvent> = {},
): ResourceMonitorHostTotalsEvent => ({
  version: 4,
  type: "hostTotals",
  requestId: "req-1",
  memoryPressure: "normal",
  memoryAvailableBytes: 400,
  swapTotalBytes: 2000,
  swapUsedBytes: 100,
  ...overrides,
});

const counted = <A, E>(effect: Effect.Effect<A, E>) => {
  const calls = { count: 0 };
  return { calls, effect: Effect.suspend(() => (calls.count++, effect)) };
};

describe("HostResources tick", () => {
  it.effect("on darwin reads monitor totals and hands them to readHostTotals", () => {
    setup();
    const event = nativeTotals({ memoryPressure: "critical" });
    const hostTotals = counted(Effect.succeed(event));
    const { layer, tick } = makeLayer({
      platform: "darwin",
      native: { hostTotals: hostTotals.effect },
    });
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      const changes = yield* statusQueue(resources.status);
      yield* take(changes);
      yield* tick;
      expect(hostTotals.calls.count).toBe(1);
      expect(vi.mocked(readHostTotals).mock.calls.at(-1)![1]).toEqual({
        platform: "darwin",
        native: event,
      });
      expect(yield* take(changes)).toMatchObject({
        verdict: "stressed",
        reason: { rule: "memoryPressure" },
        totals: { memoryPressure: "critical" },
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("on darwin without the monitor passes no native totals and still judges load", () => {
    const host = setup();
    const { layer, tick } = makeLayer({ platform: "darwin", native: { hostTotals: unavailable } });
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      const changes = yield* statusQueue(resources.status);
      yield* take(changes);
      host.load = 20;
      yield* tick;
      expect(vi.mocked(readHostTotals).mock.calls.at(-1)![1]).toEqual({
        platform: "darwin",
        native: null,
      });
      expect(yield* take(changes)).toMatchObject({
        verdict: "stressed",
        reason: { rule: "load" },
        totals: { memoryPressure: null },
      });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect.each(["linux", "win32"] as const)(
    "on %s never asks the monitor for host totals",
    (platform) => {
      setup();
      const hostTotals = counted(Effect.succeed(nativeTotals()));
      const { layer, tick } = makeLayer({ platform, native: { hostTotals: hostTotals.effect } });
      return Effect.gen(function* () {
        yield* HostResources;
        yield* tick;
        yield* tick;
        expect(hostTotals.calls.count).toBe(0);
        expect(vi.mocked(readHostTotals).mock.calls.at(-1)![1]).toEqual({ platform, native: null });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("judges GPU devices from gpuTotals and records them in history", () => {
    setup();
    const { layer, tick } = makeLayer({ native: { gpuTotals: Effect.succeed([nvidia()]) } });
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      yield* tick;
      const queue = yield* statusQueue(resources.subscribe({ historyMs: 60_000 }));
      const first = yield* take(queue);
      expect(first).toMatchObject({
        verdict: "stressed",
        reason: { rule: "gpuVram", value: 99, deviceId: "0000:01:00.0", deviceName: "RTX 4090" },
      });
      expect(first.history!.gpus).toEqual([{ id: "0000:01:00.0", util: [200], vramUsed: [990] }]);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("skips GPU rules and columns when gpuTotals fails", () => {
    setup();
    const { layer, tick } = makeLayer({ native: { gpuTotals: unavailable } });
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      yield* tick;
      const first = yield* take(yield* statusQueue(resources.subscribe({ historyMs: 60_000 })));
      expect(first).toMatchObject({ verdict: "ok", reason: null });
      expect(first.history).toMatchObject({ count: 1, gpus: [] });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});

describe("HostResources samples with GPUs", () => {
  it.effect("adds device samples when gpuTotals succeeds", () => {
    setup();
    const device = nvidia({ status: "suspended", utilPercent: null, vramUsedBytes: null });
    const { layer } = makeLayer({ native: { gpuTotals: Effect.succeed([device]) } });
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      const queue = yield* Stream.toQueue(yield* resources.samples(500), { capacity: "unbounded" });
      yield* TestClock.adjust("500 millis");
      expect(yield* take(queue)).toEqual({ perCore: [50], gpus: [device] });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("omits gpus when gpuTotals fails", () => {
    setup();
    const { layer } = makeLayer({ native: { gpuTotals: unavailable } });
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      const queue = yield* Stream.toQueue(yield* resources.samples(500), { capacity: "unbounded" });
      yield* TestClock.adjust("500 millis");
      expect(yield* take(queue)).toEqual({ perCore: [50] });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});

describe("HostResources subscribe history", () => {
  it.effect("puts history on the first snapshot only", () => {
    setup();
    const { layer, tick } = makeLayer();
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      yield* tick;
      yield* TestClock.adjust("5 seconds");
      yield* tick;
      yield* TestClock.adjust("2 seconds");
      const queue = yield* statusQueue(resources.subscribe({ historyMs: 3_600_000 }));
      const first = yield* take(queue);
      expect(first.history).toMatchObject({ stepMs: 5_000, count: 2, endAgeMs: 2_000, cores: 1 });
      yield* TestClock.adjust("30 seconds");
      expect(yield* take(queue)).not.toHaveProperty("history");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("trims to historyMs", () => {
    setup();
    const { layer, tick } = makeLayer();
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      yield* tick;
      yield* tick;
      yield* tick;
      const first = yield* take(yield* statusQueue(resources.subscribe({ historyMs: 10_000 })));
      expect(first.history!.count).toBe(2);
      expect(first.history!.cpu).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("puts history on the first snapshot only when samples are asked for too", () => {
    setup();
    const { layer, tick } = makeLayer();
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      yield* tick;
      const queue = yield* statusQueue(resources.subscribe({ intervalMs: 500, historyMs: 60_000 }));
      const first = yield* take(queue);
      expect(first.history).toMatchObject({ count: 1 });
      expect(first).not.toHaveProperty("sample");
      yield* TestClock.adjust("500 millis");
      const sampled = yield* take(queue);
      expect(sampled).toMatchObject({ sample: { perCore: [50] } });
      expect(sampled).not.toHaveProperty("history");
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect.each([
    ["absent", {}],
    ["0", { historyMs: 0 }],
    ["0 with an interval", { historyMs: 0, intervalMs: 500 }],
  ] as const)("sends no history when historyMs is %s", ([, input]) => {
    setup();
    const { layer, tick } = makeLayer();
    return Effect.gen(function* () {
      const resources = yield* HostResources;
      yield* tick;
      expect(yield* take(yield* statusQueue(resources.subscribe(input)))).not.toHaveProperty(
        "history",
      );
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});

const ringTotals = (overrides: Partial<HostTotals> = {}): HostTotals => ({
  platform: "linux",
  sampledAt: 0,
  cpuCount: 2,
  cpuUtilization: 0.25,
  perCore: [10, 40],
  load: { one: 1.5, five: 1, fifteen: 1 },
  memoryTotalBytes: 1000,
  memoryAvailableBytes: 250,
  swapTotalBytes: 400,
  swapUsedBytes: 100,
  memoryPressure: null,
  ...overrides,
});

const ringGpu = (id: string, overrides: Partial<HostGpuTotals> = {}): HostGpuTotals => ({
  id,
  name: id,
  vendor: "nvidia",
  status: "active",
  utilPercent: 30,
  vramUsedPercent: 60,
  ...overrides,
});

const HOUR = 3_600_000;

describe("MachineHistoryRing", () => {
  it("is empty before the first record", () => {
    expect(new MachineHistoryRing().read(HOUR, 1_000)).toEqual({
      stepMs: 5_000,
      count: 0,
      endAgeMs: 0,
      cpu: [],
      perCore: [],
      cores: 0,
      memoryUsed: [],
      swapUsed: [],
      load1: [],
      gpus: [],
    });
  });

  it("writes one permille row per record, and -1 for a tick with no reading", () => {
    const ring = new MachineHistoryRing();
    ring.record(ringTotals(), 0);
    ring.record(null, 5_000);
    ring.record(ringTotals({ cpuUtilization: null, load: null }), 10_000);
    expect(ring.read(HOUR, 12_500)).toEqual({
      stepMs: 5_000,
      count: 3,
      endAgeMs: 2_500,
      cpu: [250, -1, -1],
      perCore: [100, 400, -1, -1, 100, 400],
      cores: 2,
      memoryUsed: [750, -1, 750],
      swapUsed: [250, -1, 250],
      load1: [1.5, -1, -1],
      gpus: [],
    });
  });

  it("reads -1 for memory and swap when their total is 0", () => {
    const ring = new MachineHistoryRing();
    ring.record(ringTotals({ memoryTotalBytes: 0, memoryAvailableBytes: 0, swapTotalBytes: 0 }), 0);
    expect(ring.read(HOUR, 0)).toMatchObject({ memoryUsed: [-1], swapUsed: [-1] });
  });

  it("clamps permille to 0–1000 and rounds load to 2 dp", () => {
    const ring = new MachineHistoryRing();
    ring.record(
      ringTotals({
        cpuUtilization: 1.5,
        perCore: [-3, 100.04],
        memoryAvailableBytes: 2000,
        load: { one: 1.23456, five: 1, fifteen: 1 },
        gpus: [ringGpu("a", { utilPercent: 12.34, vramUsedPercent: 250 })],
      }),
      0,
    );
    expect(ring.read(HOUR, 0)).toMatchObject({
      cpu: [1000],
      perCore: [0, 1000],
      memoryUsed: [0],
      load1: [1.23],
      gpus: [{ id: "a", util: [123], vramUsed: [1000] }],
    });
  });

  it("keeps the newest historyMs / 5 s rows, newest last, and ages from the last record", () => {
    const ring = new MachineHistoryRing();
    for (let index = 0; index < 10; index++) {
      ring.record(ringTotals({ cpuUtilization: index / 100 }), index * 5_000);
    }
    expect(ring.read(14_999, 50_000)).toMatchObject({ count: 2, endAgeMs: 5_000, cpu: [80, 90] });
    expect(ring.read(HOUR, 45_000)).toMatchObject({ count: 10, endAgeMs: 0 });
    expect(ring.read(4_999, 45_000)).toMatchObject({ count: 0, cpu: [], perCore: [] });
  });

  it("overwrites the oldest row on the 721st record", () => {
    const ring = new MachineHistoryRing();
    for (let index = 0; index < 721; index++) {
      ring.record(ringTotals({ cpuUtilization: (index % 1000) / 1000 }), index * 5_000);
    }
    const history = ring.read(HOUR, 720 * 5_000);
    expect(history.count).toBe(720);
    expect(history.cpu[0]).toBe(1);
    expect(history.cpu.at(-1)).toBe(720);
    expect(history.perCore).toHaveLength(720 * 2);
  });

  it("gives a GPU first seen late a full-length column with -1 before it, and -1 when it goes missing", () => {
    const ring = new MachineHistoryRing();
    ring.record(ringTotals(), 0);
    ring.record(ringTotals({ gpus: [] }), 5_000);
    ring.record(ringTotals({ gpus: [ringGpu("a", { vramUsedPercent: null })] }), 10_000);
    ring.record(ringTotals({ gpus: [] }), 15_000);
    expect(ring.read(HOUR, 15_000).gpus).toEqual([
      { id: "a", util: [-1, -1, 300, -1], vramUsed: [-1, -1, -1, -1] },
    ]);
  });

  it("keeps at most 8 GPUs", () => {
    const ring = new MachineHistoryRing();
    const ids = Array.from({ length: 9 }, (_, index) => `gpu${index}`);
    ring.record(ringTotals({ gpus: ids.map((id) => ringGpu(id)) }), 0);
    expect(ring.read(HOUR, 0).gpus.map((gpu) => gpu.id)).toEqual(ids.slice(0, 8));
  });

  it("fixes the core count at the first non-empty perCore", () => {
    const ring = new MachineHistoryRing();
    ring.record(ringTotals({ perCore: [] }), 0);
    ring.record(ringTotals({ perCore: [10, 20] }), 5_000);
    ring.record(ringTotals({ perCore: [30, 40, 50] }), 10_000);
    ring.record(ringTotals({ perCore: [60] }), 15_000);
    expect(ring.read(HOUR, 15_000)).toMatchObject({
      cores: 2,
      perCore: [-1, -1, 100, 200, 300, 400, 600, -1],
    });
  });

  it("caps per-core so a full hour on a huge host stays within 512 KB", () => {
    const ring = new MachineHistoryRing();
    const perCore = Array.from({ length: 256 }, () => 50);
    const gpus = Array.from({ length: 8 }, (_, index) => ringGpu(`gpu${index}`));
    for (let index = 0; index < 720; index++) {
      ring.record(ringTotals({ cpuCount: 256, perCore, gpus }), index * 5_000);
    }
    const history = ring.read(HOUR, 720 * 5_000);
    expect(history.cores).toBe(162);
    expect(history.perCore).toHaveLength(720 * 162);
    const values =
      history.cpu.length +
      history.memoryUsed.length +
      history.swapUsed.length +
      history.load1.length +
      history.perCore.length +
      history.gpus.reduce((sum, gpu) => sum + gpu.util.length + gpu.vramUsed.length, 0);
    expect(values * Float32Array.BYTES_PER_ELEMENT).toBeLessThanOrEqual(512 * 1024);
  });
});
