import {
  type DesktopHostTelemetrySnapshot,
  type ResourceMonitorProcessSample,
  type ResourceMonitorSnapshotEvent,
  type ResourceTelemetryHealth,
  THREAD_RESOURCE_HISTORY_POINTS,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  buildResourceTelemetryHistory,
  THREAD_HISTORY_MAX_THREADS,
  THREAD_HISTORY_STEP_MS,
  ThreadResourceHistory,
} from "./ResourceTelemetryHistory.ts";

const SERVER_PID = 100;
const ELECTRON_PID = 200;
const CHILD_PID = 300;
const STARTED_AT_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-06-17T12:00:00.000Z"));

function processSample(
  input: Partial<ResourceMonitorProcessSample> &
    Pick<ResourceMonitorProcessSample, "pid" | "ppid" | "startTimeMs">,
): ResourceMonitorProcessSample {
  return {
    runTimeMs: 1_000,
    name: `process-${input.pid}`,
    command: `process-${input.pid}`,
    status: "Running",
    cpuPercent: 0,
    cpuTimeMs: 0,
    residentBytes: 1_024,
    virtualBytes: 2_048,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioSemantics: "storage",
    ...input,
  };
}

function snapshot(
  sequence: number,
  sampledAtUnixMs: number,
  childCpuTimeMs: number,
  childWriteBytes: number,
): ResourceMonitorSnapshotEvent {
  const processes = [
    processSample({ pid: SERVER_PID, ppid: 1, startTimeMs: 10 }),
    processSample({
      pid: ELECTRON_PID,
      ppid: 1,
      startTimeMs: 20,
      name: "electron",
      command: "electron",
    }),
    processSample({
      pid: CHILD_PID,
      ppid: SERVER_PID,
      startTimeMs: 30,
      name: "codex",
      command: "codex app-server",
      cpuTimeMs: childCpuTimeMs,
      ioWriteBytes: childWriteBytes,
    }),
  ];
  return {
    version: 3,
    type: "snapshot",
    sequence,
    sampledAtUnixMs,
    collectionDurationMicros: 100,
    scannedProcessCount: processes.length,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 0,
    processes,
  };
}

const health: ResourceTelemetryHealth = {
  native: {
    status: "healthy",
    lastSampleAt: Option.none(),
    lastError: Option.none(),
  },
  desktop: {
    status: "healthy",
    lastSampleAt: Option.none(),
    lastError: Option.none(),
  },
  sidecarVersion: Option.some("0.1.0"),
  sidecarPid: Option.some(400),
  restartCount: 0,
  collectionDurationMicros: 100,
  scannedProcessCount: 3,
  retainedProcessCount: 3,
  inaccessibleProcessCount: 0,
};

function desktopSnapshot(): DesktopHostTelemetrySnapshot {
  const sampledAt = DateTime.makeUnsafe(STARTED_AT_MS + 1_000);
  return {
    version: 1,
    type: "desktopTelemetry",
    sequence: 1,
    sampledAtUnixMs: STARTED_AT_MS + 1_000,
    electronPid: ELECTRON_PID,
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
      updatedAt: sampledAt,
    },
    speedLimitPercent: Option.none(),
    electronProcesses: [
      {
        pid: ELECTRON_PID,
        creationTimeMs: 20,
        type: "Browser",
        cpuPercent: 999,
        idleWakeupsPerSecond: 999,
        workingSetBytes: 999_999,
        peakWorkingSetBytes: 999_999,
      },
    ],
  };
}

