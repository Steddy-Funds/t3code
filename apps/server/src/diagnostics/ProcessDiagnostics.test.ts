import { describe, expect, it } from "@effect/vitest";
import type {
  DesktopHostTelemetrySnapshot,
  ResourceMonitorHelloEvent,
  ResourceMonitorProcessTableEntry,
  ResourceMonitorSnapshotEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "../resourceTelemetry/ResourceAttribution.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ProcessDiagnostics from "./ProcessDiagnostics.ts";
import { refuseHostSignal, serverLineage } from "./ProcessDiagnostics.ts";

// ProcessDiagnostics treats process.pid as the server, so the fixture PID is an
// offset from it. A fixed PID collides whenever the test worker is assigned it.
const SERVER_PID = process.pid;
const CHILD_PID = SERVER_PID + 1;

function makeNativeSnapshot(
  processes: ResourceMonitorSnapshotEvent["processes"],
): ResourceMonitorSnapshotEvent {
  return {
    version: 3,
    type: "snapshot",
    sequence: 1,
    sampledAtUnixMs: DateTime.toEpochMillis(DateTime.makeUnsafe("2026-05-05T10:00:00.000Z")),
    collectionDurationMicros: 250,
    scannedProcessCount: processes.length,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 0,
    processes,
  };
}

type NativeOverrides = Partial<NativeTelemetryClient.NativeTelemetryClient["Service"]>;

function layerNativeFor(
  snapshot: ResourceMonitorSnapshotEvent,
  hello: Option.Option<ResourceMonitorHelloEvent> = Option.none(),
  overrides: NativeOverrides = {},
) {
  return NativeTelemetryClient.layerTest({
    sampleNow: Effect.succeed({ generation: 0, snapshot }),
    health: Effect.succeed({
      status: "healthy",
      hello,
      lastSampleAt: Option.some(DateTime.makeUnsafe(snapshot.sampledAtUnixMs)),
      lastError: Option.none(),
      restartCount: 0,
      sampleIntervalMs: 1_000,
    }),
    ...overrides,
  });
}

function layerTelemetryFor(
  snapshot: ResourceMonitorSnapshotEvent,
  desktopSnapshot?: DesktopHostTelemetrySnapshot,
  layerNative = layerNativeFor(snapshot),
) {
  const layerDesktop = desktopSnapshot
    ? DesktopTelemetryReceiver.layerTest({
        latest: Effect.succeedSome(desktopSnapshot),
        health: Effect.succeed({
          status: "healthy",
          lastSampleAt: Option.some(DateTime.makeUnsafe(desktopSnapshot.sampledAtUnixMs)),
          lastError: Option.none(),
        }),
      })
    : DesktopTelemetryReceiver.layerTest();
  return ResourceTelemetry.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(layerNative, layerDesktop, ResourceAttribution.layer)),
  );
}

