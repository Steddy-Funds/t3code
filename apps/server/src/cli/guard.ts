// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Plain Node so the bundle stays self-contained for pods.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import type { MachineThresholds, MachineVerdictReason } from "@t3tools/contracts";
import { readHostTotals, type CpuCounters, type HostTotals } from "@t3tools/shared/hostTotals";
import { initialVerdictState, stepVerdict, type VerdictState } from "@t3tools/shared/nodeVerdict";

export const GUARD_EXIT_KILLED = 75;
export const GUARD_SAMPLE_INTERVAL_MS = 5_000;
export const GUARD_KILL_GRACE_MS = 10_000;

export const GUARD_HELP = `Usage: t3 guard [--hold <duration>] -- <command> [args...]

Runs <command> and stops it when this machine stays stressed, so a heavy build or test
cannot take the machine down. Every 5 s it checks CPU load and RAM (not GPUs) against the
machine's load thresholds in T3 Code's settings. When the machine has been stressed
for the hold time, it sends SIGTERM to the command and everything it started, SIGKILL 10 s
later to whatever is still running, and exits 75 with one line on stderr naming the reason.

While load management is off, the command runs unguarded; turning it off mid-run stops the
watching.

  --hold <duration>  How long the machine must stay stressed before the kill, such as 90s
                     or 2m. Defaults to the hold set in Settings.

Guarding \`docker exec\` stops only the exec client, not the process in the container; run
the guard inside the container instead.
`;

export interface GuardConfig {
  readonly holdMs: number;
  readonly thresholds: MachineThresholds;
}

const THRESHOLD_KEYS = [
  "loadPerCore",
  "memoryUsedPercent",
  "windowsCpuPercent",
  "windowsCpuHoldMs",
  "enterHoldMs",
  "exitHoldMs",
  "exitFactor",
  "gpuVramUsedPercent",
  "gpuUtilPercent",
  "gpuUtilHoldMs",
] as const satisfies ReadonlyArray<keyof MachineThresholds>;

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Null means unguarded: the lane is off, or the file is missing, unreadable or malformed. The
 * server writes it resolved and complete, so a broken file never kills a command.
 */
export function parseGuardConfig(text: string | undefined): GuardConfig | null {
  if (text === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { enabled, guardHoldSeconds, thresholds } = raw as Record<string, unknown>;
  if (enabled !== true || !isNonNegativeNumber(guardHoldSeconds)) return null;
  if (typeof thresholds !== "object" || thresholds === null) return null;
  const values = thresholds as Record<string, unknown>;
  if (!THRESHOLD_KEYS.every((key) => isNonNegativeNumber(values[key]))) return null;
  return {
    holdMs: guardHoldSeconds * 1000,
    thresholds: Object.fromEntries(
      THRESHOLD_KEYS.map((key) => [key, values[key]]),
    ) as unknown as MachineThresholds,
  };
}

/** `90`, `90s` or `2m`; null when it is not one of those. */
export function parseHoldDuration(value: string): number | null {
  const match = /^(\d+)(s|m)?$/.exec(value.trim());
  if (match === null) return null;
  return Number(match[1]) * (match[2] === "m" ? 60_000 : 1000);
}

export type GuardArgs =
  | { readonly type: "help" }
  | { readonly type: "error"; readonly message: string }
  | {
      readonly type: "run";
      readonly holdMs: number | null;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };

export function parseGuardArgs(argv: ReadonlyArray<string>): GuardArgs {
  let holdMs: number | null = null;
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === "--") {
      index += 1;
      break;
    }
    if (arg === "-h" || arg === "--help") return { type: "help" };
    const holdValue = arg === "--hold" ? argv[index + 1] : /^--hold=(.*)$/.exec(arg)?.[1];
    if (holdValue === undefined) {
      if (arg.startsWith("-")) return { type: "error", message: `Unknown option ${arg}.` };
      break;
    }
    holdMs = parseHoldDuration(holdValue);
    if (holdMs === null) return { type: "error", message: `Invalid --hold ${holdValue}.` };
    index += arg === "--hold" ? 2 : 1;
  }
  const [command, ...args] = argv.slice(index);
  if (command === undefined) return { type: "error", message: "Missing the command to run." };
  return { type: "run", holdMs, command, args };
}

