// @effect-diagnostics nodeBuiltinImport:off -- runGuard drives a real child process through a FIFO handshake.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  DEFAULT_MACHINE_THRESHOLDS,
  type MachineThresholds,
  type MachineVerdictReason,
} from "@t3tools/contracts";
import { readHostTotals, type HostTotals } from "@t3tools/shared/hostTotals";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  GUARD_EXIT_KILLED,
  GUARD_KILL_GRACE_MS,
  GUARD_SAMPLE_INTERVAL_MS,
  canSignalChild,
  formatKillReason,
  initialGuardState,
  parseGuardArgs,
  parseGuardConfig,
  runGuard,
  stepGuard,
  type GuardAction,
  type GuardState,
} from "./guard.ts";

vi.mock("@t3tools/shared/hostTotals", () => ({ readHostTotals: vi.fn() }));

// One core, so load.five reads directly as load per core.
const totals = (five: number): HostTotals => ({
  platform: "linux",
  sampledAt: 0,
  cpuCount: 1,
  cpuUtilization: 0.1,
  perCore: [10],
  load: { one: five, five, fifteen: five },
  memoryTotalBytes: 1000,
  memoryAvailableBytes: 900,
  swapTotalBytes: 0,
  swapUsedBytes: 0,
  memoryPressure: null,
});
const STRESSED = totals(2);
const CALM = totals(0.1);

const thresholds = (overrides: Partial<MachineThresholds> = {}): MachineThresholds => ({
  ...DEFAULT_MACHINE_THRESHOLDS,
  loadPerCore: 1,
  enterHoldMs: 0,
  exitHoldMs: 0,
  ...overrides,
});

function run(
  steps: ReadonlyArray<readonly [now: number, totals: HostTotals | null]>,
  options: { readonly holdMs: number; readonly thresholds?: MachineThresholds },
): { readonly actions: Array<GuardAction>; readonly states: Array<GuardState> } {
  const th = options.thresholds ?? thresholds();
  let state = initialGuardState(0);
  const actions: Array<GuardAction> = [];
  const states: Array<GuardState> = [];
  for (const [now, sample] of steps) {
    const step = stepGuard(state, { totals: sample, thresholds: th, holdMs: options.holdMs, now });
    state = step.state;
    actions.push(step.action);
    states.push(state);
  }
  return { actions, states };
}

describe("stepGuard", () => {
  it("terminates once stress holds for the hold, then kills once after the grace", () => {
    const { actions, states } = run(
      [
        [0, STRESSED],
        [5_000, STRESSED],
        [10_000, STRESSED],
        [15_000, STRESSED],
        [10_000 + GUARD_KILL_GRACE_MS - 1, STRESSED],
        [10_000 + GUARD_KILL_GRACE_MS, STRESSED],
        [30_000, STRESSED],
        [60_000, CALM],
      ],
      { holdMs: 10_000 },
    );
    expect(actions).toEqual(["none", "none", "terminate", "none", "none", "kill", "none", "none"]);
    expect(states[2]!.phase).toMatchObject({
      type: "terminating",
      since: 10_000,
      reason: { rule: "load", heldForMs: 10_000 },
    });
    expect(states[5]!.phase.type).toBe("killed");
    expect(states[7]!.phase.type).toBe("killed");
  });

  it("starts the hold over when the verdict clears before it, so a passing spike never kills", () => {
    const { actions, states } = run(
      [
        [0, STRESSED],
        [5_000, STRESSED],
        [10_000, CALM],
        [15_000, STRESSED],
        [20_000, STRESSED],
        [25_000, STRESSED],
      ],
      { holdMs: 10_000 },
    );
    expect(actions).toEqual(["none", "none", "none", "none", "none", "terminate"]);
    expect(states[2]!.phase).toEqual({ type: "watching", stressedSince: null });
    expect(states[5]!.phase).toMatchObject({ reason: { heldForMs: 10_000 } });
  });

  it("follows stepVerdict's hysteresis: stress inside the exit band holds, enterHoldMs delays", () => {
    // Below the threshold but above exitFactor × threshold: still stressed, the hold keeps counting.
    const banded = run(
      [
        [0, STRESSED],
        [5_000, totals(0.9)],
        [10_000, totals(0.9)],
      ],
      { holdMs: 10_000, thresholds: thresholds({ exitFactor: 0.85 }) },
    );
    expect(banded.actions).toEqual(["none", "none", "terminate"]);

    const entering = run(
      [
        [0, STRESSED],
        [5_000, STRESSED],
        [10_000, STRESSED],
      ],
      { holdMs: 0, thresholds: thresholds({ enterHoldMs: 10_000 }) },
    );
    expect(entering.actions).toEqual(["none", "none", "terminate"]);
  });

  it("never acts on a failed sample", () => {
    const { actions } = run(
      [
        [0, null],
        [5_000, null],
        [600_000, null],
      ],
      { holdMs: 0 },
    );
    expect(actions).toEqual(["none", "none", "none"]);
  });
});

