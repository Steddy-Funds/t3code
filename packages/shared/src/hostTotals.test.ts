// @effect-diagnostics nodeBuiltinImport:off - drives real `sh` children for the pressure reader.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import * as HostProcess from "./HostProcess.ts";
import {
  DARWIN_PRESSURE_LOOP,
  cpuDeltas,
  parseDarwinPressureBlock,
  parseProcMeminfo,
  parseVmStatAvailableBytes,
  startDarwinPressureReader,
} from "./hostTotals.ts";

vi.mock("node:child_process", { spy: true });

const KiB = 1024;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const VM_STAT = [
  "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
  "Pages free:                               1000.",
  "Pages active:                             5000.",
  "Pages inactive:                           2000.",
  "Pages speculative:                         300.",
  "Pages purgeable:                           900.",
].join("\n");
const VM_STAT_AVAILABLE = (1000 + 2000 + 300) * 16384;

const block = (level: string, swap: string) =>
  `${level}\ntotal = ${swap}  used = 512.00M  free = 1536.00M  (encrypted)\n${VM_STAT}`;

describe("parseProcMeminfo", () => {
  it("reads total, available and swap in bytes", () => {
    const text = [
      "MemTotal:       16000000 kB",
      "MemFree:         1000000 kB",
      "MemAvailable:    8000000 kB",
      "SwapTotal:       2000000 kB",
      "SwapFree:         500000 kB",
    ].join("\n");
    expect(parseProcMeminfo(text)).toEqual({
      memoryTotalBytes: 16_000_000 * KiB,
      memoryAvailableBytes: 8_000_000 * KiB,
      swapTotalBytes: 2_000_000 * KiB,
      swapUsedBytes: 1_500_000 * KiB,
    });
  });

  it.each([
    ["no swap lines", "MemTotal: 100 kB\nMemAvailable: 50 kB", 0, 0],
    ["SwapTotal without SwapFree", "MemTotal: 100 kB\nSwapTotal: 40 kB", 40 * KiB, 0],
    ["SwapFree above SwapTotal", "SwapTotal: 40 kB\nSwapFree: 90 kB", 40 * KiB, 0],
  ])("reports swap with %s", (_name, text, swapTotalBytes, swapUsedBytes) => {
    expect(parseProcMeminfo(text)).toMatchObject({ swapTotalBytes, swapUsedBytes });
  });

  it("leaves a missing MemAvailable null instead of guessing", () => {
    expect(parseProcMeminfo("MemTotal: 100 kB")).toMatchObject({
      memoryTotalBytes: 100 * KiB,
      memoryAvailableBytes: null,
    });
  });
});

describe("parseVmStatAvailableBytes", () => {
  it("adds free, inactive and speculative pages once", () => {
    expect(parseVmStatAvailableBytes(VM_STAT)).toBe(VM_STAT_AVAILABLE);
  });

  it.each([
    "Mach Virtual Memory Statistics: (page size of",
    "Pages free:",
    "Pages inactive:",
    "Pages speculative:",
  ])("is null without the %s line", (prefix) => {
    const output = VM_STAT.split("\n")
      .filter((line) => !line.startsWith(prefix))
      .join("\n");
    expect(parseVmStatAvailableBytes(output)).toBeNull();
  });

  it("is null for a zero page size", () => {
    expect(parseVmStatAvailableBytes(VM_STAT.replace("16384", "0"))).toBeNull();
  });
});