describe("buildResourceTelemetryHistory", () => {
  it("replays native snapshots on demand without applying current Electron metrics", () => {
    const history = buildResourceTelemetryHistory({
      readAt: DateTime.makeUnsafe(STARTED_AT_MS + 2_000),
      windowMs: 10_000,
      bucketMs: 10_000,
      sampleIntervalMs: 1_000,
      serverPid: SERVER_PID,
      sidecarPid: Option.some(400),
      desktopSnapshot: Option.some(desktopSnapshot()),
      snapshots: [
        snapshot(1, STARTED_AT_MS, 100, 1_000),
        snapshot(2, STARTED_AT_MS + 1_000, 350, 5_000),
      ],
      health,
    });

    const child = history.topProcesses.find((process) => process.identity.pid === CHILD_PID);
    const electron = history.topProcesses.find((process) => process.identity.pid === ELECTRON_PID);
    expect(child?.sampleCount).toBe(2);
    expect(child?.cpuTimeMs).toBe(250);
    expect(child?.ioWriteBytes).toBe(4_000);
    expect(electron?.category).toBe("electron-main");
    expect(electron?.currentRssBytes).toBe(1_024);
    expect(history.buckets.reduce((total, bucket) => total + bucket.ioWriteBytes, 0)).toBe(4_000);
  });

  it("uses observed RSS for the history-window peak instead of the lifetime process peak", () => {
    const first = snapshot(1, STARTED_AT_MS, 100, 1_000);
    const second = snapshot(2, STARTED_AT_MS + 1_000, 200, 2_000);
    const history = buildResourceTelemetryHistory({
      readAt: DateTime.makeUnsafe(STARTED_AT_MS + 2_000),
      windowMs: 10_000,
      bucketMs: 10_000,
      sampleIntervalMs: 1_000,
      serverPid: SERVER_PID,
      sidecarPid: Option.none(),
      desktopSnapshot: Option.none(),
      snapshots: [
        {
          ...first,
          processes: first.processes.map((process) =>
            process.pid === CHILD_PID
              ? { ...process, residentBytes: 2_000, peakResidentBytes: 50_000 }
              : process,
          ),
        },
        {
          ...second,
          processes: second.processes.map((process) =>
            process.pid === CHILD_PID
              ? { ...process, residentBytes: 3_000, peakResidentBytes: 60_000 }
              : process,
          ),
        },
      ],
      health,
    });

    expect(
      history.topProcesses.find((process) => process.identity.pid === CHILD_PID)?.peakRssBytes,
    ).toBe(3_000);
  });

  it("retains cumulative baselines while a process is absent from an intermediate sample", () => {
    const first = snapshot(1, STARTED_AT_MS, 100, 1_000);
    const absent = snapshot(2, STARTED_AT_MS + 1_000, 0, 0);
    const returned = snapshot(3, STARTED_AT_MS + 2_000, 350, 5_000);
    const history = buildResourceTelemetryHistory({
      readAt: DateTime.makeUnsafe(STARTED_AT_MS + 3_000),
      windowMs: 10_000,
      bucketMs: 10_000,
      sampleIntervalMs: 1_000,
      serverPid: SERVER_PID,
      sidecarPid: Option.none(),
      desktopSnapshot: Option.none(),
      snapshots: [
        first,
        {
          ...absent,
          processes: absent.processes.filter((process) => process.pid !== CHILD_PID),
        },
        returned,
      ],
      health,
    });

    const child = history.topProcesses.find((process) => process.identity.pid === CHILD_PID);
    expect(child?.cpuTimeMs).toBe(250);
    expect(child?.ioWriteBytes).toBe(4_000);
  });

  it("leaves a claimed process out of the history", () => {
    const claimed = (sample: ResourceMonitorSnapshotEvent) => ({
      ...sample,
      claimedPids: [CHILD_PID],
    });
    const history = buildResourceTelemetryHistory({
      readAt: DateTime.makeUnsafe(STARTED_AT_MS + 2_000),
      windowMs: 10_000,
      bucketMs: 10_000,
      sampleIntervalMs: 1_000,
      serverPid: SERVER_PID,
      sidecarPid: Option.none(),
      desktopSnapshot: Option.none(),
      snapshots: [
        claimed(snapshot(1, STARTED_AT_MS, 100, 1_000)),
        claimed(snapshot(2, STARTED_AT_MS + 1_000, 350, 5_000)),
      ],
      health,
    });

    expect(history.topProcesses.map((process) => process.identity.pid)).not.toContain(CHILD_PID);
  });

  it("uses the preceding sample as a baseline without attributing pre-window deltas", () => {
    const readAtMs = STARTED_AT_MS + 10_000;
    const history = buildResourceTelemetryHistory({
      readAt: DateTime.makeUnsafe(readAtMs),
      windowMs: 5_000,
      bucketMs: 5_000,
      sampleIntervalMs: 1_000,
      serverPid: SERVER_PID,
      sidecarPid: Option.none(),
      desktopSnapshot: Option.none(),
      snapshots: [
        snapshot(1, STARTED_AT_MS, 100, 1_000),
        snapshot(2, STARTED_AT_MS + 5_000, 600, 6_000),
        snapshot(3, readAtMs + 1_000, 10_000, 20_000),
      ],
      health,
    });

    const child = history.topProcesses.find((process) => process.identity.pid === CHILD_PID);
    expect(child?.sampleCount).toBe(1);
    expect(child?.cpuTimeMs).toBe(0);
    expect(child?.ioWriteBytes).toBe(0);
    expect(history.buckets.reduce((total, bucket) => total + bucket.ioWriteBytes, 0)).toBe(0);
    expect(
      history.buckets.every((bucket) => DateTime.toEpochMillis(bucket.startedAt) <= readAtMs),
    ).toBe(true);
  });

  it("prorates a cumulative delta that crosses the history window boundary", () => {
    const readAtMs = STARTED_AT_MS + 10_000;
    const history = buildResourceTelemetryHistory({
      readAt: DateTime.makeUnsafe(readAtMs),
      windowMs: 5_000,
      bucketMs: 5_000,
      sampleIntervalMs: 1_000,
      serverPid: SERVER_PID,
      sidecarPid: Option.none(),
      desktopSnapshot: Option.none(),
      snapshots: [
        snapshot(1, STARTED_AT_MS, 100, 1_000),
        snapshot(2, STARTED_AT_MS + 7_500, 850, 8_500),
      ],
      health,
    });

    const child = history.topProcesses.find((process) => process.identity.pid === CHILD_PID);
    expect(child?.cpuTimeMs).toBe(250);
    expect(child?.ioWriteBytes).toBe(2_500);
    expect(history.buckets.reduce((total, bucket) => total + bucket.ioWriteBytes, 0)).toBe(2_500);
  });

  it("replays the Electron root identity recorded with each native sample", () => {
    const oldElectron = snapshot(1, STARTED_AT_MS, 100, 1_000);
    const restartedElectron = snapshot(2, STARTED_AT_MS + 1_000, 200, 2_000);
    const history = buildResourceTelemetryHistory({
      readAt: DateTime.makeUnsafe(STARTED_AT_MS + 2_000),
      windowMs: 10_000,
      bucketMs: 10_000,
      sampleIntervalMs: 1_000,
      serverPid: SERVER_PID,
      sidecarPid: Option.none(),
      desktopSnapshot: Option.none(),
      snapshots: [
        {
          ...oldElectron,
          externalProcesses: [{ pid: ELECTRON_PID, startTimeMs: 20 }],
        },
        {
          ...restartedElectron,
          externalProcesses: [{ pid: 201, startTimeMs: 40 }],
          processes: [
            ...restartedElectron.processes.filter((process) => process.pid !== ELECTRON_PID),
            processSample({
              pid: ELECTRON_PID,
              ppid: SERVER_PID,
              startTimeMs: 999,
              name: "reused",
              command: "unrelated process",
            }),
            processSample({
              pid: 201,
              ppid: 1,
              startTimeMs: 40,
              name: "electron",
              command: "electron",
            }),
          ],
        },
      ],
      health,
    });

    expect(
      history.topProcesses.find(
        (process) => process.identity.pid === ELECTRON_PID && process.identity.startTimeMs === 20,
      )?.category,
    ).toBe("electron-main");
    expect(
      history.topProcesses.find(
        (process) => process.identity.pid === ELECTRON_PID && process.identity.startTimeMs === 999,
      )?.category,
    ).toBe("server-child");
    expect(history.topProcesses.find((process) => process.identity.pid === 201)?.category).toBe(
      "electron-main",
    );
  });
});