describe("canSignalChild", () => {
  it.each([
    ["exited", { pid: 4242, exited: true, selfPid: 100 }, false],
    ["no pid", { pid: undefined, exited: false, selfPid: 100 }, false],
    ["pid 0", { pid: 0, exited: false, selfPid: 100 }, false],
    ["init", { pid: 1, exited: false, selfPid: 100 }, false],
    ["itself", { pid: 100, exited: false, selfPid: 100 }, false],
    ["its live child", { pid: 4242, exited: false, selfPid: 100 }, true],
  ] as const)("%s", (_name, input, expected) => {
    expect(canSignalChild(input)).toBe(expected);
  });
});

const guardJson = (overrides: Record<string, unknown> = {}, th: object = thresholds()) =>
  JSON.stringify({ enabled: true, guardHoldSeconds: 90, thresholds: th, ...overrides });

describe("parseGuardConfig", () => {
  const { loadPerCore: _dropped, ...missingKey } = thresholds();
  it.each([
    ["no file", undefined],
    ["not JSON", "{"],
    ["not an object", "[]"],
    ["null", "null"],
    ["lane off", guardJson({ enabled: false })],
    ["enabled not exactly true", guardJson({ enabled: "true" })],
    ["hold missing", guardJson({ guardHoldSeconds: undefined })],
    ["hold negative", guardJson({ guardHoldSeconds: -1 })],
    ["thresholds missing", guardJson({ thresholds: undefined })],
    ["a threshold missing", guardJson({}, missingKey)],
    ["a threshold negative", guardJson({}, { ...thresholds(), memoryUsedPercent: -5 })],
    ["a threshold not a number", guardJson({}, { ...thresholds(), exitFactor: "0.85" })],
  ])("runs unguarded on %s", (_name, text) => {
    expect(parseGuardConfig(text)).toBeNull();
  });

  it("reads an enabled file into the hold and all ten thresholds, dropping extra keys", () => {
    expect(
      parseGuardConfig(guardJson({}, { ...thresholds({ loadPerCore: 3 }), extra: 1 })),
    ).toEqual({ holdMs: 90_000, thresholds: thresholds({ loadPerCore: 3 }) });
  });
});

describe("parseGuardArgs", () => {
  it.each([
    [["--hold", "90s", "--", "make"], { holdMs: 90_000, command: "make", args: [] }],
    [["--hold=2m", "make", "-j8"], { holdMs: 120_000, command: "make", args: ["-j8"] }],
    [["--hold", "90", "make"], { holdMs: 90_000, command: "make", args: [] }],
    [["make", "--hold", "5"], { holdMs: null, command: "make", args: ["--hold", "5"] }],
    [["--", "-weird", "--help"], { holdMs: null, command: "-weird", args: ["--help"] }],
  ])("%j runs", (argv, expected) => {
    expect(parseGuardArgs(argv)).toEqual({ type: "run", ...expected });
  });

  it.each([
    [["--hold", "soon", "make"]],
    [["--hold"]],
    [["--hold=-5", "make"]],
    [["--frobnicate", "make"]],
    [[]],
    [["--hold", "90s", "--"]],
  ])("%j is an error", (argv) => {
    expect(parseGuardArgs(argv).type).toBe("error");
  });

  it.each([[["-h"]], [["--help", "make"]]])("%j is help", (argv) => {
    expect(parseGuardArgs(argv)).toEqual({ type: "help" });
  });
});

it("formatKillReason is one line naming the rule, value, threshold and held seconds", () => {
  const reason: MachineVerdictReason = {
    rule: "memory",
    value: 96.4,
    threshold: 92.5,
    heldForMs: 121_400,
  };
  const line = formatKillReason(reason);
  expect(line).not.toMatch(/[\r\n]/);
  for (const part of ["memory", "96.4", "92.5", "121"]) expect(line).toContain(part);
});

/**
 * The child writes its pid into a FIFO once it is ready (after any trap), so the test knows
 * the pid and never races the child's startup. `exec` keeps that pid for the sleep.
 */
