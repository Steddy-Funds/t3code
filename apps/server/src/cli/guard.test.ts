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
  GUARD_FORWARD_DELAY_MS,
  GUARD_KILL_GRACE_MS,
  GUARD_SAMPLE_INTERVAL_MS,
  canSignalChild,
  descendantsOf,
  formatKillReason,
  initialGuardState,
  parseGuardArgs,
  parseGuardConfig,
  parseProcStat,
  parsePsTable,
  protectedPids,
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

describe("process tree", () => {
  it("parses /proc stat with spaces and parentheses in the command name", () => {
    const stat =
      "4242 (a (b) c) S 4200 4242 4200 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 10";
    expect(parseProcStat(4242, stat)).toEqual({ pid: 4242, ppid: 4200, start: "987654" });
    expect(parseProcStat(1, "garbage")).toBeNull();
  });

  it("parses ps lstart rows", () => {
    expect(
      parsePsTable("  10     1 Mon Nov  8 02:40:03 2026\n  11    10 Mon Nov  8 02:41:00 2026\n\n"),
    ).toEqual([
      { pid: 10, ppid: 1, start: "Mon Nov  8 02:40:03 2026" },
      { pid: 11, ppid: 10, start: "Mon Nov  8 02:41:00 2026" },
    ]);
  });

  const entry = (pid: number, ppid: number) => ({ pid, ppid, start: `t${pid}` });
  const table = [
    entry(1, 0),
    entry(5, 1),
    entry(10, 5),
    entry(20, 10),
    entry(21, 20),
    entry(30, 5),
  ];

  it("walks every descendant once, and nothing outside the roots", () => {
    expect(descendantsOf([entry(10, 5)], [...table, entry(10, 5)]).map((e) => e.pid)).toEqual([
      10, 20, 21,
    ]);
  });

  it("protects the guard and its ancestors", () => {
    expect([...protectedPids(10, table)].toSorted()).toEqual([10, 5]);
  });
});

/**
 * The child writes its pid (and any helper pids) into a FIFO once it is ready, so the test
 * knows them and never races the child's startup. `exec` keeps that pid for the sleep.
 */
const spyKill = () => vi.spyOn(process, "kill");
const spyStderr = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);

const processGroupOf = (pid: number | "self") =>
  NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[2];

