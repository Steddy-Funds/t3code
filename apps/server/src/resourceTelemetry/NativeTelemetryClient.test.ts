import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type GpuDeviceSample,
  type HostPowerSnapshot,
  ResourceMonitorCommand,
  type ResourceMonitorExternalProcess,
  type ResourceMonitorHostProcessStatic,
  type ResourceMonitorHostSampleEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import {
  combineHostSampleDemand,
  commitCollectionControlUpdate,
  foldHostStatics,
  type HostSampleDemand,
  make,
  type NativeHostSample,
  NativeTelemetryClient,
  type NativeTelemetryClientError,
  type NativeTelemetryClientHealth,
  synchronizeCollectionControlOnStart,
} from "./NativeTelemetryClient.ts";
import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";

const basePower: HostPowerSnapshot = {
  source: "electron-main",
  idle: "false",
  idleSeconds: 0,
  locked: "false",
  suspended: false,
  onBattery: "false",
  lowPowerMode: "false",
  thermalState: "nominal",
  stale: false,
  updatedAt: DateTime.makeUnsafe("2026-06-17T12:00:00.000Z"),
};

describe("commitCollectionControlUpdate", () => {
  it.effect("retains desired demand and retries unapplied sidecar state", () =>
    Effect.gen(function* () {
      const initial = {
        hostPower: basePower,
        liveSubscriberCount: 0,
        sampleIntervalMs: 5_000,
      };
      const desired = yield* Ref.make(initial);
      const applied = yield* Ref.make(initial);
      const failure = new Error("sidecar write failed");
      const receivedStates: Array<readonly [number, number]> = [];

      const received = yield* commitCollectionControlUpdate(
        desired,
        applied,
        (current) => ({
          ...current,
          liveSubscriberCount: 1,
          sampleIntervalMs: 1_000,
        }),
        (previous, next) => {
          receivedStates.push([previous.sampleIntervalMs, next.sampleIntervalMs]);
          return Effect.fail(failure);
        },
      ).pipe(Effect.flip);

      expect(received).toBe(failure);
      expect(yield* Ref.get(desired)).toEqual({
        ...initial,
        liveSubscriberCount: 1,
        sampleIntervalMs: 1_000,
      });
      expect(yield* Ref.get(applied)).toEqual(initial);

      yield* commitCollectionControlUpdate(
        desired,
        applied,
        (current) => current,
        (previous, next) => {
          receivedStates.push([previous.sampleIntervalMs, next.sampleIntervalMs]);
          return Effect.void;
        },
      );
      expect(receivedStates).toEqual([
        [5_000, 1_000],
        [5_000, 1_000],
      ]);
      expect(yield* Ref.get(applied)).toEqual(yield* Ref.get(desired));
    }),
  );

  it.effect("serializes startup synchronization with runtime control updates", () =>
    Effect.gen(function* () {
      const initial = {
        hostPower: basePower,
        liveSubscriberCount: 0,
        sampleIntervalMs: 5_000,
      };
      const desired = yield* Ref.make(initial);
      const applied = yield* Ref.make(initial);
      const ready = yield* Ref.make(false);
      const mutex = yield* Semaphore.make(1);
      const startupApplying = yield* Deferred.make<void>();
      const releaseStartup = yield* Deferred.make<void>();
      const appliedIntervals: Array<number> = [];

      const startupFiber = yield* synchronizeCollectionControlOnStart(
        mutex,
        desired,
        applied,
        (control) =>
          Effect.sync(() => {
            appliedIntervals.push(control.sampleIntervalMs);
          }).pipe(
            Effect.andThen(Deferred.succeed(startupApplying, undefined)),
            Effect.andThen(Deferred.await(releaseStartup)),
            Effect.asVoid,
          ),
        Ref.set(ready, true),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(startupApplying);

      const updateFiber = yield* mutex
        .withPermits(1)(
          commitCollectionControlUpdate(
            desired,
            applied,
            (current) => ({
              ...current,
              liveSubscriberCount: 1,
              sampleIntervalMs: 1_000,
            }),
            (_previous, next) =>
              Effect.gen(function* () {
                expect(yield* Ref.get(ready)).toBe(true);
                appliedIntervals.push(next.sampleIntervalMs);
              }),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(desired)).toEqual(initial);

      yield* Deferred.succeed(releaseStartup, undefined);
      yield* Fiber.join(startupFiber);
      yield* Fiber.join(updateFiber);

      expect(appliedIntervals).toEqual([5_000, 1_000]);
      expect(yield* Ref.get(applied)).toEqual(yield* Ref.get(desired));
    }),
  );
});

const OFF: HostSampleDemand = { intervalMs: 0, processes: false, gpus: false, gpuProcesses: false };

function demand(fields: Partial<HostSampleDemand> & { readonly intervalMs: number }) {
  return {
    processes: false,
    gpus: false,
    gpuProcesses: false,
    ...fields,
  } satisfies HostSampleDemand;
}

function hostSample(
  fields: Partial<ResourceMonitorHostSampleEvent> & { readonly sequence: number },
): ResourceMonitorHostSampleEvent {
  return {
    version: 4,
    type: "hostSample",
    sampledAtUnixMs: 1_000,
    collectionDurationMicros: 1,
    scannedProcessCount: 0,
    inaccessibleProcessCount: 0,
    staticReset: false,
    ...fields,
  };
}

function columns(pids: ReadonlyArray<number>) {
  return {
    pid: [...pids],
    ppid: pids.map(() => 1),
    startTimeMs: pids.map((pid) => pid * 1_000),
    cpuPercent: pids.map(() => 0),
    residentBytes: pids.map(() => 4_096),
  };
}

function staticEntry(pid: number, name = `process-${pid}`): ResourceMonitorHostProcessStatic {
  return {
    pid,
    startTimeMs: pid * 1_000,
    name,
    user: "dev",
    command: `run ${pid}`,
    exe: "/usr/bin/run",
    cwd: "/",
    cgroup: "/user.slice",
    containerId: "",
  };
}

const gpuDevice: GpuDeviceSample = {
  id: "0000:01:00.0",
  vendor: "nvidia",
  name: "Test GPU",
  status: "active",
  utilPercent: 12,
  vramTotalBytes: 8_192,
  vramUsedBytes: 1_024,
  sharedMemory: false,
};

describe("combineHostSampleDemand", () => {
  it("turns host streaming off without demands", () => {
    expect(combineHostSampleDemand([], true)).toEqual(OFF);
  });

  it("takes the fastest interval, floored at one second, and the union of fields", () => {
    expect(
      combineHostSampleDemand(
        [
          demand({ intervalMs: 5_000, processes: true }),
          demand({ intervalMs: 1_800.6, gpus: true }),
          demand({ intervalMs: 2_000, gpuProcesses: true }),
        ],
        true,
      ),
    ).toEqual({ intervalMs: 1_801, processes: true, gpus: true, gpuProcesses: true });
    expect(combineHostSampleDemand([demand({ intervalMs: 0 })], true).intervalMs).toBe(1_000);
    expect(combineHostSampleDemand([demand({ intervalMs: 250 })], true).intervalMs).toBe(1_000);
  });

  it("masks GPU fields once GPUs are off", () => {
    expect(
      combineHostSampleDemand(
        [demand({ intervalMs: 2_000, processes: true, gpus: true, gpuProcesses: true })],
        false,
      ),
    ).toEqual({ intervalMs: 2_000, processes: true, gpus: false, gpuProcesses: false });
  });
});

describe("foldHostStatics", () => {
  it("starts over on a static reset", () => {
    const previous = new Map([[7, staticEntry(7)]]);
    const next = foldHostStatics(
      previous,
      hostSample({
        sequence: 1,
        staticReset: true,
        processes: columns([7, 8]),
        added: [staticEntry(8)],
      }),
    );

    expect([...next.keys()]).toEqual([8]);
    expect([...previous.keys()]).toEqual([7]);
  });

  it("keeps the same table when nothing changed", () => {
    const previous = new Map([[7, staticEntry(7)]]);
    expect(
      foldHostStatics(previous, hostSample({ sequence: 2, processes: columns([7, 9]), added: [] })),
    ).toBe(previous);
    expect(foldHostStatics(previous, hostSample({ sequence: 3 }))).toBe(previous);
  });

  it("drops identities missing from the columns and replaces reused pids", () => {
    const previous = new Map([
      [7, staticEntry(7)],
      [8, staticEntry(8)],
    ]);
    const reused = { ...staticEntry(8, "reused"), startTimeMs: 99_000 };
    const next = foldHostStatics(
      previous,
      hostSample({ sequence: 2, processes: columns([8, 9]), added: [reused, staticEntry(9)] }),
    );

    expect([...next.keys()].toSorted()).toEqual([8, 9]);
    expect(next.get(8)).toEqual(reused);
    expect(previous.get(8)?.name).toBe("process-8");
  });

  it("treats a reset without process columns as an empty table", () => {
    const previous = new Map([[7, staticEntry(7)]]);
    expect(foldHostStatics(previous, hostSample({ sequence: 1, staticReset: true })).size).toBe(0);
  });
});

const decodeCommand = Schema.decodeUnknownSync(Schema.fromJsonString(ResourceMonitorCommand));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface FakeMonitor {
  readonly commands: Queue.Queue<ResourceMonitorCommand>;
  readonly emit: (event: object) => Effect.Effect<void>;
  readonly exit: (code: number) => Effect.Effect<void>;
  readonly closeStdout: Effect.Effect<void>;
}

type Command<T extends ResourceMonitorCommand["type"]> = Extract<
  ResourceMonitorCommand,
  { readonly type: T }
>;

/** A client wired to scripted monitors: each spawn hands the test a new `FakeMonitor`. */
const makeClient = Effect.gen(function* () {
  const monitors = yield* Queue.unbounded<FakeMonitor>();
  let requests = 0;
  const spawner = ChildProcessSpawner.make(() =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const commands = yield* Queue.unbounded<ResourceMonitorCommand>();
      const exitCode = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const monitor: FakeMonitor = {
        commands,
        emit: (event) =>
          Queue.offer(stdout, encoder.encode(`${JSON.stringify(event)}\n`)).pipe(Effect.asVoid),
        exit: (code) =>
          Deferred.succeed(exitCode, ChildProcessSpawner.ExitCode(code)).pipe(Effect.asVoid),
        closeStdout: Queue.end(stdout).pipe(Effect.asVoid),
      };
      yield* Queue.offer(monitors, monitor);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(4_242),
        exitCode: Deferred.await(exitCode),
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.forEach(
            decoder
              .decode(chunk)
              .split("\n")
              .filter((line) => line.length > 0),
            (line) => Queue.offer(commands, decodeCommand(line)),
            { discard: true },
          ),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const client = yield* make().pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(
          ResourceMonitorBinary.ResourceMonitorBinary,
          ResourceMonitorBinary.ResourceMonitorBinary.of({
            resolve: Effect.succeed("/fake/t3-resource-monitor"),
          }),
        ),
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => {
            requests += 1;
            const bytes = new Uint8Array(size);
            bytes[0] = requests & 0xff;
            bytes[1] = (requests >> 8) & 0xff;
            return bytes;
          }),
        ),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-native-telemetry-test-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
  return { client, nextMonitor: Queue.take(monitors) };
});

type Client = NativeTelemetryClient["Service"];

function hello(version: 3 | 4, capabilities: Record<string, boolean> = {}) {
  return {
    version,
    type: "hello",
    sidecarVersion: "0.4.0",
    sidecarPid: 4_242,
    platform: "linux",
    arch: "x64",
    capabilities: {
      cumulativeCpuTime: true,
      currentCpuPercent: true,
      residentMemory: true,
      virtualMemory: true,
      ioBytes: true,
      processStartTime: true,
      processTree: true,
      ...(version === 4
        ? { hostProcesses: true, gpuNvidia: true, gpuIntel: false, hostTotals: false }
        : {}),
      ...capabilities,
    },
  };
}

const takeCommand = <T extends ResourceMonitorCommand["type"]>(monitor: FakeMonitor, type: T) =>
  Queue.take(monitor.commands).pipe(
    Effect.map((command) => {
      expect(command.type).toBe(type);
      return command as Command<T>;
    }),
  );

/** Says hello and returns the startup commands, ending with `setExternalProcesses`. */
const handshake = Effect.fn("test.handshake")(function* (monitor: FakeMonitor, version: 3 | 4) {
  yield* monitor.emit(hello(version));
  const startup: Array<ResourceMonitorCommand> = [];
  while (startup.at(-1)?.type !== "setExternalProcesses") {
    startup.push(yield* Queue.take(monitor.commands));
  }
  return startup;
});

/**
 * A processTable round trip. The monitor answers in order, so every event emitted before it
 * has been handled, and it must be the next command, so nothing else was written meanwhile.
 */
const roundTrip = Effect.fn("test.roundTrip")(function* (client: Client, monitor: FakeMonitor) {
  const table = yield* client.processTable.pipe(Effect.forkChild);
  const command = yield* takeCommand(monitor, "processTable");
  yield* monitor.emit({
    version: command.version,
    type: "processTable",
    requestId: command.requestId,
    processes: [],
  });
  yield* Fiber.join(table);
  return command;
});

const awaitHealth = (client: Client, done: (health: NativeTelemetryClientHealth) => boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { latest, changes } = yield* client.subscribeHealth;
      if (done(latest)) return latest;
      return Option.getOrThrow(yield* changes.pipe(Stream.filter(done), Stream.runHead));
    }),
  );