describe("ProcessDiagnostics", () => {
  it.effect("rejects stale process identities before signaling", () =>
    Effect.gen(function* () {
      const snapshot = makeNativeSnapshot([]);
      const layerTelemetry = layerTelemetryFor(snapshot);
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(layerTelemetry));

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) =>
          processDiagnostics.signal({
            pid: CHILD_PID,
            startTimeMs: 2_000,
            signal: "SIGINT",
          }),
        ),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: CHILD_PID,
        signal: "SIGINT",
        signaled: false,
        message: Option.some(
          `Process ${CHILD_PID} no longer matches the selected process identity.`,
        ),
      });
    }),
  );

  it.effect("refuses to signal when a fresh identity check cannot be collected", () =>
    Effect.gen(function* () {
      const snapshot = makeNativeSnapshot([
        {
          pid: CHILD_PID,
          ppid: SERVER_PID,
          startTimeMs: 2_000,
          runTimeMs: 4_000,
          name: "agent",
          command: "codex app-server",
          status: "Running",
          cpuPercent: 1.5,
          cpuTimeMs: 60,
          residentBytes: 2_048,
          virtualBytes: 4_096,
          ioReadBytes: 300,
          ioWriteBytes: 400,
          ioSemantics: "storage",
        },
      ]);
      const staleTelemetry = yield* Effect.service(ResourceTelemetry.ResourceTelemetry).pipe(
        Effect.flatMap((telemetry) => telemetry.latest),
        Effect.provide(layerTelemetryFor(snapshot)),
      );
      const layerTelemetry = Layer.succeed(
        ResourceTelemetry.ResourceTelemetry,
        ResourceTelemetry.ResourceTelemetry.of({
          latest: Effect.succeed(staleTelemetry),
          changes: Stream.empty,
          subscribe: Effect.die("unused"),
          readHistory: () => Effect.die("unused"),
          refresh: Effect.fail(
            new ResourceTelemetry.ResourceTelemetryRefreshFailed({
              operation: "refresh",
              cause: new Error("collector unavailable"),
            }),
          ),
          retry: Effect.die("unused"),
        }),
      );
      // The default test monitor has no hello, so the subtree rule applies.
      const layer = ProcessDiagnostics.layer.pipe(
        Layer.provide(Layer.merge(layerTelemetry, NativeTelemetryClient.layerTest())),
      );

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) =>
          processDiagnostics.signal({
            pid: CHILD_PID,
            startTimeMs: 2_000,
            signal: "SIGINT",
          }),
        ),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: CHILD_PID,
        signal: "SIGINT",
        signaled: false,
        message: Option.some(
          `Could not refresh process ${CHILD_PID}; refusing to signal a stale identity.`,
        ),
      });
    }),
  );

  it.effect("rejects Electron processes as signal targets", () =>
    Effect.gen(function* () {
      const sampledAtUnixMs = DateTime.toEpochMillis(
        DateTime.makeUnsafe("2026-05-05T10:00:00.000Z"),
      );
      const snapshot = makeNativeSnapshot([
        {
          pid: CHILD_PID,
          ppid: 1,
          startTimeMs: 2_000,
          runTimeMs: 4_000,
          name: "electron",
          command: "electron",
          status: "Running",
          cpuPercent: 1.5,
          cpuTimeMs: 60,
          residentBytes: 2_048,
          virtualBytes: 4_096,
          ioReadBytes: 300,
          ioWriteBytes: 400,
          ioSemantics: "storage",
        },
      ]);
      const sampledAt = DateTime.makeUnsafe(sampledAtUnixMs);
      const layerTelemetry = layerTelemetryFor(snapshot, {
        version: 1,
        type: "desktopTelemetry",
        sequence: 1,
        sampledAtUnixMs,
        electronPid: CHILD_PID,
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
            pid: CHILD_PID,
            creationTimeMs: 2_000,
            type: "Browser",
            name: "electron",
            cpuPercent: 1.5,
            idleWakeupsPerSecond: 0,
            workingSetBytes: 2_048,
            peakWorkingSetBytes: 2_048,
          },
        ],
      });
      const layer = ProcessDiagnostics.layer.pipe(Layer.provide(layerTelemetry));

      const result = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) =>
          processDiagnostics.signal({
            pid: CHILD_PID,
            startTimeMs: 2_000,
            signal: "SIGKILL",
          }),
        ),
        Effect.provide(layer),
      );

      expect(result).toEqual({
        pid: CHILD_PID,
        signal: "SIGKILL",
        signaled: false,
        message: Option.some(`Process ${CHILD_PID} is not a signalable T3 backend descendant.`),
      });

      const diagnostics = yield* Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
        Effect.flatMap((processDiagnostics) => processDiagnostics.read),
        Effect.provide(layer),
      );
      expect(diagnostics.processes).toEqual([]);
      expect(diagnostics.processCount).toBe(0);
      expect(diagnostics.totalCpuPercent).toBe(0);
      expect(diagnostics.totalRssBytes).toBe(0);
    }),
  );
});