export type GuardPhase =
  | { readonly type: "watching"; readonly stressedSince: number | null }
  | {
      readonly type: "terminating";
      readonly since: number;
      readonly reason: MachineVerdictReason;
    }
  | { readonly type: "killed"; readonly reason: MachineVerdictReason };

export interface GuardState {
  readonly verdict: VerdictState;
  readonly phase: GuardPhase;
}

export type GuardAction = "none" | "terminate" | "kill";

export const initialGuardState = (now: number): GuardState => ({
  verdict: initialVerdictState(now),
  phase: { type: "watching", stressedSince: null },
});

/**
 * One 5 s tick: SIGTERM once the verdict has stayed stressed for `holdMs`, then SIGKILL once
 * the grace has passed. The caller sends KILL only if the child has not exited by then.
 */
export function stepGuard(
  state: GuardState,
  input: {
    readonly totals: HostTotals | null;
    readonly thresholds: MachineThresholds;
    readonly holdMs: number;
    readonly now: number;
  },
): { readonly state: GuardState; readonly action: GuardAction } {
  const { phase } = state;
  if (phase.type === "killed") return { state, action: "none" };
  if (phase.type === "terminating") {
    if (input.now - phase.since < GUARD_KILL_GRACE_MS) return { state, action: "none" };
    return { state: { ...state, phase: { type: "killed", reason: phase.reason } }, action: "kill" };
  }
  const verdict = stepVerdict(state.verdict, input.totals, input.thresholds, input.now);
  if (verdict.verdict !== "stressed" || verdict.reason === null) {
    return { state: { verdict, phase: { type: "watching", stressedSince: null } }, action: "none" };
  }
  const stressedSince = phase.stressedSince ?? input.now;
  if (input.now - stressedSince < input.holdMs) {
    return { state: { verdict, phase: { type: "watching", stressedSince } }, action: "none" };
  }
  return {
    state: {
      verdict,
      phase: {
        type: "terminating",
        since: input.now,
        reason: { ...verdict.reason, heldForMs: input.now - stressedSince },
      },
    },
    action: "terminate",
  };
}

const RULE_UNITS: Record<MachineVerdictReason["rule"], string> = {
  load: " load per core",
  memory: "% memory used",
  memoryPressure: " memory pressure level",
  cpu: "% CPU",
  gpuVram: "% VRAM used",
  gpuUtil: "% GPU",
};

export function formatKillReason(reason: MachineVerdictReason): string {
  const unit = RULE_UNITS[reason.rule];
  const round = (value: number) => Number(value.toPrecision(3));
  return (
    `t3 guard: stopped the command because the machine stayed stressed ` +
    `(rule ${reason.rule}: ${round(reason.value)}${unit}, threshold ${round(reason.threshold)}${unit}, ` +
    `held ${Math.round(reason.heldForMs / 1000)} s).`
  );
}

/**
 * The guard is the child's parent, so the child's pid cannot be reused until Node reaps it,
 * which is when `exit` fires. Signal only before that, and never this process or init.
 */
export function canSignalChild(input: {
  readonly pid: number | undefined;
  readonly exited: boolean;
  readonly selfPid: number;
}): input is { readonly pid: number; readonly exited: false; readonly selfPid: number } {
  return !input.exited && input.pid !== undefined && input.pid > 1 && input.pid !== input.selfPid;
}

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  /** Opaque start time, compared for equality so a reused pid is never signalled. */
  readonly start: string;
}

/** `/proc/<pid>/stat`; the command name can hold spaces and parentheses, so split after the last `)`. */
export function parseProcStat(pid: number, text: string): ProcessEntry | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  // Field 22, starttime, counted from field 3 (state).
  const start = fields[19];
  if (!Number.isInteger(ppid) || start === undefined || start === "") return null;
  return { pid, ppid, start };
}

/** `ps -Ao pid=,ppid=,lstart=` output. */
export function parsePsTable(text: string): Array<ProcessEntry> {
  return text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    return match === null
      ? []
      : [{ pid: Number(match[1]), ppid: Number(match[2]), start: match[3]! }];
  });
}