describe("parseDarwinPressureBlock", () => {
  it.each([
    ["1", "2048.00K", "normal", 2048 * KiB],
    ["2", "2048.00M", "warn", 2048 * MiB],
    ["4", "1.50G", "critical", 1.5 * GiB],
  ] as const)("reads level %s with swap in %s", (level, swap, pressure, swapTotalBytes) => {
    expect(parseDarwinPressureBlock(block(level, swap))).toEqual({
      pressure,
      swapTotalBytes,
      swapUsedBytes: 512 * MiB,
      availableMemoryBytes: VM_STAT_AVAILABLE,
    });
  });

  it("skips the newline left over from the previous block", () => {
    expect(parseDarwinPressureBlock(`\n  ${block("4", "1.00G")}`)?.pressure).toBe("critical");
  });

  it.each([
    ["an unknown level", block("3", "1.00G")],
    ["a non-numeric level", block("high", "1.00G")],
    ["no swap line", "4"],
    ["an empty block", ""],
  ])("is null with %s", (_name, text) => {
    expect(parseDarwinPressureBlock(text)).toBeNull();
  });

  it("keeps the pressure when vm_stat output is missing", () => {
    const withoutVmStat = block("2", "1.00G").split("\n").slice(0, 2).join("\n");
    expect(parseDarwinPressureBlock(withoutVmStat)).toEqual({
      pressure: "warn",
      swapTotalBytes: GiB,
      swapUsedBytes: 512 * MiB,
      availableMemoryBytes: null,
    });
  });
});

describe("cpuDeltas", () => {
  const counters = (...cores: Array<[idle: number, total: number]>) =>
    cores.map(([idle, total]) => ({ idle, total }));

  it("splits busy time overall and per core", () => {
    expect(cpuDeltas(counters([0, 0], [0, 0]), counters([75, 100], [0, 100]))).toEqual({
      cpuUtilization: 0.625,
      perCore: [25, 100],
    });
  });

  it.each([
    ["no previous read", null],
    ["a changed core count", counters([0, 0])],
  ])("has no utilization with %s", (_name, previous) => {
    expect(cpuDeltas(previous, counters([10, 100], [10, 100]))).toEqual({
      cpuUtilization: null,
      perCore: [],
    });
  });

  it("reads a core with no elapsed time as idle and the whole as unknown", () => {
    const same = counters([10, 100], [10, 100]);
    expect(cpuDeltas(same, same)).toEqual({ cpuUtilization: null, perCore: [0, 0] });
  });

  it("treats counters that went backwards as unknown", () => {
    expect(cpuDeltas(counters([50, 100]), counters([40, 200]))).toEqual({
      cpuUtilization: null,
      perCore: [0],
    });
  });
});

type Child = NodeChildProcess.ChildProcess;

const onceEvent = (emitter: NodeJS.EventEmitter, event: string) =>
  new Promise<void>((resolve) => {
    emitter.once(event, () => resolve());
  });

const spawned = () =>
  vi.mocked(NodeChildProcess.spawn).mock.results.map((result) => result.value as Child);