const collectHostSamples = Effect.fn("test.collectHostSamples")(function* (
  client: Client,
  hostDemand: HostSampleDemand,
) {
  const received = yield* Queue.unbounded<NativeHostSample>();
  const fiber = yield* client.hostSamples(hostDemand).pipe(
    Stream.runForEach((sample) => Queue.offer(received, sample)),
    Effect.forkChild,
  );
  return { received, fiber };
});

const claims = (count: number): ReadonlyArray<ResourceMonitorExternalProcess> =>
  Array.from({ length: count }, (_, index) => ({ pid: index + 10, startTimeMs: 1_000 }));

describe("NativeTelemetryClient with a native monitor", () => {
  it.effect("keeps a v3 monitor working and reports host features unavailable", () =>
    Effect.gen(function* () {
      const { client, nextMonitor } = yield* makeClient;
      const monitor = yield* nextMonitor;
      const startup = yield* handshake(monitor, 3);

      expect(startup.map((command) => [command.type, command.version])).toEqual([
        ["configure", 3],
        ["setExternalProcesses", 3],
      ]);
      expect((yield* client.capabilities).hostProcesses).toBeUndefined();

      yield* client.setClaimedProcesses(claims(2));
      const samples = yield* collectHostSamples(
        client,
        demand({ intervalMs: 1_000, processes: true }),
      );
      const requests: ReadonlyArray<Effect.Effect<void, NativeTelemetryClientError>> = [
        Effect.asVoid(client.hostTotals),
        Effect.asVoid(client.gpuTotals),
        Effect.asVoid(client.hostSampleNow({ processes: true, gpus: false, gpuProcesses: false })),
      ];
      for (const request of requests) {
        const error = yield* Effect.flip(request);
        expect(error._tag).toBe("NativeTelemetryUnavailable");
        expect(error.message).toContain("vp run build:resource-monitor");
      }

      expect((yield* roundTrip(client, monitor)).version).toBe(3);
      expect(yield* Queue.size(samples.received)).toBe(0);
      expect((yield* client.health).status).toBe("healthy");
      yield* Fiber.interrupt(samples.fiber);
    }),
  );

  it.effect("resends claims and host demand after a restart and folds statics per generation", () =>
    Effect.gen(function* () {
      const { client, nextMonitor } = yield* makeClient;
      yield* client.setClaimedProcesses(claims(2));
      const first = yield* nextMonitor;
      const startup = yield* handshake(first, 4);
      expect(startup.map((command) => [command.type, command.version])).toEqual([
        ["configure", 4],
        ["setClaimedProcesses", 4],
        ["setExternalProcesses", 4],
      ]);
      expect((startup[1] as Command<"setClaimedProcesses">).processes).toEqual(claims(2));
      yield* roundTrip(client, first);

      const hostDemand = demand({ intervalMs: 2_000, processes: true });
      const samples = yield* collectHostSamples(client, hostDemand);
      expect(yield* takeCommand(first, "setHostStreaming")).toEqual({
        version: 4,
        type: "setHostStreaming",
        ...hostDemand,
      });
      yield* first.emit(
        hostSample({
          sequence: 1,
          staticReset: true,
          processes: columns([10, 11]),
          added: [staticEntry(10), staticEntry(11)],
        }),
      );
      const initial = yield* Queue.take(samples.received);
      expect(initial.generation).toBe(0);
      expect([...initial.statics.keys()].toSorted()).toEqual([10, 11]);

      yield* first.exit(1);
      yield* awaitHealth(client, (health) => health.restartCount === 1);
      yield* TestClock.adjust("500 millis");
      const second = yield* nextMonitor;
      expect((yield* handshake(second, 4)).map((command) => command.type)).toEqual([
        "configure",
        "setClaimedProcesses",
        "setExternalProcesses",
      ]);
      expect((yield* takeCommand(second, "setHostStreaming")).intervalMs).toBe(2_000);

      yield* second.emit(hostSample({ sequence: 1, processes: columns([10]) }));
      const restarted = yield* Queue.take(samples.received);
      expect(restarted.generation).toBe(1);
      expect(restarted.statics.size).toBe(0);

      yield* client.setClaimedProcesses(claims(300));
      expect((yield* takeCommand(second, "setClaimedProcesses")).processes).toHaveLength(256);
      yield* Fiber.interrupt(samples.fiber);
      expect((yield* takeCommand(second, "setHostStreaming")).intervalMs).toBe(0);
    }),
  );

  it.effect("shares one host stream and turns it off with the last subscriber", () =>
    Effect.gen(function* () {
      const { client, nextMonitor } = yield* makeClient;
      const monitor = yield* nextMonitor;
      yield* handshake(monitor, 4);
      yield* roundTrip(client, monitor);

      const slow = yield* collectHostSamples(
        client,
        demand({ intervalMs: 5_000, processes: true }),
      );
      expect(yield* takeCommand(monitor, "setHostStreaming")).toMatchObject({
        intervalMs: 5_000,
        processes: true,
        gpus: false,
      });
      const fast = yield* collectHostSamples(client, demand({ intervalMs: 1_500, gpus: true }));
      expect(yield* takeCommand(monitor, "setHostStreaming")).toMatchObject({
        intervalMs: 1_500,
        processes: true,
        gpus: true,
      });
      const same = yield* collectHostSamples(
        client,
        demand({ intervalMs: 5_000, processes: true }),
      );
      yield* monitor.emit(hostSample({ sequence: 1 }));
      for (const subscriber of [slow, fast, same]) {
        expect((yield* Queue.take(subscriber.received)).sample.sequence).toBe(1);
      }

      yield* Fiber.interrupt(fast.fiber);
      expect(yield* takeCommand(monitor, "setHostStreaming")).toMatchObject({
        intervalMs: 5_000,
        processes: true,
        gpus: false,
      });
      yield* Fiber.interrupt(same.fiber);
      yield* roundTrip(client, monitor);
      yield* Fiber.interrupt(slow.fiber);
      expect(yield* takeCommand(monitor, "setHostStreaming")).toEqual({
        version: 4,
        type: "setHostStreaming",
        ...OFF,
      });
    }),
  );

  it.effect("resolves requested host samples without publishing them", () =>
    Effect.gen(function* () {
      const { client, nextMonitor } = yield* makeClient;
      const monitor = yield* nextMonitor;
      yield* handshake(monitor, 4);
      yield* roundTrip(client, monitor);
      const samples = yield* collectHostSamples(
        client,
        demand({ intervalMs: 1_000, processes: true }),
      );
      yield* takeCommand(monitor, "setHostStreaming");

      const requested = yield* client
        .hostSampleNow({ processes: true, gpus: false, gpuProcesses: true })
        .pipe(Effect.forkChild);
      const command = yield* takeCommand(monitor, "hostSampleNow");
      expect(command).toMatchObject({ processes: true, gpus: false, gpuProcesses: true });
      yield* monitor.emit(
        hostSample({
          sequence: 1,
          requestId: command.requestId,
          staticReset: true,
          processes: columns([10]),
          added: [staticEntry(10)],
        }),
      );
      const reply = yield* Fiber.join(requested);
      expect(reply.sample.requestId).toBe(command.requestId);
      expect([...reply.statics.keys()]).toEqual([10]);

      yield* monitor.emit(hostSample({ sequence: 2, processes: columns([10]) }));
      const published = yield* Queue.take(samples.received);
      expect(published.sample.sequence).toBe(2);
      expect(published.statics.get(10)?.name).toBe("process-10");

      const totals = yield* client.hostTotals.pipe(Effect.forkChild);
      const totalsCommand = yield* takeCommand(monitor, "hostTotals");
      yield* monitor.emit({
        version: 4,
        type: "hostTotals",
        requestId: totalsCommand.requestId,
        memoryPressure: null,
        memoryAvailableBytes: null,
        swapTotalBytes: null,
        swapUsedBytes: null,
      });
      expect((yield* Fiber.join(totals)).memoryPressure).toBeNull();
      yield* Fiber.interrupt(samples.fiber);
    }),
  );

  it.effect("turns GPUs off on gpu-unavailable without degrading health", () =>
    Effect.gen(function* () {
      const { client, nextMonitor } = yield* makeClient;
      const monitor = yield* nextMonitor;
      yield* handshake(monitor, 4);
      yield* roundTrip(client, monitor);
      const samples = yield* collectHostSamples(
        client,
        demand({ intervalMs: 1_000, processes: true, gpus: true, gpuProcesses: true }),
      );
      expect(yield* takeCommand(monitor, "setHostStreaming")).toMatchObject({
        gpus: true,
        gpuProcesses: true,
      });

      yield* monitor.emit({
        version: 4,
        type: "error",
        code: "gpu-unavailable",
        message: "GPU queries failed three times in a row",
        recoverable: true,
      });
      expect(yield* takeCommand(monitor, "setHostStreaming")).toEqual({
        version: 4,
        type: "setHostStreaming",
        intervalMs: 1_000,
        processes: true,
        gpus: false,
        gpuProcesses: false,
      });

      expect(yield* client.gpuTotals).toEqual([]);
      const requested = yield* client
        .hostSampleNow({ processes: false, gpus: true, gpuProcesses: true })
        .pipe(Effect.forkChild);
      const command = yield* takeCommand(monitor, "hostSampleNow");
      expect(command).toMatchObject({ processes: false, gpus: false, gpuProcesses: false });
      yield* monitor.emit(hostSample({ sequence: 1, requestId: command.requestId }));
      yield* Fiber.join(requested);

      yield* roundTrip(client, monitor);
      const health = yield* client.health;
      expect(health.status).toBe("healthy");
      expect(Option.isNone(health.lastError)).toBe(true);
      yield* Fiber.interrupt(samples.fiber);
    }),
  );

  it.effect("degrades on a recoverable error and restarts on a fatal one", () =>
    Effect.gen(function* () {
      const { client, nextMonitor } = yield* makeClient;
      const monitor = yield* nextMonitor;
      yield* handshake(monitor, 4);

      yield* monitor.emit({
        version: 4,
        type: "error",
        code: "sample-failed",
        message: "could not read /proc",
        recoverable: true,
      });
      const degraded = yield* awaitHealth(client, (health) => health.status === "degraded");
      expect(degraded.lastError).toEqual(Option.some("could not read /proc"));
      expect(degraded.restartCount).toBe(0);
      yield* roundTrip(client, monitor);

      yield* monitor.emit({
        version: 4,
        type: "error",
        code: "internal",
        message: "collector panicked",
        recoverable: false,
      });
      const restarted = yield* awaitHealth(client, (health) => health.restartCount === 1);
      expect(restarted.status).toBe("degraded");
      expect(Option.isNone(restarted.hello)).toBe(true);
    }),
  );

  it.effect("keeps GPUs after a clean exit and turns them off after a crash that used them", () =>
    Effect.gen(function* () {
      const { client, nextMonitor } = yield* makeClient;
      const first = yield* nextMonitor;
      yield* handshake(first, 4);
      const totals = yield* client.gpuTotals.pipe(Effect.forkChild);
      const command = yield* takeCommand(first, "gpuTotals");
      yield* first.emit({
        version: 4,
        type: "gpuTotals",
        requestId: command.requestId,
        gpus: [gpuDevice],
      });
      expect(yield* Fiber.join(totals)).toEqual([gpuDevice]);

      yield* first.exit(0);
      yield* awaitHealth(client, (health) => health.restartCount === 1);
      yield* TestClock.adjust("500 millis");
      const second = yield* nextMonitor;
      yield* handshake(second, 4);
      const failed = yield* client.gpuTotals.pipe(Effect.flip, Effect.forkChild);
      const failedCommand = yield* takeCommand(second, "gpuTotals");
      yield* second.emit({ version: 4, type: "gpuTotals", requestId: failedCommand.requestId });
      const error = yield* Fiber.join(failed);
      expect(error._tag).toBe("NativeTelemetryCommandFailed");

      yield* second.exit(1);
      yield* awaitHealth(client, (health) => health.restartCount === 2);
      yield* TestClock.adjust("1 second");
      const third = yield* nextMonitor;
      yield* handshake(third, 4);
      expect(yield* client.gpuTotals).toEqual([]);
      yield* roundTrip(client, third);
    }),
  );

  it.effect("turns GPUs off when the event stream closes after GPU use", () =>
    Effect.gen(function* () {
      const { client, nextMonitor } = yield* makeClient;
      const first = yield* nextMonitor;
      yield* handshake(first, 4);
      const totals = yield* client.gpuTotals.pipe(Effect.forkChild);
      const command = yield* takeCommand(first, "gpuTotals");
      yield* first.emit({ version: 4, type: "gpuTotals", requestId: command.requestId, gpus: [] });
      expect(yield* Fiber.join(totals)).toEqual([]);

      yield* first.closeStdout;
      yield* awaitHealth(client, (health) => health.restartCount === 1);
      yield* TestClock.adjust("500 millis");
      const second = yield* nextMonitor;
      yield* handshake(second, 4);
      expect(yield* client.gpuTotals).toEqual([]);
      yield* roundTrip(client, second);
    }),
  );

  it.effect("rejects a monitor speaking an unknown protocol version", () =>
    Effect.gen(function* () {
      const { client, nextMonitor } = yield* makeClient;
      const monitor = yield* nextMonitor;
      const degraded = yield* awaitHealth(client, (current) => current.restartCount === 1).pipe(
        Effect.forkChild,
      );
      yield* monitor.emit({ ...hello(4), version: 5 });
      // A correct client fails at once; the adjust only keeps a regression from hanging.
      yield* TestClock.adjust("5 seconds");

      const health = yield* Fiber.join(degraded);
      expect(health.status).toBe("degraded");
      expect(Option.getOrThrow(health.lastError)).toContain("protocol 5");
    }),
  );

  it.effect("decodes event lines far beyond the default line limit", () =>
    Effect.gen(function* () {
      const { client, nextMonitor } = yield* makeClient;
      const monitor = yield* nextMonitor;
      yield* handshake(monitor, 4);
      const requested = yield* client
        .hostSampleNow({ processes: true, gpus: false, gpuProcesses: false })
        .pipe(Effect.forkChild);
      const command = yield* takeCommand(monitor, "hostSampleNow");
      const pids = Array.from({ length: 2_000 }, (_, index) => index + 1);
      yield* monitor.emit(
        hostSample({
          sequence: 1,
          requestId: command.requestId,
          staticReset: true,
          processes: columns(pids),
          added: pids.map((pid) => ({ ...staticEntry(pid), command: "x".repeat(2_048) })),
        }),
      );

      expect((yield* Fiber.join(requested)).statics.size).toBe(2_000);
      expect((yield* client.health).restartCount).toBe(0);
    }),
  );
});
