import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MAX_CLAIMED_PROCESSES,
  ResourceMonitorCommand,
  ResourceMonitorEvent,
} from "./resourceTelemetry.ts";

const decodeEvent = Schema.decodeUnknownSync(ResourceMonitorEvent);
const decodeCommand = Schema.decodeUnknownSync(ResourceMonitorCommand);

const v3Capabilities = {
  cumulativeCpuTime: true,
  currentCpuPercent: true,
  residentMemory: true,
  virtualMemory: true,
  ioBytes: true,
  processStartTime: true,
  processTree: true,
};

describe("ResourceMonitorEvent", () => {
  it("still decodes what a v3 monitor sends", () => {
    expect(
      decodeEvent({
        version: 3,
        type: "hello",
        sidecarVersion: "0.3.0",
        sidecarPid: 42,
        platform: "linux",
        arch: "x64",
        capabilities: v3Capabilities,
      }),
    ).toMatchObject({ version: 3, capabilities: v3Capabilities });
    expect(
      decodeEvent({
        version: 3,
        type: "snapshot",
        sequence: 1,
        sampledAtUnixMs: 1_000,
        collectionDurationMicros: 5,
        scannedProcessCount: 2,
        retainedProcessCount: 0,
        inaccessibleProcessCount: 0,
        processes: [],
      }),
    ).not.toHaveProperty("claimedPids");
    expect(
      decodeEvent({
        version: 3,
        type: "processTable",
        requestId: "req-1",
        processes: [{ pid: 1, ppid: 0, name: "init" }],
      }),
    ).toMatchObject({ processes: [{ pid: 1, ppid: 0, name: "init" }] });
  });

  it("decodes v4 host events", () => {
    const sample = decodeEvent({
      version: 4,
      type: "hostSample",
      sequence: 0,
      sampledAtUnixMs: 1_000,
      collectionDurationMicros: 5,
      scannedProcessCount: 1,
      inaccessibleProcessCount: 0,
      staticReset: true,
      processes: { pid: [7], ppid: [1], startTimeMs: [10], cpuPercent: [1.5], residentBytes: [4] },
      added: [
        {
          pid: 7,
          startTimeMs: 10,
          name: "node",
          user: "dev",
          command: "node server.js",
          exe: "/usr/bin/node",
          cwd: "/srv",
          cgroup: "/",
          containerId: "",
        },
      ],
      gpus: [
        {
          id: "0",
          vendor: "intel",
          name: "Arc",
          status: "suspended",
          utilPercent: null,
          vramTotalBytes: null,
          vramUsedBytes: null,
          sharedMemory: true,
        },
      ],
      gpuProcesses: [{ pid: 7, startTimeMs: 10, deviceId: "0", utilPercent: null, vramBytes: 0 }],
    });
    expect(sample.type).toBe("hostSample");

    expect(
      decodeEvent({
        version: 4,
        type: "hostTotals",
        requestId: "req-2",
        memoryPressure: null,
        memoryAvailableBytes: null,
        swapTotalBytes: null,
        swapUsedBytes: null,
      }),
    ).toMatchObject({ memoryPressure: null });
    expect(decodeEvent({ version: 4, type: "gpuTotals", requestId: "req-3" })).not.toHaveProperty(
      "gpus",
    );
  });

  it("rejects host events labelled v3", () => {
    expect(() =>
      decodeEvent({ version: 3, type: "gpuTotals", requestId: "req-3", gpus: [] }),
    ).toThrow();
  });
});

describe("ResourceMonitorCommand", () => {
  it(`caps claimed processes at ${MAX_CLAIMED_PROCESSES}`, () => {
    const claims = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ pid: index + 1 }));

    expect(
      decodeCommand({
        version: 4,
        type: "setClaimedProcesses",
        processes: claims(MAX_CLAIMED_PROCESSES),
      }),
    ).toMatchObject({ type: "setClaimedProcesses" });
    expect(() =>
      decodeCommand({
        version: 4,
        type: "setClaimedProcesses",
        processes: claims(MAX_CLAIMED_PROCESSES + 1),
      }),
    ).toThrow();
    expect(() =>
      decodeCommand({ version: 3, type: "setClaimedProcesses", processes: [] }),
    ).toThrow();
  });
});