/** The roots and every process below them by ppid, each once. */
export function descendantsOf(
  roots: ReadonlyArray<ProcessEntry>,
  table: ReadonlyArray<ProcessEntry>,
): Array<ProcessEntry> {
  const children = new Map<number, Array<ProcessEntry>>();
  for (const entry of table) {
    if (entry.pid === entry.ppid) continue;
    children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry]);
  }
  const seen = new Set<number>();
  const result: Array<ProcessEntry> = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (seen.has(entry.pid)) continue;
    seen.add(entry.pid);
    result.push(entry);
    queue.push(...(children.get(entry.pid) ?? []));
  }
  return result;
}

/** pid 1 and below, this process and its ancestors: never signalled. */
export function protectedPids(selfPid: number, table: ReadonlyArray<ProcessEntry>): Set<number> {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const protectedSet = new Set<number>([selfPid]);
  let current = byPid.get(selfPid);
  while (current !== undefined && current.ppid > 1 && !protectedSet.has(current.ppid)) {
    protectedSet.add(current.ppid);
    current = byPid.get(current.ppid);
  }
  return protectedSet;
}

function readProcessTable(platform: NodeJS.Platform): Array<ProcessEntry> {
  if (platform === "linux") {
    let names: Array<string>;
    try {
      names = NodeFS.readdirSync("/proc");
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      if (!/^\d+$/.test(name)) return [];
      const entry = readProcEntry(Number(name));
      return entry === null ? [] : [entry];
    });
  }
  const result = NodeChildProcess.spawnSync("ps", ["-Ao", "pid=,ppid=,lstart="], {
    encoding: "utf8",
  });
  return result.status === 0 ? parsePsTable(result.stdout) : [];
}