async function withChild(
  script: string,
  config: string | null,
  body: (input: {
    readonly childPid: number;
    readonly otherPids: ReadonlyArray<number>;
    readonly configPath: string;
    /** Resolves after the guard has handled the command's exit. */
    readonly commandExited: Promise<unknown>;
    readonly result: Promise<number>;
    readonly kills: ReturnType<typeof spyKill>;
    readonly stderr: ReturnType<typeof spyStderr>;
    readonly addedTermListeners: ReadonlyArray<NodeJS.SignalsListener>;
    readonly addedIntListeners: ReadonlyArray<NodeJS.SignalsListener>;
  }) => Promise<void>,
) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-guard-test-"));
  const fifo = NodePath.join(dir, "ready");
  NodeChildProcess.execFileSync("mkfifo", [fifo]);
  const configPath = NodePath.join(dir, "guard.json");
  if (config !== null) NodeFS.writeFileSync(configPath, config);
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  const kills = spyKill();
  const stderr = spyStderr();
  const termBefore = process.listeners("SIGTERM");
  const intBefore = process.listeners("SIGINT");
  let pids: Array<number> = [];
  try {
    const ready = NodeFS.promises.readFile(fifo, "utf8");
    let spawned: NodeChildProcess.ChildProcess | undefined;
    const result = runGuard({
      argv: ["sh", "-c", script, fifo],
      platform: "linux",
      env: { T3CODE_GUARD_CONFIG: configPath },
      spawn: (command, args, options) => {
        spawned = NodeChildProcess.spawn(command, [...args], options);
        return spawned;
      },
    });
    // Registered after the guard's own listener, so it fires after the guard handled the exit.
    const commandExited = new Promise((resolve) => spawned!.once("exit", resolve));
    pids = (await ready).trim().split(/\s+/).map(Number);
    const addedTermListeners = process
      .listeners("SIGTERM")
      .filter((listener) => !termBefore.includes(listener));
    const addedIntListeners = process
      .listeners("SIGINT")
      .filter((listener) => !intBefore.includes(listener));
    await body({
      childPid: pids[0]!,
      otherPids: pids.slice(1),
      configPath,
      commandExited,
      result,
      kills,
      stderr,
      addedTermListeners,
      addedIntListeners,
    });
  } finally {
    kills.mockRestore();
    stderr.mockRestore();
    vi.useRealTimers();
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

const signalsTo = (kills: ReturnType<typeof spyKill>, pid: number) =>
  kills.mock.calls.filter(([target]) => target === pid).map(([, signal]) => signal);

// The tests read /proc to check process groups and descendants.
describe.skipIf(!NodeFS.existsSync("/proc/self/stat"))("runGuard", () => {
  const stressedSample = () => {
    vi.mocked(readHostTotals).mockReset();
    vi.mocked(readHostTotals).mockResolvedValue({ totals: STRESSED, next: [] });
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

          expect(addedTermListeners).toHaveLength(1);
          addedTermListeners[0]!("SIGTERM");
          expect(kills).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(GUARD_FORWARD_DELAY_MS);
          expect(await result).toBe(128 + NodeOS.constants.signals.SIGTERM);
          expect(kills.mock.calls).toEqual([[childPid, "SIGTERM"]]);
          expect(stderr).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("keeps the command in the guard's process group, so a kill aimed at that group reaches it", async () => {
    stressedSample();
    await withChild(
      'echo $$ > "$0"; exec sleep 45',
      guardJson({ guardHoldSeconds: 600 }),
      async ({ childPid, addedTermListeners, result }) => {
        expect(processGroupOf(childPid)).toBe(processGroupOf("self"));
        addedTermListeners[0]!("SIGTERM");
        await vi.advanceTimersByTimeAsync(GUARD_FORWARD_DELAY_MS);
        await result;
      },
    );
  });

  it("SIGTERMs the command and its descendants when stress holds, SIGKILLs only after the grace, exits 75 with one stderr line", async () => {
    stressedSample();
    await withChild(
      `trap '' TERM; (trap '' TERM; exec sleep 45) & echo "$$ $!" > "$0"; exec sleep 45`,
      guardJson({ guardHoldSeconds: 0 }),
      async ({ childPid, otherPids: [grandchild], result, kills, stderr }) => {
        await vi.advanceTimersByTimeAsync(GUARD_SAMPLE_INTERVAL_MS);
        expect(signalsTo(kills, childPid)).toEqual(["SIGTERM"]);
        expect(signalsTo(kills, grandchild!)).toEqual(["SIGTERM"]);

        // Both ignore TERM; inside the grace they are left alone.
        await vi.advanceTimersByTimeAsync(GUARD_KILL_GRACE_MS - GUARD_SAMPLE_INTERVAL_MS);
        expect(kills).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(GUARD_SAMPLE_INTERVAL_MS);
        expect(await result).toBe(GUARD_EXIT_KILLED);
        expect(signalsTo(kills, childPid)).toEqual(["SIGTERM", "SIGKILL"]);
        expect(signalsTo(kills, grandchild!)).toEqual(["SIGTERM", "SIGKILL"]);
        for (const [target] of kills.mock.calls) {
          expect(target).toBeGreaterThan(1);
          expect(target).not.toBe(process.pid);
        }
        expect(stderr).toHaveBeenCalledTimes(1);
        const written = String(stderr.mock.calls[0]![0]);
        expect(written.endsWith("\n")).toBe(true);
        expect(written.slice(0, -1)).not.toMatch(/[\r\n]/);
      },
    );
  });

  it("does not SIGKILL a command that exited on SIGTERM with nothing left behind", async () => {
    stressedSample();
    await withChild(
      'echo $$ > "$0"; exec sleep 45',
      guardJson({ guardHoldSeconds: 0 }),
      async ({ childPid, result, kills, stderr }) => {
        await vi.advanceTimersByTimeAsync(GUARD_SAMPLE_INTERVAL_MS);
        expect(await result).toBe(GUARD_EXIT_KILLED);
        await vi.advanceTimersByTimeAsync(GUARD_KILL_GRACE_MS * 3);
        expect(kills.mock.calls).toEqual([[childPid, "SIGTERM"]]);
        expect(stderr).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("still SIGKILLs a descendant that ignored SIGTERM after the command itself exited on it", async () => {
    stressedSample();
    await withChild(
      `(trap '' TERM; exec sleep 45) & echo "$$ $!" > "$0"; wait`,
      guardJson({ guardHoldSeconds: 0 }),
      async ({ childPid, otherPids: [straggler], commandExited, result, kills }) => {
        let settled = false;
        void result.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(GUARD_SAMPLE_INTERVAL_MS);
        expect(signalsTo(kills, childPid)).toEqual(["SIGTERM"]);
        expect(signalsTo(kills, straggler!)).toEqual(["SIGTERM"]);
        // The command is gone, but its straggler is not, so the guard waits out the grace.
        await commandExited;
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(GUARD_KILL_GRACE_MS);
        expect(await result).toBe(GUARD_EXIT_KILLED);
        expect(signalsTo(kills, straggler!)).toEqual(["SIGTERM", "SIGKILL"]);
        expect(signalsTo(kills, childPid)).toEqual(["SIGTERM"]);
      },
    );
  });

  it("stops watching when load management is turned off mid-run", async () => {
    stressedSample();
    await withChild(
      'echo $$ > "$0"; exec sleep 45',
      guardJson({ guardHoldSeconds: 30 }),
      async ({ configPath, result, kills, stderr, addedTermListeners }) => {
        await vi.advanceTimersByTimeAsync(GUARD_SAMPLE_INTERVAL_MS);
        expect(readHostTotals).toHaveBeenCalledTimes(1);
        NodeFS.writeFileSync(configPath, guardJson({ enabled: false, guardHoldSeconds: 30 }));

        await vi.advanceTimersByTimeAsync(GUARD_SAMPLE_INTERVAL_MS * 30);
        expect(readHostTotals).toHaveBeenCalledTimes(1);
        expect(kills).not.toHaveBeenCalled();

        addedTermListeners[0]!("SIGTERM");
        await vi.advanceTimersByTimeAsync(GUARD_FORWARD_DELAY_MS);
        expect(await result).toBe(128 + NodeOS.constants.signals.SIGTERM);
        expect(stderr).not.toHaveBeenCalled();
      },
    );
  });
  it("does not double a SIGTERM aimed at the guard's group: the command already got it", async () => {
    await withChild(
      'echo $$ > "$0"; exec sleep 45',
      null,
      async ({ childPid, commandExited, result, kills, addedTermListeners }) => {
        // A group kill lands on the command and the guard at once.
        process.kill(childPid, "SIGTERM");
        addedTermListeners[0]!("SIGTERM");
        await commandExited;
        await vi.advanceTimersByTimeAsync(GUARD_FORWARD_DELAY_MS);
        expect(await result).toBe(128 + NodeOS.constants.signals.SIGTERM);
        expect(signalsTo(kills, childPid)).toEqual(["SIGTERM"]);
      },
    );
  });

  it("forwards SIGTERM once however often the guard gets it within the wait", async () => {
    await withChild(
      'echo $$ > "$0"; exec sleep 45',
      null,
      async ({ childPid, result, kills, addedTermListeners }) => {
        addedTermListeners[0]!("SIGTERM");
        addedTermListeners[0]!("SIGTERM");
        await vi.advanceTimersByTimeAsync(GUARD_FORWARD_DELAY_MS);
        await result;
        expect(signalsTo(kills, childPid)).toEqual(["SIGTERM"]);
      },
    );
  });

  it("on Ctrl-C waits for the command and exits with its code, without forwarding", async () => {
    await withChild(
      'echo $$ > "$0"; exec sleep 45',
      guardJson({ guardHoldSeconds: 600 }),
      async ({ childPid, result, kills, addedIntListeners }) => {
        let settled = false;
        void result.then(() => {
          settled = true;
        });
        expect(addedIntListeners).toHaveLength(1);
        addedIntListeners[0]!("SIGINT");
        await vi.advanceTimersByTimeAsync(GUARD_SAMPLE_INTERVAL_MS);
        expect(settled).toBe(false);

        // The tty's SIGINT to the foreground group.
        process.kill(childPid, "SIGINT");
        expect(await result).toBe(128 + NodeOS.constants.signals.SIGINT);
        expect(kills.mock.calls).toEqual([[childPid, "SIGINT"]]);
        expect(process.listeners("SIGINT")).not.toContain(addedIntListeners[0]);
      },
    );
  });

  it("keeps guarding with the last good config when a guard.json read fails mid-run", async () => {
    stressedSample();
    await withChild(
      'echo $$ > "$0"; exec sleep 45',
      guardJson({ guardHoldSeconds: 600 }),
      async ({ configPath, addedTermListeners, result }) => {
        await vi.advanceTimersByTimeAsync(GUARD_SAMPLE_INTERVAL_MS);
        expect(readHostTotals).toHaveBeenCalledTimes(1);
        // A failed read (EMFILE, ENOENT) and a torn write both read as "no answer".
        NodeFS.rmSync(configPath);
        await vi.advanceTimersByTimeAsync(GUARD_SAMPLE_INTERVAL_MS);
        NodeFS.writeFileSync(configPath, '{ "enabled": fal');
        await vi.advanceTimersByTimeAsync(GUARD_SAMPLE_INTERVAL_MS);
        expect(readHostTotals).toHaveBeenCalledTimes(3);
        addedTermListeners[0]!("SIGTERM");
        await vi.advanceTimersByTimeAsync(GUARD_FORWARD_DELAY_MS);
        await result;
      },
    );
  });
});
