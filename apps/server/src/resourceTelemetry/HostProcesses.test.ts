import { it } from "@effect/vitest";
import {
  type GpuDeviceSample,
  type GpuProcessSample,
  MACHINE_PROCESSES_MAX_ROWS,
  type MachineProcessFrame,
  type ResourceMonitorHostProcessStatic,
  type ResourceTelemetryAggregate,
  type ResourceTelemetryProcess,
  type ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import { createMachineProcessFrameApplier } from "../../../../packages/client-runtime/src/state/machineProcessFrames.ts";
import {
  type FrameInput,
  type HostFrameInput,
  HostProcesses,
  initialFrameBuilderState,
  initialHostFrameBuilderState,
  layer as hostProcessesLayer,
  nextFrame,
  nextHostFrames,
  selectProcesses,
} from "./HostProcesses.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
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

interface HostRowSpec {
  readonly pid: number;
  readonly cpu?: number;
  readonly rss?: number;
  readonly startTimeMs?: number;
}

function hostStatic(
  pid: number,
  overrides: Partial<ResourceMonitorHostProcessStatic> = {},
): ResourceMonitorHostProcessStatic {
  return {
    pid,
    startTimeMs: pid * 10,
    name: `p${pid}`,
    user: "dev",
    command: `p${pid} --run`,
    exe: `/usr/bin/p${pid}`,
    cwd: "/",
    cgroup: "/user.slice",
    containerId: "",
    ...overrides,
  };
}

function hostSample(
  rows: ReadonlyArray<HostRowSpec>,
  options: {
    readonly generation?: number;
    readonly sampledAtUnixMs?: number;
    readonly staticReset?: boolean;
    readonly statics?: ReadonlyArray<ResourceMonitorHostProcessStatic>;
    readonly gpus?: ReadonlyArray<GpuDeviceSample>;
    readonly gpuProcesses?: ReadonlyArray<GpuProcessSample>;
  } = {},
): NativeTelemetryClient.NativeHostSample {
  const startTime = (row: HostRowSpec) => row.startTimeMs ?? row.pid * 10;
  const statics = options.statics ?? rows.map((row) => hostStatic(row.pid));
  return {
    generation: options.generation ?? 0,
    statics: new Map(statics.map((entry) => [entry.pid, entry])),
    sample: {
      version: 4,
      type: "hostSample",
      sequence: 0,
      sampledAtUnixMs: options.sampledAtUnixMs ?? 10_000,
      collectionDurationMicros: 1,
      scannedProcessCount: rows.length,
      inaccessibleProcessCount: 0,
      staticReset: options.staticReset ?? false,
      processes: {
        pid: rows.map((row) => row.pid),
        ppid: rows.map(() => 1),
        startTimeMs: rows.map(startTime),
        cpuPercent: rows.map((row) => row.cpu ?? 1),
        residentBytes: rows.map((row) => row.rss ?? 100),
      },
      ...(options.gpus ? { gpus: options.gpus } : {}),
      ...(options.gpuProcesses ? { gpuProcesses: options.gpuProcesses } : {}),
    },
  };
}

function hostInput(
  sample: NativeTelemetryClient.NativeHostSample,
  overrides: Partial<Omit<HostFrameInput, "sample">> = {},
): HostFrameInput {
  return {
    sample,
    nowMs: sample.sample.sampledAtUnixMs + 250,
    intervalMs: 1_000,
    top: undefined,
    gpuProcesses: false,
    ...overrides,
  };
}

const threeRows: ReadonlyArray<HostRowSpec> = [
  { pid: 1, cpu: 1, rss: 100 },
  { pid: 2, cpu: 2, rss: 200 },
  { pid: 3, cpu: 3, rss: 300 },
];

const gpuDevice: GpuDeviceSample = {
  id: "gpu-a",
  vendor: "nvidia",
  name: "Test GPU",
  status: "active",
  utilPercent: 40,
  vramTotalBytes: 8_000,
  vramUsedBytes: 1_000,
  sharedMemory: false,
};

const addedKeys = (frame: MachineProcessFrame) => frame.added.map((added) => added.key);

describe("nextHostFrames", () => {
  it("sends one full frame for the first sample with keys from 0", () => {
    const [frames, state] = nextHostFrames(
      initialHostFrameBuilderState,
      hostInput(hostSample(threeRows)),
    );

    expect(frames).toEqual([
      {
        generation: 0,
        full: true,
        sequence: 0,
        sampleAgeMs: 250,
        source: "host",
        added: [1, 2, 3].map((pid, key) => ({
          key,
          pid,
          ppid: 1,
          startTimeMs: pid * 10,
          name: `p${pid}`,
          user: "dev",
          command: `p${pid} --run`,
        })),
        removed: [],
        rows: { key: [0, 1, 2], cpu: [1, 2, 3], rss: [100, 200, 300] },
      },
    ]);
    expect(state).toMatchObject({
      generation: 0,
      sequence: 0,
      nextKey: 3,
      lastSampledAtMs: 10_000,
    });
  });

  it("restarts keys in a full frame on a new generation or a static reset, even inside the interval", () => {
    const [, first] = nextHostFrames(
      initialHostFrameBuilderState,
      hostInput(hostSample(threeRows)),
    );

    for (const sample of [
      hostSample([{ pid: 3 }, { pid: 4 }], { generation: 1, sampledAtUnixMs: 10_100 }),
      hostSample([{ pid: 3 }, { pid: 4 }], { staticReset: true, sampledAtUnixMs: 10_100 }),
    ]) {
      const [[frame], state] = nextHostFrames(first, hostInput(sample));
      expect(frame).toMatchObject({
        generation: sample.generation,
        full: true,
        sequence: 1,
        removed: [],
        rows: { key: [0, 1] },
      });
      expect(frame).not.toHaveProperty("complete");
      expect(frame!.added.map((added) => [added.key, added.pid])).toEqual([
        [0, 3],
        [1, 4],
      ]);
      expect(state.nextKey).toBe(2);
    }
  });

  it("skips a diff sooner than the interval less min(500 ms, half the interval)", () => {
    for (const [intervalMs, earliestMs] of [
      [2_000, 1_500],
      [600, 300],
    ] as const) {
      const [, first] = nextHostFrames(
        initialHostFrameBuilderState,
        hostInput(hostSample(threeRows), { intervalMs }),
      );
      const early = hostSample(threeRows, { sampledAtUnixMs: 10_000 + earliestMs - 1 });
      const [skipped, unchanged] = nextHostFrames(first, hostInput(early, { intervalMs }));
      expect(skipped).toEqual([]);
      expect(unchanged).toBe(first);

      const due = hostSample(threeRows, { sampledAtUnixMs: 10_000 + earliestMs });
      const [[frame]] = nextHostFrames(first, hostInput(due, { intervalMs }));
      expect(frame).toMatchObject({ full: false, sequence: 1 });
    }
  });

  it("diffs only changed rows, new keys and removed keys", () => {
    const [, first] = nextHostFrames(
      initialHostFrameBuilderState,
      hostInput(hostSample(threeRows)),
    );
    const next = hostSample(
      [
        // 1.04 rounds to the 1.0 already sent.
        { pid: 1, cpu: 1.04, rss: 100 },
        { pid: 2, cpu: 2, rss: 250 },
        { pid: 4, cpu: 4, rss: 400 },
      ],
      { sampledAtUnixMs: 11_000 },
    );
    const [[frame], second] = nextHostFrames(first, hostInput(next));

    expect(frame).toMatchObject({
      full: false,
      sequence: 1,
      removed: [2],
      rows: { key: [1, 3], cpu: [2, 4], rss: [250, 400] },
    });
    expect(frame!.added.map((added) => [added.key, added.pid])).toEqual([[3, 4]]);

    const cpuMoved = hostSample(
      [
        { pid: 1, cpu: 1.06, rss: 100 },
        { pid: 2, cpu: 2, rss: 250 },
        { pid: 4, cpu: 4, rss: 400 },
      ],
      { sampledAtUnixMs: 12_000 },
    );
    const [[moved]] = nextHostFrames(second, hostInput(cpuMoved));
    expect(moved).toMatchObject({ added: [], removed: [], rows: { key: [0], cpu: [1.1] } });
  });

  it("splits a large full frame into parts that share a sequence and rebuild the table", () => {
    const pids = Array.from({ length: 1_000 }, (_, index) => index + 1);
    const sample = hostSample(
      pids.map((pid) => ({ pid, cpu: pid / 10, rss: pid })),
      {
        statics: pids.map((pid) => hostStatic(pid, { command: "x".repeat(1_000) })),
        gpus: [gpuDevice],
        gpuProcesses: [],
      },
    );
    const [frames] = nextHostFrames(
      initialHostFrameBuilderState,
      hostInput(sample, { gpuProcesses: true }),
    );

    expect(frames.length).toBeGreaterThan(1);
    const last = frames.length - 1;
    frames.forEach((frame, index) => {
      expect(frame).toMatchObject({ full: true, complete: index === last, sequence: 0 });
      expect(frame.rows.key).toEqual(addedKeys(frame));
      const staticBytes = frame.added.reduce(
        (total, added) =>
          total + 120 + added.name.length + added.user.length + added.command.length,
        0,
      );
      expect(staticBytes).toBeLessThanOrEqual(512 * 1024);
      if (index !== last) {
        expect(frame.removed).toEqual([]);
        expect(frame).not.toHaveProperty("gpus");
      }
    });
    expect(frames[last]!.gpus).toEqual([gpuDevice]);
    expect(frames.flatMap(addedKeys)).toEqual(pids.map((_, key) => key));

    const applier = createMachineProcessFrameApplier();
    for (const frame of frames.slice(0, last)) expect(applier.apply(frame)).toBeNull();
    const table = applier.apply(frames[last]!);
    expect(table?.rows).toHaveLength(1_000);
    expect(table?.rows.find((row) => row.pid === 500)).toMatchObject({ cpu: 50, rss: 500 });
  });

  it("caps the whole table at the row limit and reports truncated on the last part only", () => {
    const rows = Array.from({ length: MACHINE_PROCESSES_MAX_ROWS + 1 }, (_, index) => ({
      pid: index + 1,
      cpu: index,
    }));
    const [frames] = nextHostFrames(initialHostFrameBuilderState, hostInput(hostSample(rows)));

    const keys = frames.flatMap((frame) => frame.rows.key);
    expect(keys).toHaveLength(MACHINE_PROCESSES_MAX_ROWS);
    expect(frames.flatMap((frame) => frame.added.map((added) => added.pid))).not.toContain(1);
    expect(frames.at(-1)?.truncated).toBe(1);
    for (const frame of frames.slice(0, -1)) expect(frame).not.toHaveProperty("truncated");
  });

  it("keeps the top N by CPU together with the top N by memory", () => {
    const sample = hostSample([
      { pid: 1, cpu: 90, rss: 9_000 },
      { pid: 2, cpu: 80, rss: 10 },
      { pid: 3, cpu: 1, rss: 8_000 },
      { pid: 4, cpu: 70, rss: 20 },
      { pid: 5, cpu: 0, rss: 7_000 },
    ]);
    const [[frame]] = nextHostFrames(initialHostFrameBuilderState, hostInput(sample, { top: 2 }));

    expect(frame!.added.map((added) => added.pid).toSorted()).toEqual([1, 2, 3]);
    expect(frame!.rows.key.toSorted()).toEqual(addedKeys(frame!).toSorted());
    expect(frame).not.toHaveProperty("truncated");
  });

  it("sums GPU use per process identity across devices only when asked", () => {
    const gpuProcesses: ReadonlyArray<GpuProcessSample> = [
      { pid: 1, startTimeMs: 10, deviceId: "gpu-a", utilPercent: 10, vramBytes: 100 },
      { pid: 1, startTimeMs: 10, deviceId: "gpu-b", utilPercent: 5, vramBytes: 50 },
      { pid: 2, startTimeMs: 20, deviceId: "gpu-a", utilPercent: null, vramBytes: null },
      // A reused pid's old identity does not count toward the live process.
      { pid: 3, startTimeMs: 999, deviceId: "gpu-a", utilPercent: 70, vramBytes: 700 },
    ];
    const sample = hostSample(threeRows, { gpus: [gpuDevice], gpuProcesses });

    const [[withGpu], state] = nextHostFrames(
      initialHostFrameBuilderState,
      hostInput(sample, { gpuProcesses: true }),
    );
    expect(withGpu!.rows).toEqual({
      key: [0, 1, 2],
      cpu: [1, 2, 3],
      rss: [100, 200, 300],
      gpuUtil: [15, null, 0],
      vram: [150, null, 0],
    });
    expect(withGpu!.gpus).toEqual([gpuDevice]);

    const [[withoutGpu]] = nextHostFrames(initialHostFrameBuilderState, hostInput(sample));
    expect(withoutGpu!.rows).not.toHaveProperty("gpuUtil");
    expect(withoutGpu!.rows).not.toHaveProperty("vram");
    expect(withoutGpu).not.toHaveProperty("gpus");

    const [[noGpuColumns]] = nextHostFrames(
      initialHostFrameBuilderState,
      hostInput(hostSample(threeRows), { gpuProcesses: true }),
    );
    expect(noGpuColumns!.rows).toMatchObject({
      key: [0, 1, 2],
      gpuUtil: [null, null, null],
      vram: [null, null, null],
    });

    // GPU rows stop (GPUs off): measured values turn null once, then rows go quiet.
    const [[unmeasured], unmeasuredState] = nextHostFrames(
      state,
      hostInput(hostSample(threeRows, { sampledAtUnixMs: 11_000 }), { gpuProcesses: true }),
    );
    expect(unmeasured!.rows).toEqual({
      key: [0, 2],
      cpu: [1, 3],
      rss: [100, 300],
      gpuUtil: [null, null],
      vram: [null, null],
    });
    const [[quiet]] = nextHostFrames(
      unmeasuredState,
      hostInput(hostSample(threeRows, { sampledAtUnixMs: 12_000 }), { gpuProcesses: true }),
    );
    expect(quiet!.rows).toEqual({ key: [], cpu: [], rss: [], gpuUtil: [], vram: [] });

    const vramMoved = hostSample(threeRows, {
      sampledAtUnixMs: 11_000,
      gpuProcesses: [
        { pid: 1, startTimeMs: 10, deviceId: "gpu-a", utilPercent: 10, vramBytes: 300 },
        { pid: 1, startTimeMs: 10, deviceId: "gpu-b", utilPercent: 5, vramBytes: 50 },
        { pid: 2, startTimeMs: 20, deviceId: "gpu-a", utilPercent: null, vramBytes: null },
      ],
    });
    const [[diff]] = nextHostFrames(state, hostInput(vramMoved, { gpuProcesses: true }));
    expect(diff!.rows).toEqual({ key: [0], cpu: [1], rss: [100], gpuUtil: [15], vram: [350] });
  });

  it("gives a reused pid a new key with empty static fields and omits empty container ids", () => {
    const statics = [
      hostStatic(1, { containerId: "c0ffee" }),
      hostStatic(2),
      hostStatic(3, { startTimeMs: 999 }),
    ];
    const [[frame], state] = nextHostFrames(
      initialHostFrameBuilderState,
      hostInput(hostSample(threeRows, { statics })),
    );
    expect(frame!.added[0]).toMatchObject({ pid: 1, containerId: "c0ffee" });
    expect(frame!.added[1]).not.toHaveProperty("containerId");
    expect(frame!.added[2]).toMatchObject({ pid: 3, name: "", user: "", command: "" });

    const reused = hostSample(
      [{ pid: 1, cpu: 1, rss: 100 }, { pid: 2, cpu: 2, rss: 200, startTimeMs: 77 }, threeRows[2]!],
      { sampledAtUnixMs: 11_000, statics },
    );
    const [[diff], reusedState] = nextHostFrames(state, hostInput(reused));
    expect(diff).toMatchObject({ removed: [1], rows: { key: [3] } });
    expect(diff!.added).toEqual([
      { key: 3, pid: 2, ppid: 1, startTimeMs: 77, name: "", user: "", command: "" },
    ]);

    // Once the statics match, an unnamed row is re-added named, with its unchanged values.
    const reusedRows = [
      threeRows[0]!,
      { pid: 2, cpu: 2, rss: 200, startTimeMs: 77 },
      threeRows[2]!,
    ];
    const namedStatics = [statics[0]!, hostStatic(2, { startTimeMs: 77 }), hostStatic(3)];
    const named = (sampledAtUnixMs: number) =>
      hostInput(hostSample(reusedRows, { sampledAtUnixMs, statics: namedStatics }));
    const [[renamed], renamedState] = nextHostFrames(reusedState, named(12_000));
    expect(renamed!.added.map((added) => [added.key, added.pid, added.name]).toSorted()).toEqual([
      [2, 3, "p3"],
      [3, 2, "p2"],
    ]);
    expect(renamed!.removed).toEqual([]);
    expect(renamed!.rows.key.toSorted()).toEqual([2, 3]);
    expect(renamed!.rows.cpu.toSorted()).toEqual([2, 3]);

    const [[settled]] = nextHostFrames(renamedState, named(13_000));
    expect(settled).toMatchObject({ added: [], removed: [], rows: { key: [] } });
  });
});

function nativeHealth(
  status: NativeTelemetryClient.NativeTelemetryClientHealth["status"],
  hostProcesses?: boolean,
): NativeTelemetryClient.NativeTelemetryClientHealth {
  return {
    status,
    hello:
      hostProcesses === undefined
        ? Option.none()
        : Option.some({
            version: 4,
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
              hostProcesses,
            },
          }),
    lastSampleAt: Option.none(),
    lastError: Option.none(),
    restartCount: 0,
    sampleIntervalMs: 1_000,
  };
}