function readProcEntry(pid: number): ProcessEntry | null {
  try {
    return parseProcStat(pid, NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

function readStart(platform: NodeJS.Platform, pid: number): string | null {
  if (platform === "linux") return readProcEntry(pid)?.start ?? null;
  const result = NodeChildProcess.spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

const readConfigFile = (path: string | undefined): string | undefined => {
  if (path === undefined || path === "") return undefined;
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const exitCodeOf = (code: number | null, signal: NodeJS.Signals | null): number => {
  if (code !== null) return code;
  const number = signal === null ? undefined : NodeOS.constants.signals[signal];
  return number === undefined ? 1 : 128 + number;
};

type SpawnCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions,
) => NodeChildProcess.ChildProcess;

export async function runGuard(input: {
  readonly argv: ReadonlyArray<string>;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  /** Tests observe the child through this; the CLI uses Node's spawn. */
  readonly spawn?: SpawnCommand;
}): Promise<number> {
  const parsed = parseGuardArgs(input.argv);
  if (parsed.type === "help") {
    process.stdout.write(GUARD_HELP);
    return 0;
  }
  if (parsed.type === "error") {
    process.stderr.write(`t3 guard: ${parsed.message}\n\n${GUARD_HELP}`);
    return 2;
  }
  const configPath = input.env.T3CODE_GUARD_CONFIG;
  const initialConfig = parseGuardConfig(readConfigFile(configPath));
  const { platform } = input;
  const selfPid = process.pid;

  // Not detached: the command stays in the guard's process group, so a kill aimed at that group
  // (a provider stopping its command, a thread interrupt) reaches both, and a terminal leaves
  // it in the foreground.
  const spawn: SpawnCommand = input.spawn ?? NodeChildProcess.spawn;
  const child = spawn(parsed.command, [...parsed.args], {
    stdio: "inherit",
    windowsHide: true,
  });
  let resolved = false;
  let leaderExited = false;
  /** Every process the guard has signalled, with its start time. */
  let recorded: Array<ProcessEntry> = [];

  const isAlive = (entry: ProcessEntry) => readStart(platform, entry.pid) === entry.start;

  const signalTree = (signal: "SIGTERM" | "SIGKILL") => {
    if (platform === "win32") {
      if (!canSignalChild({ pid: child.pid, exited: leaderExited, selfPid })) return;
      // taskkill /T walks the tree; without /F it asks politely, as SIGTERM does.
      NodeChildProcess.spawnSync(
        "taskkill",
        ["/T", ...(signal === "SIGKILL" ? ["/F"] : []), "/PID", String(child.pid)],
        { stdio: "ignore", windowsHide: true },
      );
      return;
    }
    const table = readProcessTable(platform);
    const byPid = new Map(table.map((entry) => [entry.pid, entry]));
    const leader = leaderExited || child.pid === undefined ? undefined : byPid.get(child.pid);
    // Earlier targets whose start still matches: a straggler orphaned by its exited parent.
    const roots = [...(leader === undefined ? [] : [leader]), ...recorded].filter(
      (entry) => byPid.get(entry.pid)?.start === entry.start,
    );
    const blocked = protectedPids(selfPid, table);
    const targets = descendantsOf(roots, table).filter(
      (entry) => entry.pid > 1 && !blocked.has(entry.pid),
    );
    const known = new Set(recorded.map((entry) => `${entry.pid}:${entry.start}`));
    recorded = [
      ...recorded,
      ...targets.filter((entry) => !known.has(`${entry.pid}:${entry.start}`)),
    ];
    for (const entry of targets) {
      if (!isAlive(entry)) continue;
      try {
        process.kill(entry.pid, signal);
      } catch {
        // Exited since the recheck.
      }
    }
  };

  // An outside SIGTERM to the guard alone goes to the command, which decides what to do.
  const onTerm = () => {
    const target = { pid: child.pid, exited: leaderExited, selfPid };
    if (!canSignalChild(target)) return;
    try {
      if (platform === "win32") {
        NodeChildProcess.spawnSync("taskkill", ["/T", "/PID", String(target.pid)], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        process.kill(target.pid, "SIGTERM");
      }
    } catch {}
  };
  process.on("SIGTERM", onTerm);

  let resolveResult!: (code: number) => void;
  const result = new Promise<number>((resolve) => {
    resolveResult = resolve;
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let state = initialGuardState(Date.now());

  const finish = (code: number) => {
    if (resolved) return;
    resolved = true;
    if (timer !== undefined) clearInterval(timer);
    process.off("SIGTERM", onTerm);
    const { phase } = state;
    if (phase.type === "terminating" || phase.type === "killed") {
      process.stderr.write(`${formatKillReason(phase.reason)}\n`);
      resolveResult(GUARD_EXIT_KILLED);
      return;
    }
    resolveResult(code);
  };

  if (initialConfig !== null) {
    let config = initialConfig;
    let counters: CpuCounters | null = null;
    let sampling = false;
    const step = (totals: HostTotals | null) => {
      const next = stepGuard(state, {
        totals,
        thresholds: config.thresholds,
        holdMs: parsed.holdMs ?? config.holdMs,
        now: Date.now(),
      });
      state = next.state;
      if (next.action === "terminate") signalTree("SIGTERM");
      if (next.action === "kill") signalTree("SIGKILL");
      // The command exited on SIGTERM; finish once its stragglers are gone or killed.
      if (leaderExited && (next.action === "kill" || !recorded.some(isAlive))) finish(0);
    };
    timer = setInterval(() => {
      if (sampling || resolved) return;
      if (state.phase.type !== "watching") {
        step(null);
        return;
      }
      const latest = parseGuardConfig(readConfigFile(configPath));
      if (latest === null) {
        // Load management was turned off: stop watching and just wait for the command.
        clearInterval(timer);
        timer = undefined;
        return;
      }
      config = latest;
      sampling = true;
      void readHostTotals(counters, { platform })
        .then(
          ({ totals, next }) => {
            counters = next;
            return totals;
          },
          () => null,
        )
        .then((totals) => {
          sampling = false;
          if (resolved || leaderExited) return;
          step(totals);
        });
    }, GUARD_SAMPLE_INTERVAL_MS);
  }

  child.once("error", (error) => {
    leaderExited = true;
    process.stderr.write(`t3 guard: could not run ${parsed.command}: ${error.message}\n`);
    finish(127);
  });
  child.once("exit", (code, signal) => {
    leaderExited = true;
    // Descendants that ignored SIGTERM still get the SIGKILL after the grace.
    if (state.phase.type === "terminating" && recorded.some(isAlive)) return;
    finish(exitCodeOf(code, signal));
  });
  return result;
}