describe("ThreadResourceHistory", () => {
  const threadA = ThreadId.make("thread-a");
  const usage = (threadId: ThreadId, memoryBytes = 1) =>
    new Map([[threadId, { cpuPercent: 1, memoryBytes }]]);

  it("keeps the newest 240 points per thread, oldest first", () => {
    const history = new ThreadResourceHistory();
    const windows = THREAD_RESOURCE_HISTORY_POINTS + 10;
    for (let window = 0; window <= windows; window++) {
      history.record(window * THREAD_HISTORY_STEP_MS, usage(threadA, window));
    }
    const points = history.read(threadA, windows * THREAD_HISTORY_STEP_MS);
    expect(points).toHaveLength(THREAD_RESOURCE_HISTORY_POINTS);
    expect(points[0]?.memoryBytes).toBe(11);
    expect(points.at(-1)).toEqual({
      ageMs: 0,
      cpuPercent: 1,
      memoryBytes: windows,
      gpuUtilPercent: null,
    });
  });

  it("keeps the threads with the newest points, and forgets on request", () => {
    const history = new ThreadResourceHistory();
    const ids = Array.from({ length: THREAD_HISTORY_MAX_THREADS + 1 }, (_, index) =>
      ThreadId.make(`thread-${index}`),
    );
    // One window each, so thread-0's only point is the oldest when the cap is passed.
    ids.forEach((threadId, index) => {
      history.record(index * THREAD_HISTORY_STEP_MS, usage(threadId));
      history.record((index + 1) * THREAD_HISTORY_STEP_MS, new Map());
    });
    expect(history.threadIds()).toHaveLength(THREAD_HISTORY_MAX_THREADS);
    expect(history.read(ids[0]!, 0)).toEqual([]);
    expect(history.read(ids.at(-1)!, 0)).toHaveLength(1);

    history.forget([ids.at(-1)!]);
    expect(history.read(ids.at(-1)!, 0)).toEqual([]);
    expect(history.threadIds()).toHaveLength(THREAD_HISTORY_MAX_THREADS - 1);
  });

  it("closes a window at its last tick when ticks stop, so no point spans the outage", () => {
    const history = new ThreadResourceHistory();
    expect(history.record(0, usage(threadA, 5))).toBe(false);
    expect(history.record(5_000, usage(threadA, 7))).toBe(false);
    // The monitor was down for a minute.
    expect(history.record(65_000, usage(threadA, 9))).toBe(true);
    expect(history.read(threadA, 65_000).map((point) => [point.ageMs, point.memoryBytes])).toEqual([
      [60_000, 7],
    ]);
  });
});
