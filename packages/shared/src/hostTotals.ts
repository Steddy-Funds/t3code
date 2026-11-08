// @effect-diagnostics nodeBuiltinImport:off globalDate:off - plain Node so the `t3 guard` CLI can share it.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import type { MachineMemoryPressure } from "@t3tools/contracts";

export interface HostGpuTotals {
  readonly id: string;
  readonly name: string;
  readonly vendor: "nvidia" | "intel";
  readonly status: "active" | "suspended" | "unavailable";
  readonly utilPercent: number | null;
  readonly vramUsedPercent: number | null;
}

export interface HostTotals {
  readonly platform: NodeJS.Platform;
  readonly sampledAt: number;
  readonly cpuCount: number;
  /** 0–1 over the interval since the previous read; null on the first read. */
  readonly cpuUtilization: number | null;
  /** Percent 0–100 per logical core; empty on the first read. */
  readonly perCore: ReadonlyArray<number>;
  /** Null on Windows, which has no load average. */
  readonly load: { readonly one: number; readonly five: number; readonly fifteen: number } | null;
  readonly memoryTotalBytes: number;
  readonly memoryAvailableBytes: number;
  readonly swapTotalBytes: number;
  readonly swapUsedBytes: number;
  /** macOS only, from the native monitor; null elsewhere or without it. */
  readonly memoryPressure: MachineMemoryPressure | null;
  /** Absent without a native monitor, so the GPU rules skip. */
  readonly gpus?: ReadonlyArray<HostGpuTotals>;
}

/** Device totals from the monitor's `gpuTotals`, with VRAM as a share of the device's own. */
export function hostGpuTotals(
  devices: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly vendor: HostGpuTotals["vendor"];
    readonly status: HostGpuTotals["status"];
    readonly utilPercent: number | null;
    readonly vramTotalBytes: number | null;
    readonly vramUsedBytes: number | null;
  }>,
): ReadonlyArray<HostGpuTotals> {
  return devices.map((device) => ({
    id: device.id,
    name: device.name,
    vendor: device.vendor,
    status: device.status,
    utilPercent: device.utilPercent,
    vramUsedPercent:
      device.vramTotalBytes !== null && device.vramTotalBytes > 0 && device.vramUsedBytes !== null
        ? (device.vramUsedBytes / device.vramTotalBytes) * 100
        : null,
  }));
}

export type CpuCounters = ReadonlyArray<{ readonly idle: number; readonly total: number }>;

/** Host totals Node cannot read, from the native monitor (macOS pressure, available memory, swap). */
export interface NativeHostTotals {
  readonly memoryPressure: MachineMemoryPressure | null;
  readonly memoryAvailableBytes: number | null;
  readonly swapTotalBytes: number | null;
  readonly swapUsedBytes: number | null;
}

export function readCpuCounters(): CpuCounters {
  return NodeOS.cpus().map(({ times }) => ({
    idle: times.idle,
    total: times.user + times.nice + times.sys + times.idle + times.irq,
  }));
}

function busyFraction(
  previous: { idle: number; total: number },
  next: { idle: number; total: number },
) {
  const total = next.total - previous.total;
  const idle = next.idle - previous.idle;
  if (total <= 0 || idle < 0) return null;
  return Math.min(1, Math.max(0, 1 - idle / total));
}

export function cpuDeltas(previous: CpuCounters | null, next: CpuCounters) {
  if (previous === null || previous.length !== next.length) {
    return { cpuUtilization: null, perCore: [] };
  }
  const sum = (counters: CpuCounters) =>
    counters.reduce(
      (acc, core) => ({ idle: acc.idle + core.idle, total: acc.total + core.total }),
      { idle: 0, total: 0 },
    );
  return {
    cpuUtilization: busyFraction(sum(previous), sum(next)),
    perCore: next.map((core, index) => (busyFraction(previous[index]!, core) ?? 0) * 100),
  };
}

export function parseProcMeminfo(text: string) {
  const kib = (key: string) => {
    const value = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m").exec(text)?.[1];
    return value === undefined ? null : Number(value) * 1024;
  };
  const swapTotal = kib("SwapTotal");
  const swapFree = kib("SwapFree");
  return {
    memoryTotalBytes: kib("MemTotal"),
    memoryAvailableBytes: kib("MemAvailable"),
    swapTotalBytes: swapTotal ?? 0,
    swapUsedBytes: swapTotal !== null && swapFree !== null ? Math.max(0, swapTotal - swapFree) : 0,
  };
}

async function readLinuxMeminfo() {
  try {
    return parseProcMeminfo(await NodeFSP.readFile("/proc/meminfo", "utf8"));
  } catch {
    return null;
  }
}

/** Host totals with no process walk; `prev` is the previous read's CPU counters. */
export async function readHostTotals(
  prev: CpuCounters | null,
  options: {
    readonly platform?: NodeJS.Platform;
    /** macOS reads pressure, available memory and swap only from here; without it they stay unknown. */
    readonly native?: NativeHostTotals | null;
  } = {},
): Promise<{ totals: HostTotals; next: CpuCounters }> {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Plain Node module shared with the t3 guard CLI; callers can pass platform.
  const platform = options.platform ?? process.platform;
  const next = readCpuCounters();
  const { cpuUtilization, perCore } = cpuDeltas(prev, next);
  const [one = 0, five = 0, fifteen = 0] = NodeOS.loadavg();
  let memoryTotalBytes = NodeOS.totalmem();
  // On Windows libuv returns GlobalMemoryStatusEx.ullAvailPhys, including standby memory.
  let memoryAvailableBytes = NodeOS.freemem();
  let swapTotalBytes = 0;
  let swapUsedBytes = 0;
  let memoryPressure: MachineMemoryPressure | null = null;
  if (platform === "linux") {
    const meminfo = await readLinuxMeminfo();
    if (meminfo !== null) {
      memoryTotalBytes = meminfo.memoryTotalBytes ?? memoryTotalBytes;
      memoryAvailableBytes = meminfo.memoryAvailableBytes ?? memoryAvailableBytes;
      swapTotalBytes = meminfo.swapTotalBytes;
      swapUsedBytes = meminfo.swapUsedBytes;
    }
  } else if (platform === "darwin") {
    const native = options.native ?? null;
    if (native !== null) {
      memoryAvailableBytes = native.memoryAvailableBytes ?? memoryAvailableBytes;
      swapTotalBytes = native.swapTotalBytes ?? 0;
      swapUsedBytes = native.swapUsedBytes ?? 0;
      memoryPressure = native.memoryPressure;
    }
  }
  return {
    next,
    totals: {
      platform,
      sampledAt: Date.now(),
      cpuCount: next.length,
      cpuUtilization,
      perCore,
      load: platform === "win32" ? null : { one, five, fifteen },
      memoryTotalBytes,
      memoryAvailableBytes: Math.min(memoryTotalBytes, Math.max(0, memoryAvailableBytes)),
      swapTotalBytes,
      swapUsedBytes,
      memoryPressure,
    },
  };
}