const exited = (child: Child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : onceEvent(child, "exit");

// Resolves on the data event that makes the stream's output so far satisfy `done`.
function readUntil(stream: NodeJS.ReadableStream, done: (output: string) => boolean) {
  return new Promise<string>((resolve) => {
    let output = "";
    const onData = (chunk: Buffer | string) => {
      output += String(chunk);
      if (!done(output)) return;
      stream.off("data", onData);
      resolve(output);
    };
    stream.on("data", onData);
  });
}

const quote = (text: string) => `'${text}'`;

// The real loop with the macOS commands swapped for an echo and a short sleep, so it runs here.
const portableLoop = (body: string) => {
  const loop = DARWIN_PRESSURE_LOOP.replace(/\{ .* \}/, `{ ${body}; }`).replace(
    "sleep 5",
    "sleep 0.05",
  );
  expect(loop).not.toContain("sysctl");
  expect(loop).toContain("sleep 0.05");
  expect(loop).not.toContain("'");
  return loop;
};

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "startDarwinPressureReader",
  () => {
    it("parses a block whose terminator spans two chunks", async () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pressure-"));
      const fifo = NodePath.join(dir, "gate");
      NodeChildProcess.execFileSync("mkfifo", [fifo]);
      const first = `${block("4", "1.00G")}\n=`;
      const reader = startDarwinPressureReader({
        script: `printf %s ${quote(first)}; read _ < ${fifo}; printf "==\\n"; read _ < ${fifo}`,
      });
      const child = spawned().at(-1)!;
      try {
        await readUntil(child.stdout!, (output) => output === first);
        expect(reader.latest()).toBeNull();
        const rest = readUntil(child.stdout!, (output) => output === "==\n");
        await NodeFS.promises.writeFile(fifo, "\n");
        await rest;
        expect(reader.latest()).toMatchObject({ pressure: "critical", swapTotalBytes: GiB });
        await NodeFS.promises.writeFile(fifo, "\n");
      } finally {
        reader.stop();
        await exited(child);
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps the newest of several blocks and ignores an unparseable one", async () => {
      const text = [block("2", "1.00G"), block("4", "2.00G"), block("9", "3.00G")]
        .map((part) => `${part}\n===\n`)
        .join("");
      const reader = startDarwinPressureReader({ script: `printf %s ${quote(text)}` });
      const child = spawned().at(-1)!;
      try {
        await readUntil(child.stdout!, (output) => output === text);
        expect(reader.latest()).toMatchObject({ pressure: "critical", swapTotalBytes: 2 * GiB });
      } finally {
        reader.stop();
        await exited(child);
      }
    });

    it("ends the loop by closing the pipe alone, with no signal and no restart", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const before = spawned().length;
      const reader = startDarwinPressureReader({ script: portableLoop("echo tick") });
      const child = spawned().at(-1)!;
      const kill = vi.spyOn(child, "kill");
      try {
        await readUntil(child.stdout!, (output) => output.includes("tick"));
        expect(reader.pid()).toBe(child.pid);
        reader.closeReader();
        await exited(child);
        expect(kill).not.toHaveBeenCalled();
        // A failed write ends the loop via `|| exit 0` or SIGPIPE, depending on the shell.
        expect(child.exitCode === 0 || child.signalCode === "SIGPIPE").toBe(true);
        expect(reader.pid()).toBeUndefined();
        vi.advanceTimersByTime(60_000);
        expect(spawned().length).toBe(before + 1);
      } finally {
        reader.stop();
        vi.useRealTimers();
      }
    });

    it("restarts a loop that exits on its own after 30 s, until stopped", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const before = spawned().length;
      const reader = startDarwinPressureReader({ script: "exit 0" });
      try {
        await exited(spawned().at(-1)!);
        expect(reader.pid()).toBeUndefined();
        vi.advanceTimersByTime(29_999);
        expect(spawned().length).toBe(before + 1);
        vi.advanceTimersByTime(1);
        expect(spawned().length).toBe(before + 2);
      } finally {
        reader.stop();
        await exited(spawned().at(-1)!);
        vi.advanceTimersByTime(60_000);
        expect(spawned().length).toBe(before + 2);
        vi.useRealTimers();
      }
    });

    it("stop ends a running loop and clears pid", async () => {
      const reader = startDarwinPressureReader({ script: portableLoop("echo tick") });
      const child = spawned().at(-1)!;
      await readUntil(child.stdout!, (output) => output.includes("tick"));
      reader.stop();
      expect(reader.pid()).toBeUndefined();
      await exited(child);
    });

    it("exits the loop once its parent shell has exited", async () => {
      // The parent waits for a line on stdin, so it outlives the loop's start and `$PPID` names it.
      const parent = NodeChildProcess.spawn(
        "/bin/sh",
        ["-c", `/bin/sh -c ${quote(portableLoop("echo tick"))} & echo "pid:$!"; read _`],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      let output = "";
      let ended = false;
      const loopDone = onceEvent(parent.stdout, "end").then(() => {
        ended = true;
      });
      try {
        output = await readUntil(parent.stdout, (text) => text.includes("tick"));
        parent.stdout.resume();
        parent.stdin.end("\n");
        await exited(parent);
        // The orphaned loop holds the pipe open; the pipe's end means the loop exited.
        await loopDone;
        expect(output).toMatch(/pid:\d+/);
      } finally {
        const loopPid = Number(/pid:(\d+)/.exec(output)?.[1]);
        if (!ended && Number.isInteger(loopPid) && loopPid > 0) {
          try {
            process.kill(loopPid);
          } catch {}
        }
      }
    });
  },
);