const PARENT_PID = SERVER_PID + 10;
const MONITOR_PID = SERVER_PID + 2;
const TARGET_PID = SERVER_PID + 3;

const row = (
  pid: number,
  ppid: number,
  startTimeMs?: number,
): ResourceMonitorProcessTableEntry => ({
  pid,
  ppid,
  name: `p${pid}`,
  ...(startTimeMs === undefined ? {} : { startTimeMs }),
});

describe("serverLineage", () => {
  it.each<[string, Array<ResourceMonitorProcessTableEntry>, Array<number>]>([
    ["follows ppids up to pid 0", [row(30, 20), row(20, 1), row(1, 0)], [30, 20, 1]],
    ["stops at a missing parent", [row(30, 20)], [30, 20]],
    ["stops on a loop", [row(30, 20), row(20, 30)], [30, 20]],
    ["holds only the server when it is not in the table", [row(5, 1)], [30]],
    ["ignores siblings and children", [row(30, 1), row(31, 1), row(40, 30)], [30, 1]],
  ])("%s", (_name, table, expected) => {
    expect([...serverLineage(table, 30)]).toEqual(expected);
  });
});

describe("refuseHostSignal", () => {
  const table = [
    row(1, 0, 0),
    row(PARENT_PID, 1, 100),
    row(SERVER_PID, PARENT_PID, 200),
    row(MONITOR_PID, SERVER_PID, 300),
    row(TARGET_PID, 1, 2_000),
    row(TARGET_PID + 1, 1),
  ];
  const guards = { serverPid: SERVER_PID, monitorPid: MONITOR_PID };
  const identity = `no longer matches the selected process identity.`;

  it.each<[string, number, number, string | null]>([
    ["an unrelated process with its start time", TARGET_PID, 2_000, null],
    ["a start time 1000 ms off", TARGET_PID, 3_000, null],
    ["a start time 1001 ms off (pid reused)", TARGET_PID, 3_001, identity],
    ["a start time 1001 ms early", TARGET_PID, 999, identity],
    ["the monitor", MONITOR_PID, 300, "Refusing to signal the resource monitor."],
    ["the server", SERVER_PID, 200, "Refusing to signal the T3 server or a process it runs under."],
    [
      "the server's parent",
      PARENT_PID,
      100,
      "Refusing to signal the T3 server or a process it runs under.",
    ],
    ["init above the server", 1, 0, "Refusing to signal the T3 server or a process it runs under."],
    ["a pid that is gone", TARGET_PID + 50, 2_000, identity],
    ["a row without a start time", TARGET_PID + 1, 0, identity],
  ])("%s", (_name, pid, startTimeMs, expected) => {
    const refused = refuseHostSignal(table, { pid, startTimeMs }, guards);
    if (expected === null || !expected.startsWith("no longer")) {
      expect(refused).toBe(expected);
    } else {
      expect(refused).toBe(`Process ${pid} ${expected}`);
    }
  });

  it("refuses the monitor even when the table no longer lists it", () => {
    expect(
      refuseHostSignal([row(TARGET_PID, 1, 2_000)], { pid: MONITOR_PID, startTimeMs: 0 }, guards),
    ).toBe("Refusing to signal the resource monitor.");
  });
});

const helloWith = (hostProcesses: boolean | undefined): ResourceMonitorHelloEvent => ({
  version: hostProcesses === undefined ? 3 : 4,
  type: "hello",
  sidecarVersion: "0.0.0-test",
  sidecarPid: MONITOR_PID,
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
    ...(hostProcesses === undefined ? {} : { hostProcesses }),
  },
});

const HOST_TABLE = [
  row(PARENT_PID, 1, 100),
  row(SERVER_PID, PARENT_PID, 200),
  row(MONITOR_PID, SERVER_PID, 300),
  row(TARGET_PID, 1, 2_000),
];

