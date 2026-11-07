// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - plain Node so the `t3 guard` CLI can share it.
import * as NodeChildProcess from "node:child_process";
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
  /** macOS only, from the pressure reader; null elsewhere or before its first report. */
  readonly memoryPressure: MachineMemoryPressure | null;
  readonly gpus?: ReadonlyArray<HostGpuTotals>;
}

export type CpuCounters = ReadonlyArray<{ readonly idle: number; readonly total: number }>;

export interface DarwinPressureSample {
  readonly pressure: MachineMemoryPressure;
  readonly swapTotalBytes: number;
  readonly swapUsedBytes: number;
  readonly availableMemoryBytes: number | null;
}

export interface DarwinPressureReader {
  readonly latest: () => DarwinPressureSample | null;
  readonly pid: () => number | undefined;
  /** Closes our end of the pipe only; the loop's next write fails and it exits on its own. */
  readonly closeReader: () => void;
  readonly stop: () => void;
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

export function parseVmStatAvailableBytes(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output)?.[1];
  const free = /^Pages free:\s+(\d+)\./m.exec(output)?.[1];
  const inactive = /^Pages inactive:\s+(\d+)\./m.exec(output)?.[1];
  const speculative = /^Pages speculative:\s+(\d+)\./m.exec(output)?.[1];
  if (!pageSize || !free || !inactive || !speculative) return null;
  // vm_stat excludes speculative from free; add it once, without overlapping purgeable pages.
  const available = (Number(free) + Number(inactive) + Number(speculative)) * Number(pageSize);
  return Number.isSafeInteger(available) && Number(pageSize) > 0 ? available : null;
}

const SWAP_UNIT_BYTES: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

function parseSwapSize(value: string, unit: string): number {
  return Math.round(Number(value) * (SWAP_UNIT_BYTES[unit] ?? 1));
}

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
function memoryPressureFromLevel(level: number): MachineMemoryPressure | null {
  if (level === 1) return "normal";
  if (level === 2) return "warn";
  if (level === 4) return "critical";
  return null;
}

/** One block of the pressure loop: the two `sysctl -n` lines, then `vm_stat`. */
export function parseDarwinPressureBlock(block: string): DarwinPressureSample | null {
  const [levelLine = "", swapLine = ""] = block.trimStart().split("\n", 2);
  const pressure = memoryPressureFromLevel(Number(levelLine.trim()));
  const swap = /total = ([\d.]+)([KMG])\s+used = ([\d.]+)([KMG])/.exec(swapLine);
  if (pressure === null || swap === null) return null;
  return {
    pressure,
    swapTotalBytes: parseSwapSize(swap[1]!, swap[2]!),
    swapUsedBytes: parseSwapSize(swap[3]!, swap[4]!),
    availableMemoryBytes: parseVmStatAvailableBytes(block),
  };
}

const DARWIN_BLOCK_END = "===";

// The one always-on child (docs/internals/resource-telemetry.md). It exits when its parent dies
// or a write to the pipe fails, so a crashed or closed server never leaves it running.
export const DARWIN_PRESSURE_LOOP = `while kill -0 $PPID 2>/dev/null; do { sysctl -n kern.memorystatus_vm_pressure_level vm.swapusage && vm_stat && echo ${DARWIN_BLOCK_END}; } || exit 0; sleep 5; done`;

const DARWIN_RESTART_DELAY_MS = 30_000;
// A loop that dies this soon after spawning (e.g. sysctl missing) will not recover by retrying.
const DARWIN_EARLY_EXIT_MS = 5_000;
const DARWIN_MAX_EARLY_EXITS = 3;

export function startDarwinPressureReader(
  options: { readonly shell?: string; readonly script?: string } = {},
): DarwinPressureReader {
  let latest: DarwinPressureSample | null = null;
  let stopped = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let child: ReturnType<typeof NodeChildProcess.spawn> | undefined;
  let earlyExits = 0;

  const start = () => {
    let buffered = "";
    const startedAt = Date.now();
    const current = NodeChildProcess.spawn(
      options.shell ?? "/bin/sh",
      ["-c", options.script ?? DARWIN_PRESSURE_LOOP],
      {
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    child = current;
    current.stdout?.setEncoding("utf8");
    current.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      let end = buffered.indexOf(`\n${DARWIN_BLOCK_END}\n`);
      while (end !== -1) {
        latest = parseDarwinPressureBlock(buffered.slice(0, end)) ?? latest;
        buffered = buffered.slice(end + DARWIN_BLOCK_END.length + 2);
        end = buffered.indexOf(`\n${DARWIN_BLOCK_END}\n`);
      }
    });
    current.on("error", () => {});
    current.on("exit", () => {
      if (child === current) child = undefined;
      if (stopped) return;
      earlyExits = Date.now() - startedAt < DARWIN_EARLY_EXIT_MS ? earlyExits + 1 : 0;
      if (earlyExits >= DARWIN_MAX_EARLY_EXITS) {
        // No pressure from here on, so the verdict falls back to the load rule alone.
        latest = null;
        return;
      }
      restartTimer = setTimeout(start, DARWIN_RESTART_DELAY_MS);
      restartTimer.unref?.();
    });
  };
  start();

  const closeReader = () => {
    stopped = true;
    if (restartTimer !== undefined) clearTimeout(restartTimer);
    child?.stdout?.destroy();
  };

  return {
    latest: () => latest,
    pid: () => child?.pid,
    closeReader,
    stop: () => {
      // The pipe close alone ends the loop; the signal just ends it sooner.
      closeReader();
      child?.kill("SIGTERM");
      child = undefined;
    },
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
    readonly darwin?: DarwinPressureReader | undefined;
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
    const darwin = options.darwin?.latest() ?? null;
    if (darwin !== null) {
      memoryAvailableBytes = darwin.availableMemoryBytes ?? memoryAvailableBytes;
      swapTotalBytes = darwin.swapTotalBytes;
      swapUsedBytes = darwin.swapUsedBytes;
      memoryPressure = darwin.pressure;
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
