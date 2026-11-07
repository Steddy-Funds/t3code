import { it } from "@effect/vitest";
import {
  MACHINE_PROCESSES_MAX_ROWS,
  type ResourceTelemetryAggregate,
  type ResourceTelemetryProcess,
  type ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import {
  type FrameInput,
  HostProcesses,
  initialFrameBuilderState,
  layer as hostProcessesLayer,
  nextFrame,
  selectProcesses,
} from "./HostProcesses.ts";
import { ResourceTelemetry } from "./ResourceTelemetry.ts";

const EPOCH = DateTime.makeUnsafe(0);

function proc(
  pid: number,
  cpuPercent: number,
  residentBytes: number,
  overrides: Partial<ResourceTelemetryProcess> = {},
): ResourceTelemetryProcess {
  return {
    identity: { pid, startTimeMs: pid * 10 },
    ppid: 1,
    childPids: [],
    depth: 0,
    name: `p${pid}`,
    command: `p${pid} --run`,
    status: "running",
    category: "server-child",
    cpuPercent,
    cpuTimeMs: 0,
    residentBytes,
    peakResidentBytes: residentBytes,
    virtualBytes: 0,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioReadBytesPerSecond: 0,
    ioWriteBytesPerSecond: 0,
    ioSemantics: "storage",
    runTimeMs: 0,
    firstSeenAt: EPOCH,
    lastSeenAt: EPOCH,
    ...overrides,
  };
}

function input(overrides: Partial<FrameInput> = {}): FrameInput {
  return {
    generation: 0,
    readAtMs: 1_000,
    nowMs: 1_500,
    monitorAvailable: true,
    processes: [proc(10, 5, 100), proc(11, 1, 200)],
    top: undefined,
    ...overrides,
  };
}

const pids = (processes: ReadonlyArray<ResourceTelemetryProcess>) =>
  processes.map((process) => process.identity.pid);

describe("selectProcesses", () => {
  it("unions top N by CPU with top N by memory without duplicating a process that tops both", () => {
    const processes = [
      proc(1, 90, 9_000),
      proc(2, 80, 10),
      proc(3, 1, 8_000),
      proc(4, 70, 20),
      proc(5, 0, 7_000),
    ];
    const { selected, truncated } = selectProcesses(processes, 2);
    expect(pids(selected).toSorted()).toEqual([1, 2, 3]);
    expect(truncated).toBe(0);
  });

  it("returns the whole table when top is omitted and under the row cap", () => {
    const processes = [proc(1, 1, 1), proc(2, 2, 2)];
    expect(selectProcesses(processes, undefined)).toEqual({ selected: processes, truncated: 0 });
  });

  it("caps the whole table at the row limit by CPU and counts the rest", () => {
    const processes = Array.from({ length: MACHINE_PROCESSES_MAX_ROWS + 3 }, (_, index) =>
      proc(index + 1, index, 1),
    );
    const { selected, truncated } = selectProcesses(processes, undefined);
    expect(selected).toHaveLength(MACHINE_PROCESSES_MAX_ROWS);
    expect(truncated).toBe(3);
    // The three lowest-CPU processes are the ones left out.
    expect(pids(selected)).not.toContain(1);
    expect(pids(selected)).not.toContain(3);
    expect(pids(selected)).toContain(4);
  });
});

describe("nextFrame", () => {
  it("starts with a full frame carrying every row in added", () => {
    const [frame, state] = nextFrame(initialFrameBuilderState, input());
    expect(frame).toEqual({
      generation: 0,
      full: true,
      sequence: 0,
      sampleAgeMs: 500,
      source: "t3",
      added: [
        {
          key: 0,
          pid: 10,
          ppid: 1,
          startTimeMs: 100,
          name: "p10",
          user: "",
          command: "p10 --run",
        },
        {
          key: 1,
          pid: 11,
          ppid: 1,
          startTimeMs: 110,
          name: "p11",
          user: "",
          command: "p11 --run",
        },
      ],
      removed: [],
      rows: { key: [0, 1], cpu: [5, 1], rss: [100, 200] },
    });
    expect(state).toMatchObject({ generation: 0, sequence: 0, nextKey: 2, lastReadAtMs: 1_000 });
  });

  it("diffs: only new processes in added, departed keys in removed, kept keys stable", () => {
    const [, first] = nextFrame(initialFrameBuilderState, input());
    const [frame, second] = nextFrame(
      first,
      input({ readAtMs: 2_000, nowMs: 2_000, processes: [proc(11, 3, 250), proc(12, 7, 300)] }),
    );
    expect(frame).toMatchObject({
      full: false,
      sequence: 1,
      sampleAgeMs: 0,
      removed: [0],
      rows: { key: [1, 2], cpu: [3, 7], rss: [250, 300] },
    });
    expect(frame?.added.map((added) => [added.key, added.pid])).toEqual([[2, 12]]);

    const [third] = nextFrame(
      second,
      input({ readAtMs: 3_000, processes: [proc(11, 4, 260), proc(12, 8, 310)] }),
    );
    expect(third).toMatchObject({ full: false, sequence: 2, added: [], removed: [] });
    expect(third?.rows.key).toEqual([1, 2]);
  });

  it("treats a reused pid with a new start time as a different process", () => {
    const [, first] = nextFrame(initialFrameBuilderState, input({ processes: [proc(10, 1, 1)] }));
    const reused = proc(10, 1, 1, { identity: { pid: 10, startTimeMs: 999 } });
    const [frame] = nextFrame(first, input({ readAtMs: 2_000, processes: [reused] }));
    expect(frame).toMatchObject({ removed: [0], rows: { key: [1] } });
    expect(frame?.added.map((added) => added.key)).toEqual([1]);
  });

  it("sends no frame when no new sample arrived", () => {
    const [, first] = nextFrame(initialFrameBuilderState, input());
    const [frame, state] = nextFrame(first, input({ nowMs: 9_000 }));
    expect(frame).toBeNull();
    expect(state).toBe(first);
  });

  it("sends a full frame with keys reset when the generation changes", () => {
    const [, first] = nextFrame(initialFrameBuilderState, input());
    const [, second] = nextFrame(
      first,
      input({ readAtMs: 2_000, processes: [proc(11, 1, 1), proc(12, 1, 1)] }),
    );
    expect(second.nextKey).toBe(3);
    // Same readAt as the last frame: a new generation still sends a frame.
    const [frame] = nextFrame(
      second,
      input({ generation: 1, readAtMs: 2_000, processes: [proc(12, 1, 1)] }),
    );
    expect(frame).toMatchObject({
      generation: 1,
      full: true,
      sequence: 2,
      removed: [],
      rows: { key: [0] },
    });
    expect(frame?.added.map((added) => [added.key, added.pid])).toEqual([[0, 12]]);
  });

  it("sends empty rows when the monitor is unavailable and removes what the client held", () => {
    const [, first] = nextFrame(initialFrameBuilderState, input());
    const [frame] = nextFrame(first, input({ readAtMs: 2_000, monitorAvailable: false }));
    expect(frame).toMatchObject({
      full: false,
      added: [],
      removed: [0, 1],
      rows: { key: [], cpu: [], rss: [] },
    });

    const [fresh] = nextFrame(initialFrameBuilderState, input({ monitorAvailable: false }));
    expect(fresh).toMatchObject({ full: true, added: [], removed: [], rows: { key: [] } });
  });

  it("sets truncated past the row cap and leaves it out otherwise", () => {
    const processes = Array.from({ length: MACHINE_PROCESSES_MAX_ROWS + 1 }, (_, index) =>
      proc(index + 1, index, 1),
    );
    const [frame] = nextFrame(initialFrameBuilderState, input({ processes }));
    expect(frame?.truncated).toBe(1);
    expect(frame?.rows.key).toHaveLength(MACHINE_PROCESSES_MAX_ROWS);

    const [small] = nextFrame(initialFrameBuilderState, input());
    expect(small).not.toHaveProperty("truncated");
  });

  it("applies top to the frame's rows", () => {
    const processes = [proc(1, 90, 1), proc(2, 1, 900), proc(3, 50, 50)];
    const [frame] = nextFrame(initialFrameBuilderState, input({ processes, top: 1 }));
    expect(frame?.added.map((added) => added.pid).toSorted()).toEqual([1, 2]);
  });
});

const emptyAggregate: ResourceTelemetryAggregate = {
  processCount: 0,
  currentCpuPercent: 0,
  cpuTimeMs: 0,
  currentRssBytes: 0,
  peakRssBytes: 0,
  ioReadBytes: 0,
  ioWriteBytes: 0,
  ioReadBytesPerSecond: 0,
  ioWriteBytesPerSecond: 0,
  processStarts: 0,
  processExits: 0,
};

function telemetrySnapshot(readAtMs: number): ResourceTelemetrySnapshot {
  const source = {
    status: "healthy" as const,
    lastSampleAt: Option.none(),
    lastError: Option.none(),
  };
  return {
    readAt: DateTime.makeUnsafe(readAtMs),
    sampleIntervalMs: 1_000,
    processes: [proc(10, 5, 100)],
    groups: {
      backend: emptyAggregate,
      electron: emptyAggregate,
      monitor: emptyAggregate,
      allT3: emptyAggregate,
    },
    power: {
      source: "electron-main",
      idle: "false",
      idleSeconds: 0,
      locked: "false",
      suspended: false,
      onBattery: "false",
      lowPowerMode: "unknown",
      thermalState: "nominal",
      stale: false,
      updatedAt: EPOCH,
    },
    speedLimitPercent: Option.none(),
    attribution: { readAt: EPOCH, entries: [] },
    health: {
      native: source,
      desktop: source,
      sidecarVersion: Option.none(),
      sidecarPid: Option.none(),
      restartCount: 0,
      collectionDurationMicros: 0,
      scannedProcessCount: 1,
      retainedProcessCount: 1,
      inaccessibleProcessCount: 0,
    },
  };
}

describe("HostProcesses.frames", () => {
  it.effect("holds the telemetry subscription while the stream runs and releases it on close", () =>
    Effect.gen(function* () {
      const holders = yield* Ref.make(0);
      const latest = yield* Ref.make(telemetrySnapshot(0));
      const telemetry = Layer.succeed(
        ResourceTelemetry,
        ResourceTelemetry.of({
          latest: Ref.get(latest),
          changes: Stream.empty,
          subscribe: Effect.acquireRelease(
            Effect.flatMap(
              Ref.update(holders, (count) => count + 1),
              () =>
                Effect.map(Ref.get(latest), (snapshot) => ({
                  latest: snapshot,
                  changes: Stream.empty,
                })),
            ),
            () => Ref.update(holders, (count) => count - 1),
          ),
          readHistory: () => Effect.die("unused"),
          refresh: Effect.die("unused"),
          retry: Effect.die("unused"),
        }),
      );
      const processes = yield* HostProcesses.pipe(
        Effect.provide(hostProcessesLayer.pipe(Layer.provide(telemetry))),
      );

      const scope = yield* Scope.make();
      // 100 ms is below the floor; the stream runs at 1 s.
      const queue = yield* Stream.toQueue(processes.frames({ intervalMs: 100 }), {
        capacity: "unbounded",
      }).pipe(Scope.provide(scope));
      expect(yield* Queue.take(queue)).toMatchObject({ full: true, sequence: 0 });
      expect(yield* Ref.get(holders)).toBe(1);

      yield* Ref.set(latest, telemetrySnapshot(5_000));
      yield* TestClock.adjust("999 millis");
      expect(yield* Queue.size(queue)).toBe(0);
      yield* TestClock.adjust("1 millis");
      expect(yield* Queue.take(queue)).toMatchObject({ full: false, sequence: 1 });

      yield* Scope.close(scope, Exit.void);
      expect(yield* Ref.get(holders)).toBe(0);
    }),
  );
});
