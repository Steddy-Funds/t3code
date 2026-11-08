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
for the hold time, it sends SIGTERM to the command's process group, SIGKILL 10 s later if it
is still running, and exits 75 with one line on stderr naming the reason.

While load management is off, the command runs unguarded.

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

function signalChildTree(input: {
  readonly platform: NodeJS.Platform;
  readonly pid: number;
  readonly grouped: boolean;
  readonly signal: "SIGTERM" | "SIGKILL" | "SIGINT";
}): void {
  const { pid, signal } = input;
  try {
    if (input.platform === "win32") {
      // taskkill /T walks the tree; without /F it asks politely, as SIGTERM does.
      NodeChildProcess.spawnSync(
        "taskkill",
        ["/T", ...(signal === "SIGKILL" ? ["/F"] : []), "/PID", String(pid)],
        { stdio: "ignore", windowsHide: true },
      );
      return;
    }
    // Negative pid: the child's own process group, which `detached` created.
    process.kill(input.grouped ? -pid : pid, signal);
  } catch {
    // The group is already gone.
  }
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

export async function runGuard(input: {
  readonly argv: ReadonlyArray<string>;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
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
  const config = parseGuardConfig(readConfigFile(input.env.T3CODE_GUARD_CONFIG));
  // Its own process group, so a kill reaches everything it started and never the guard.
  const grouped = config !== null && input.platform !== "win32";

  const child = NodeChildProcess.spawn(parsed.command, [...parsed.args], {
    stdio: "inherit",
    detached: grouped,
    windowsHide: true,
  });
  let exited = false;
  const signalChild = (signal: "SIGTERM" | "SIGKILL" | "SIGINT") => {
    const target = { pid: child.pid, exited, selfPid: process.pid };
    if (canSignalChild(target)) {
      signalChildTree({ platform: input.platform, pid: target.pid, grouped, signal });
    }
  };

  const onInt = () => signalChild("SIGINT");
  const onTerm = () => signalChild("SIGTERM");
  // A terminal's Ctrl-C already reaches an ungrouped child; forwarding it would send two.
  if (grouped) process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);

  let state = initialGuardState(Date.now());
  let counters: CpuCounters | null = null;
  let sampling = false;
  const timer =
    config === null
      ? undefined
      : setInterval(() => {
          if (sampling) return;
          sampling = true;
          void readHostTotals(counters, { platform: input.platform })
            .then(
              ({ totals, next }) => {
                counters = next;
                return totals;
              },
              () => null,
            )
            .then((totals) => {
              sampling = false;
              if (exited) return;
              const step = stepGuard(state, {
                totals,
                thresholds: config.thresholds,
                holdMs: parsed.holdMs ?? config.holdMs,
                now: Date.now(),
              });
              state = step.state;
              if (step.action === "terminate") signalChild("SIGTERM");
              if (step.action === "kill") signalChild("SIGKILL");
            });
        }, GUARD_SAMPLE_INTERVAL_MS);

  return new Promise<number>((resolve) => {
    const finish = (code: number) => {
      if (exited) return;
      exited = true;
      if (timer !== undefined) clearInterval(timer);
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      const { phase } = state;
      if (phase.type === "terminating" || phase.type === "killed") {
        process.stderr.write(`${formatKillReason(phase.reason)}\n`);
        resolve(GUARD_EXIT_KILLED);
        return;
      }
      resolve(code);
    };
    child.once("error", (error) => {
      process.stderr.write(`t3 guard: could not run ${parsed.command}: ${error.message}\n`);
      finish(127);
    });
    child.once("exit", (code, signal) => finish(exitCodeOf(code, signal)));
  });
}