const CHILD_SAMPLE: ResourceMonitorSnapshotEvent["processes"][number] = {
  pid: CHILD_PID,
  ppid: SERVER_PID,
  startTimeMs: 2_000,
  runTimeMs: 4_000,
  name: "agent",
  command: "codex app-server",
  status: "Running",
  cpuPercent: 1.5,
  cpuTimeMs: 60,
  residentBytes: 2_048,
  virtualBytes: 4_096,
  ioReadBytes: 300,
  ioWriteBytes: 400,
  ioSemantics: "storage",
};

function diagnosticsWith(options: {
  hello?: ResourceMonitorHelloEvent;
  processTable?: NativeOverrides["processTable"];
  processes?: ResourceMonitorSnapshotEvent["processes"];
}) {
  const calls = { processTable: 0 };
  const snapshot = makeNativeSnapshot(options.processes ?? []);
  const hello = Option.fromNullishOr(options.hello);
  const processTable = Effect.suspend(() => {
    calls.processTable++;
    return options.processTable ?? Effect.succeed(HOST_TABLE);
  });
  const layerNative = layerNativeFor(snapshot, hello, { processTable });
  const layer = ProcessDiagnostics.layer.pipe(
    Layer.provide(layerTelemetryFor(snapshot, undefined, layerNative)),
  );
  const signal = (
    input: Parameters<ProcessDiagnostics.ProcessDiagnostics["Service"]["signal"]>[0],
  ) =>
    Effect.service(ProcessDiagnostics.ProcessDiagnostics).pipe(
      Effect.flatMap((diagnostics) => diagnostics.signal(input)),
      Effect.provide(layer),
    );
  return { calls, signal };
}

const refused = (pid: number, signal: string, message: string) => ({
  pid,
  signal,
  signaled: false,
  message: Option.some(message),
});