function telemetryLayer(
  latest: Ref.Ref<ResourceTelemetrySnapshot>,
  holders: Ref.Ref<number>,
): Layer.Layer<ResourceTelemetry> {
  return Layer.succeed(
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
}

const makeHostProcesses = Effect.fn("test.makeHostProcesses")(function* (
  health: NativeTelemetryClient.NativeTelemetryClientHealth,
  changes: Stream.Stream<NativeTelemetryClient.NativeTelemetryClientHealth> = Stream.empty,
) {
  const holders = yield* Ref.make(0);
  const latest = yield* Ref.make(telemetrySnapshot(0));
  const demands = yield* Ref.make<ReadonlyArray<NativeTelemetryClient.HostSampleDemand>>([]);
  const native = NativeTelemetryClient.layerTest({
    subscribeHealth: Effect.succeed({ latest: health, changes }),
    hostSamples: (demand) =>
      Stream.unwrap(
        Ref.update(demands, (all) => [...all, demand]).pipe(
          Effect.as(Stream.make(hostSample(threeRows, { gpus: [gpuDevice], gpuProcesses: [] }))),
        ),
      ),
  });
  const processes = yield* HostProcesses.pipe(
    Effect.provide(
      hostProcessesLayer.pipe(Layer.provide(Layer.merge(telemetryLayer(latest, holders), native))),
    ),
  );
  return { processes, holders, latest, demands };
});

const firstFrame = (processes: HostProcesses["Service"]) =>
  processes
    .frames({ intervalMs: 100, gpuProcesses: true })
    .pipe(Stream.runHead, Effect.map(Option.getOrThrow));

describe("HostProcesses.frames", () => {
  it.effect("holds the telemetry subscription while the stream runs and releases it on close", () =>
    Effect.gen(function* () {
      const { processes, holders, latest } = yield* makeHostProcesses(
        nativeHealth("healthy", false),
      );

      const scope = yield* Scope.make();
      // 100 ms is below the floor; the stream runs at 1 s.
      const queue = yield* Stream.toQueue(processes.frames({ intervalMs: 100 }), {
        capacity: "unbounded",
      }).pipe(Scope.provide(scope));
      expect(yield* Queue.take(queue)).toMatchObject({ full: true, sequence: 0, source: "t3" });
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

  it.effect("streams host frames when the monitor speaks host mode", () =>
    Effect.gen(function* () {
      const { processes, holders, demands } = yield* makeHostProcesses(
        nativeHealth("healthy", true),
      );

      const frame = yield* firstFrame(processes);
      expect(frame).toMatchObject({ source: "host", full: true, gpus: [gpuDevice] });
      expect(frame.rows.key).toEqual([0, 1, 2]);
      expect(yield* Ref.get(demands)).toEqual([
        { intervalMs: 1_000, processes: true, gpus: true, gpuProcesses: true },
      ]);
      expect(yield* Ref.get(holders)).toBe(0);
    }),
  );

  it.effect("falls back to the T3 subtree without a hello", () =>
    Effect.gen(function* () {
      const { processes, demands } = yield* makeHostProcesses(nativeHealth("unavailable"));

      expect((yield* firstFrame(processes)).source).toBe("t3");
      expect(yield* Ref.get(demands)).toEqual([]);
    }),
  );

  it.effect("waits for a starting monitor to settle before choosing", () =>
    Effect.gen(function* () {
      for (const [settled, source] of [
        [nativeHealth("healthy", true), "host"],
        [nativeHealth("degraded"), "t3"],
      ] as const) {
        const changes = yield* Queue.unbounded<NativeTelemetryClient.NativeTelemetryClientHealth>();
        const { processes } = yield* makeHostProcesses(
          nativeHealth("starting"),
          Stream.fromQueue(changes),
        );
        const frame = yield* firstFrame(processes).pipe(Effect.forkChild);
        yield* Queue.offerAll(changes, [nativeHealth("starting"), settled]);
        expect((yield* Fiber.join(frame)).source).toBe(source);
      }
    }),
  );
});