async function withChild(
  script: string,
  config: string | null,
  body: (input: {
    readonly childPid: number;
    readonly result: Promise<number>;
    readonly kills: ReturnType<typeof vi.spyOn<typeof process, "kill">>;
    readonly stderr: ReturnType<typeof vi.spyOn<typeof process.stderr, "write">>;
    readonly addedTermListeners: ReadonlyArray<(...args: ReadonlyArray<unknown>) => void>;
  }) => Promise<void>,
) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-guard-test-"));
  const fifo = NodePath.join(dir, "ready");
  NodeChildProcess.execFileSync("mkfifo", [fifo]);
  const configPath = NodePath.join(dir, "guard.json");
  if (config !== null) NodeFS.writeFileSync(configPath, config);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const kills = vi.spyOn(process, "kill");
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const termBefore = process.listeners("SIGTERM");
  let childPid: number | undefined;
  try {
    const ready = NodeFS.promises.readFile(fifo, "utf8");
    const result = runGuard({
      argv: ["sh", "-c", script, fifo],
      platform: "linux",
      env: { T3CODE_GUARD_CONFIG: configPath },
    });
    childPid = Number((await ready).trim());
    const addedTermListeners = process
      .listeners("SIGTERM")
      .filter((listener) => !termBefore.includes(listener));
    await body({ childPid, result, kills, stderr, addedTermListeners });
  } finally {
    kills.mockRestore();
    stderr.mockRestore();
    vi.useRealTimers();
    if (childPid !== undefined) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {}
    }
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("runGuard", () => {
  const stressedSample = () => {
    vi.mocked(readHostTotals).mockReset();
    vi.mocked(readHostTotals).mockResolvedValue({ totals: STRESSED, next: null } as Awaited<
      ReturnType<typeof readHostTotals>
    >);
  };

  it.each([
    ["guard.json says the lane is off", guardJson({ enabled: false, guardHoldSeconds: 0 })],
    ["guard.json is missing", null],
    ["guard.json is malformed", "{ not json"],
  ])(
    "runs unguarded and never kills when %s, forwarding signals to the child alone",
    async (_name, config) => {
      stressedSample();
      await withChild(
        'echo $$ > "$0"; exec sleep 45',
        config,
        async ({ childPid, result, kills, stderr, addedTermListeners }) => {
          await vi.advanceTimersByTimeAsync(GUARD_SAMPLE_INTERVAL_MS * 30);
          expect(readHostTotals).not.toHaveBeenCalled();
          expect(kills).not.toHaveBeenCalled();

          // A SIGTERM to the guard reaches the ungrouped child by its own pid.
          expect(addedTermListeners).toHaveLength(1);
          addedTermListeners[0]!();
          expect(await result).toBe(128 + NodeOS.constants.signals.SIGTERM);
          expect(kills.mock.calls).toEqual([[childPid, "SIGTERM"]]);
          expect(stderr).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("SIGTERMs the child's group when stress holds, SIGKILLs only after the grace, exits 75 with one stderr line", async () => {
    stressedSample();
    await withChild(
      `trap '' TERM; echo $$ > "$0"; exec sleep 45`,
      guardJson({ guardHoldSeconds: 0 }),
      async ({ childPid, result, kills, stderr }) => {
        await vi.advanceTimersByTimeAsync(GUARD_SAMPLE_INTERVAL_MS);
        expect(kills.mock.calls).toEqual([[-childPid, "SIGTERM"]]);

        // The child ignores TERM; inside the grace it is left alone.
        await vi.advanceTimersByTimeAsync(GUARD_KILL_GRACE_MS - GUARD_SAMPLE_INTERVAL_MS);
        expect(kills.mock.calls).toEqual([[-childPid, "SIGTERM"]]);

        await vi.advanceTimersByTimeAsync(GUARD_SAMPLE_INTERVAL_MS);
        expect(await result).toBe(GUARD_EXIT_KILLED);
        expect(kills.mock.calls).toEqual([
          [-childPid, "SIGTERM"],
          [-childPid, "SIGKILL"],
        ]);
        for (const [target] of kills.mock.calls) {
          expect(Math.abs(target)).toBeGreaterThan(1);
          expect(Math.abs(target)).not.toBe(process.pid);
        }
        expect(stderr).toHaveBeenCalledTimes(1);
        const written = String(stderr.mock.calls[0]![0]);
        expect(written.endsWith("\n")).toBe(true);
        expect(written.slice(0, -1)).not.toMatch(/[\r\n]/);
      },
    );
  });

  it("does not SIGKILL a child that exited on SIGTERM", async () => {
    stressedSample();
    await withChild(
      'echo $$ > "$0"; exec sleep 45',
      guardJson({ guardHoldSeconds: 0 }),
      async ({ childPid, result, kills, stderr }) => {
        await vi.advanceTimersByTimeAsync(GUARD_SAMPLE_INTERVAL_MS);
        expect(await result).toBe(GUARD_EXIT_KILLED);
        await vi.advanceTimersByTimeAsync(GUARD_KILL_GRACE_MS * 3);
        expect(kills.mock.calls).toEqual([[-childPid, "SIGTERM"]]);
        expect(stderr).toHaveBeenCalledTimes(1);
      },
    );
  });
});