describe("ProcessDiagnostics.signal", () => {
  it.effect.each<[string, number, string]>([
    ["pid 0", 0, "Refusing to signal process 0."],
    ["pid 1", 1, "Refusing to signal process 1."],
    ["a negative pid (a process group)", -5, "Refusing to signal process -5."],
    ["the server", SERVER_PID, "Refusing to signal the T3 server process."],
  ])("refuses %s before any lookup", ([, pid, message]) =>
    Effect.gen(function* () {
      using kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      const { calls, signal } = diagnosticsWith({ hello: helloWith(true) });
      expect(yield* signal({ pid, startTimeMs: 0, signal: "SIGKILL" })).toEqual(
        refused(pid, "SIGKILL", message),
      );
      expect(calls.processTable).toBe(0);
      expect(kill).not.toHaveBeenCalled();
    }),
  );

  it.effect("sends SIGTERM to a host process after a fresh table check", () =>
    Effect.gen(function* () {
      using kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      const { calls, signal } = diagnosticsWith({ hello: helloWith(true) });
      expect(yield* signal({ pid: TARGET_PID, startTimeMs: 2_400, signal: "SIGTERM" })).toEqual({
        pid: TARGET_PID,
        signal: "SIGTERM",
        signaled: true,
        message: Option.none(),
      });
      expect(calls.processTable).toBe(1);
      expect(kill).toHaveBeenCalledExactlyOnceWith(TARGET_PID, "SIGTERM");
    }),
  );

  it.effect.each<[string, number, number, string]>([
    [
      "a reused pid",
      TARGET_PID,
      9_000,
      `Process ${TARGET_PID} no longer matches the selected process identity.`,
    ],
    [
      "a pid that exited",
      TARGET_PID + 40,
      2_000,
      `Process ${TARGET_PID + 40} no longer matches the selected process identity.`,
    ],
    ["the monitor", MONITOR_PID, 300, "Refusing to signal the resource monitor."],
    [
      "the server's parent",
      PARENT_PID,
      100,
      "Refusing to signal the T3 server or a process it runs under.",
    ],
  ])("on the host path refuses %s without signaling", ([, pid, startTimeMs, message]) =>
    Effect.gen(function* () {
      using kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      const { calls, signal } = diagnosticsWith({ hello: helloWith(true) });
      expect(yield* signal({ pid, startTimeMs, signal: "SIGKILL" })).toEqual(
        refused(pid, "SIGKILL", message),
      );
      expect(calls.processTable).toBe(1);
      expect(kill).not.toHaveBeenCalled();
    }),
  );

  it.effect("refuses a stale identity when the process table cannot be read", () =>
    Effect.gen(function* () {
      using kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      const { signal } = diagnosticsWith({
        hello: helloWith(true),
        processTable: Effect.fail(
          new NativeTelemetryClient.NativeTelemetryUnavailable({ reason: "monitor restarting" }),
        ),
      });
      expect(yield* signal({ pid: TARGET_PID, startTimeMs: 2_000, signal: "SIGTERM" })).toEqual(
        refused(
          TARGET_PID,
          "SIGTERM",
          `Could not refresh process ${TARGET_PID}; refusing to signal a stale identity.`,
        ),
      );
      expect(kill).not.toHaveBeenCalled();
    }),
  );

  it.effect.each<[string, ResourceMonitorHelloEvent | undefined]>([
    ["a v3 monitor", helloWith(undefined)],
    ["a v4 monitor without host processes", helloWith(false)],
    ["no monitor hello", undefined],
  ])("with %s keeps the T3 subtree rule", ([, hello]) =>
    Effect.gen(function* () {
      using kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      const { calls, signal } = diagnosticsWith({
        ...(hello === undefined ? {} : { hello }),
        processes: [CHILD_SAMPLE],
      });
      expect(yield* signal({ pid: TARGET_PID, startTimeMs: 2_000, signal: "SIGTERM" })).toEqual(
        refused(
          TARGET_PID,
          "SIGTERM",
          `Process ${TARGET_PID} no longer matches the selected process identity.`,
        ),
      );
      // The subtree rule matches start time exactly; the host tolerance does not apply.
      expect(yield* signal({ pid: CHILD_PID, startTimeMs: 2_500, signal: "SIGTERM" })).toEqual(
        refused(
          CHILD_PID,
          "SIGTERM",
          `Process ${CHILD_PID} no longer matches the selected process identity.`,
        ),
      );
      expect(kill).not.toHaveBeenCalled();
      expect(
        yield* signal({ pid: CHILD_PID, startTimeMs: 2_000, signal: "SIGTERM" }),
      ).toMatchObject({
        signaled: true,
      });
      expect(kill).toHaveBeenCalledExactlyOnceWith(CHILD_PID, "SIGTERM");
      expect(calls.processTable).toBe(0);
    }),
  );

  it.effect.each(["EPERM", "EACCES"])("reports %s as not permitted", (code) =>
    Effect.gen(function* () {
      using _kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("denied"), { code });
      });
      const { signal } = diagnosticsWith({ hello: helloWith(true) });
      expect(yield* signal({ pid: TARGET_PID, startTimeMs: 2_000, signal: "SIGTERM" })).toEqual(
        refused(TARGET_PID, "SIGTERM", `Not permitted to signal process ${TARGET_PID}.`),
      );
    }),
  );

  it.effect("keeps the ProcessSignalFailed message for other failures", () =>
    Effect.gen(function* () {
      using _kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      });
      const { signal } = diagnosticsWith({ hello: helloWith(true) });
      expect(yield* signal({ pid: TARGET_PID, startTimeMs: 2_000, signal: "SIGKILL" })).toEqual(
        refused(TARGET_PID, "SIGKILL", `Failed to signal process ${TARGET_PID} with SIGKILL.`),
      );
    }),
  );
});
