import {
  ClaimId,
  EnvironmentId,
  LOAD_PAUSE_MAX_MS,
  type MachineTotalsSummary,
  type MachineVerdictReason,
  type OrchestrationV2LoadPause,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ThreadResourceTotals,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ResolvedClaim } from "../resourceTelemetry/ProcessOwnership.ts";
import {
  LOAD_PAUSE_FOCUS_WINDOW_MS,
  LOAD_PAUSE_REPAUSE_COOLDOWN_MS,
  LOAD_PAUSE_SHARE_THRESHOLD,
  type LoadPauseCandidate,
  loadPauseContainers,
  loadPauseSetCommand,
  loadResumeCommands,
  selectLoadPauseVictims,
} from "./LoadPausePolicy.ts";

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const at = (ms: number) => DateTime.makeUnsafe(ms);

// 10 cores at 50%: 500 core-percent in use, 8 GiB of RAM in use.
const totals: MachineTotalsSummary = {
  cpuUtilization: 0.5,
  cpuCount: 10,
  load: { one: 40, five: 30, fifteen: 20 },
  memoryTotalBytes: 16 * 2 ** 30,
  memoryAvailableBytes: 8 * 2 ** 30,
  swapTotalBytes: 0,
  swapUsedBytes: 0,
  memoryPressure: null,
};
const USED_CORE_PERCENT = 500;
const USED_MEMORY = 8 * 2 ** 30;

const reason = (overrides: Partial<MachineVerdictReason> = {}): MachineVerdictReason => ({
  rule: "load",
  value: 4,
  threshold: 3,
  heldForMs: 60_000,
  ...overrides,
});

const usage = (
  share: number,
  overrides: Partial<ThreadResourceTotals> = {},
): ThreadResourceTotals => ({
  cpuPercent: share * USED_CORE_PERCENT,
  memoryBytes: Math.round(share * USED_MEMORY),
  gpuUtilPercent: 90,
  vramBytes: 2 ** 30,
  processCount: 3,
  sampleAgeMs: 1_000,
  source: "cgroup",
  ...overrides,
});

const loadPause: OrchestrationV2LoadPause = {
  runId: RunId.make("run:old"),
  episodeId: "1",
  pausedAt: new Date(NOW).toISOString(),
  reason: { rule: "load", value: 4, threshold: 3, shareOfLoad: 0.5 },
  containersPaused: [],
};

type CandidatePatch = Omit<Partial<LoadPauseCandidate>, "thread"> & {
  readonly thread?: Partial<LoadPauseCandidate["thread"]>;
};

/** A low-priority running thread with half the load: pausable unless a patch says otherwise. */
const candidate = (id: string, share = 0.5, patch: CandidatePatch = {}): LoadPauseCandidate => ({
  usage: usage(share),
  hasUnsettledDelegateChild: false,
  parentWaiting: false,
  focusLease: false,
  lastResumedAtMs: undefined,
  ...patch,
  thread: {
    id: ThreadId.make(id),
    tags: ["priority:low"],
    activeRunId: RunId.make(`run:${id}`),
    activityRunStatus: "running",
    pendingRuntimeRequest: null,
    lastVisitedAt: null,
    loadPause: null,
    archivedAt: null,
    deletedAt: null,
    ...patch.thread,
  },
});

const victimIds = (candidates: ReadonlyArray<LoadPauseCandidate>, value = 4) =>
  selectLoadPauseVictims({ reason: reason({ value }), totals, candidates, nowMs: NOW }).map(
    (victim) => victim.threadId,
  );

const delegatedFrom = {
  environmentId: EnvironmentId.make("env:other"),
  threadId: ThreadId.make("thread:parent"),
  title: "Parent",
};

describe("selectLoadPauseVictims", () => {
  it.each<[string, CandidatePatch, boolean]>([
    ["a low-priority running thread", {}, true],
    ["preparing", { thread: { activityRunStatus: "preparing" } }, true],
    ["starting", { thread: { activityRunStatus: "starting" } }, true],
    ["waiting on a tool or child", { thread: { activityRunStatus: "waiting" } }, false],
    ["no activity status", { thread: { activityRunStatus: undefined } }, false],
    ["no active run", { thread: { activeRunId: null } }, false],
    ["already load-paused", { thread: { loadPause } }, false],
    ["archived", { thread: { archivedAt: at(NOW - 1) } }, false],
    ["deleted", { thread: { deletedAt: at(NOW - 1) } }, false],
    [
      "pending approval or input",
      {
        thread: {
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request:1"),
            kind: "approval",
            createdAt: at(NOW - 1),
          } as never,
        },
      },
      false,
    ],
    ["no tags: effective priority normal", { thread: { tags: [] } }, false],
    ["tags absent: normal", { thread: { tags: undefined } }, false],
    ["backgrounded: low by default", { thread: { tags: ["backgrounded"] } }, true],
    [
      "backgrounded but priority:normal",
      { thread: { tags: ["backgrounded", "priority:normal"] } },
      false,
    ],
    [
      "priority:low and priority:normal: normal wins",
      { thread: { tags: ["priority:low", "priority:normal"] } },
      false,
    ],
    ["orchestrator tag", { thread: { tags: ["priority:low", "orchestrator"] } }, false],
    ["unsettled delegate child (local or remote)", { hasUnsettledDelegateChild: true }, false],
    [
      "delegate child whose parent waits",
      { thread: { delegatedFrom }, parentWaiting: true },
      false,
    ],
    [
      "delegate child whose parent runs on",
      { thread: { delegatedFrom }, parentWaiting: false },
      true,
    ],
    ["parentWaiting without a parent is ignored", { parentWaiting: true }, true],
    ["live thread focus lease", { focusLease: true }, false],
    [
      "visited just inside the focus window",
      { thread: { lastVisitedAt: at(NOW - LOAD_PAUSE_FOCUS_WINDOW_MS + 1) } },
      false,
    ],
    [
      "visited exactly one focus window ago",
      { thread: { lastVisitedAt: at(NOW - LOAD_PAUSE_FOCUS_WINDOW_MS) } },
      true,
    ],
    [
      "resumed just inside the cooldown",
      { lastResumedAtMs: NOW - LOAD_PAUSE_REPAUSE_COOLDOWN_MS + 1 },
      false,
    ],
    [
      "resumed exactly one cooldown ago",
      { lastResumedAtMs: NOW - LOAD_PAUSE_REPAUSE_COOLDOWN_MS },
      true,
    ],
  ])("%s → paused: %s", (_name, patch, paused) => {
    expect(victimIds([candidate("t", 0.5, patch)])).toEqual(paused ? [ThreadId.make("t")] : []);
  });

  it.each<[MachineVerdictReason["rule"], ThreadResourceTotals, number | null]>([
    ["load", usage(0.25, { memoryBytes: 0 }), 0.25],
    ["cpu", usage(0.25, { memoryBytes: 0 }), 0.25],
    ["memory", usage(0.25, { cpuPercent: 0 }), 0.25],
    ["memoryPressure", usage(0.25, { cpuPercent: 0 }), 0.25],
    // No per-thread GPU rollup: GPU stress pauses nothing.
    ["gpuVram", usage(0.9), null],
    ["gpuUtil", usage(0.9), null],
    ["load", usage(0.25, { cpuPercent: null }), null],
    ["load", usage(3), 1],
    ["load", usage(LOAD_PAUSE_SHARE_THRESHOLD), LOAD_PAUSE_SHARE_THRESHOLD],
    ["load", usage(LOAD_PAUSE_SHARE_THRESHOLD - 0.001), null],
  ])("%s share of %j → %s", (rule, threadUsage, share) => {
    const victims = selectLoadPauseVictims({
      reason: reason({ rule, value: 100, threshold: 1 }),
      totals,
      candidates: [{ ...candidate("t"), usage: threadUsage }],
      nowMs: NOW,
    });
    expect(victims.map((victim) => victim.shareOfLoad)).toEqual(share === null ? [] : [share]);
  });

  it("measures nothing when the machine reports no CPU utilization or no used memory", () => {
    const blank = (rule: MachineVerdictReason["rule"], machine: MachineTotalsSummary) =>
      selectLoadPauseVictims({
        reason: reason({ rule, value: 100, threshold: 1 }),
        totals: machine,
        candidates: [candidate("t")],
        nowMs: NOW,
      });
    expect(blank("load", { ...totals, cpuUtilization: null })).toEqual([]);
    expect(blank("cpu", { ...totals, cpuUtilization: 0 })).toEqual([]);
    expect(blank("memory", { ...totals, memoryAvailableBytes: totals.memoryTotalBytes })).toEqual(
      [],
    );
  });

  it("takes the largest share first and stops once the rest of the load is under threshold", () => {
    const candidates = [
      candidate("small", 0.2),
      candidate("large", 0.5),
      candidate("medium", 0.3),
      candidate("tiny", 0.1),
    ];
    // Just over threshold: pausing the largest share already brings it under.
    expect(victimIds(candidates, 3.1)).toEqual(["large"]);
    // 4 × (1 − 0.5) = 2 < 3: one is enough.
    expect(victimIds(candidates, 4)).toEqual(["large"]);
    // 8 × 0.5 = 4 ≥ 3, 8 × 0.2 = 1.6 < 3.
    expect(victimIds(candidates, 8)).toEqual(["large", "medium"]);
    // 30 × 0.2 = 6, then 30 × 0 = 0; the 0.1 share never qualifies.
    expect(victimIds(candidates, 30)).toEqual(["large", "medium", "small"]);
    expect(
      selectLoadPauseVictims({ reason: reason({ value: 8 }), totals, candidates, nowMs: NOW }),
    ).toEqual([
      { threadId: "large", runId: "run:large", shareOfLoad: 0.5 },
      { threadId: "medium", runId: "run:medium", shareOfLoad: 0.3 },
    ]);
  });

  it("skips exempt threads without counting their share toward the stop", () => {
    const candidates = [
      candidate("focused", 0.6, { focusLease: true }),
      candidate("a", 0.3),
      candidate("b", 0.2),
    ];
    // Value 4: 4 ≥ 3 → a; 4 × 0.7 = 2.8 < 3 → stop.
    expect(victimIds(candidates, 4)).toEqual(["a"]);
  });
});

const claim = (
  threadId: string,
  overrides: { containerId?: string; dockerHost?: string; cgroup?: string; prefix?: string } = {},
): ResolvedClaim => ({
  claim: {
    id: ClaimId.make(
      `claim:${threadId}:${overrides.containerId ?? "none"}:${overrides.dockerHost ?? ""}`,
    ),
    threadId: ThreadId.make(threadId),
    target: {
      type: "container",
      id: overrides.prefix ?? (overrides.containerId ?? "missing").slice(0, 12),
      ...(overrides.dockerHost === undefined ? {} : { dockerHost: overrides.dockerHost }),
    },
    createdAt: at(NOW),
    createdBy: { type: "user" },
  },
  ...(overrides.containerId === undefined ? {} : { containerId: overrides.containerId }),
  ...(overrides.cgroup === undefined ? {} : { cgroup: overrides.cgroup }),
});

const FULL_A = "a".repeat(64);
const FULL_B = "b".repeat(64);

const containersOf = (
  victims: ReadonlyArray<string>,
  claims: ReadonlyArray<ResolvedClaim>,
  serverCgroup?: string,
) =>
  Object.fromEntries(
    loadPauseContainers({
      victims: new Set(victims.map((id) => ThreadId.make(id))),
      claims,
      serverCgroup,
    }),
  );

describe("loadPauseContainers", () => {
  it("records a container only its victims claim, by full id and docker host", () => {
    expect(
      containersOf(
        ["v"],
        [claim("v", { containerId: FULL_A, prefix: "web", dockerHost: "ssh://box" })],
      ),
    ).toEqual({ v: [{ id: FULL_A, dockerHost: "ssh://box" }] });
  });

  it("skips a container any non-victim also claims (F4)", () => {
    expect(
      containersOf(
        ["v"],
        [claim("v", { containerId: FULL_A }), claim("other", { containerId: FULL_A })],
      ),
    ).toEqual({});
  });

  it("records a container two victims share on both", () => {
    expect(
      containersOf(
        ["v1", "v2"],
        [claim("v1", { containerId: FULL_A }), claim("v2", { containerId: FULL_A })],
      ),
    ).toEqual({ v1: [{ id: FULL_A }], v2: [{ id: FULL_A }] });
  });

  it("keys containers by docker host: a non-victim on another host does not block", () => {
    expect(
      containersOf(
        ["v"],
        [
          claim("v", { containerId: FULL_A }),
          claim("other", { containerId: FULL_A, dockerHost: "ssh://box" }),
        ],
      ),
    ).toEqual({ v: [{ id: FULL_A }] });
  });

  it("never acts on unresolved containers or on process and cgroup claims", () => {
    const processClaim: ResolvedClaim = {
      claim: {
        id: ClaimId.make("claim:process"),
        threadId: ThreadId.make("v"),
        target: { type: "process", pid: 4242, startTimeMs: 1 },
        createdAt: at(NOW),
        createdBy: { type: "user" },
      },
      containerId: FULL_B,
    };
    const cgroupClaim: ResolvedClaim = {
      claim: {
        id: ClaimId.make("claim:cgroup"),
        threadId: ThreadId.make("v"),
        target: { type: "cgroup", path: "/system.slice/foo.service" },
        createdAt: at(NOW),
        createdBy: { type: "user" },
      },
      cgroup: "/system.slice/foo.service",
      containerId: FULL_B,
    };
    expect(
      containersOf(["v"], [claim("v", { containerId: undefined }), processClaim, cgroupClaim]),
    ).toEqual({});
  });

  it.each([
    ["the server runs inside the container", "/system.slice/docker-aaa.scope/init", false],
    ["the server is the container's cgroup", "/system.slice/docker-aaa.scope", false],
    ["the server runs elsewhere", "/user.slice/t3.service", true],
    ["the server cgroup is unknown", undefined, true],
  ] as const)("%s → recorded: %s", (_name, serverCgroup, recorded) => {
    expect(
      containersOf(
        ["v"],
        [claim("v", { containerId: FULL_A, cgroup: "/system.slice/docker-aaa.scope" })],
        serverCgroup,
      ),
    ).toEqual(recorded ? { v: [{ id: FULL_A }] } : {});
  });
});

describe("loadPauseSetCommand", () => {
  it("keys the command by thread and episode and carries the victim's share", () => {
    expect(
      loadPauseSetCommand({
        victim: { threadId: ThreadId.make("t"), runId: RunId.make("run:t"), shareOfLoad: 0.4 },
        episodeId: "123",
        reason: reason({ deviceId: "gpu0" }),
        containersPaused: [{ id: FULL_A }],
      }),
    ).toEqual({
      type: "thread.load-pause.set",
      commandId: "load-pause-set:t:123",
      threadId: "t",
      runId: "run:t",
      episodeId: "123",
      reason: { rule: "load", value: 4, threshold: 3, shareOfLoad: 0.4 },
      containersPaused: [{ id: FULL_A }],
    });
  });
});

const paused = (id: string, pausedAtMs: number | string) => ({
  threadId: ThreadId.make(id),
  loadPause: {
    ...loadPause,
    episodeId: `e-${id}`,
    pausedAt: typeof pausedAtMs === "string" ? pausedAtMs : new Date(pausedAtMs).toISOString(),
  },
});

const clearFor = (id: string) => ({
  type: "thread.load-pause.clear",
  commandId: `load-pause-clear:${id}:e-${id}`,
  threadId: id,
  episodeId: `e-${id}`,
});

describe("loadResumeCommands", () => {
  const set = [
    paused("newer", NOW - 60_000),
    paused("older", NOW - 120_000),
    paused("capped", NOW - LOAD_PAUSE_MAX_MS),
  ];

  it("clears every pause at once in all mode, whatever the verdict or gap", () => {
    expect(
      loadResumeCommands({
        mode: "all",
        paused: set,
        verdict: "stressed",
        nowMs: NOW,
        nextResumeAtMs: NOW + 1,
      }),
    ).toEqual([clearFor("newer"), clearFor("older"), clearFor("capped")]);
  });

  it.each([
    [
      "stressed, under the cap: nothing",
      "stressed",
      [paused("a", NOW - LOAD_PAUSE_MAX_MS + 1)],
      [],
    ],
    ["stressed, at the cap: that one", "stressed", [paused("a", NOW - LOAD_PAUSE_MAX_MS)], ["a"]],
    ["unknown counts as still stressed", "unknown", [paused("a", NOW - 1)], []],
    ["no verdict counts as still stressed", null, [paused("a", NOW - 1)], []],
    [
      "stressed: only the capped one, though others are older in the list",
      "stressed",
      [paused("young", NOW - 1), paused("capped", NOW - LOAD_PAUSE_MAX_MS - 1)],
      ["capped"],
    ],
    [
      "ok: the oldest first, one at a time",
      "ok",
      [paused("newer", NOW - 1_000), paused("oldest", NOW - 5_000), paused("middle", NOW - 2_000)],
      ["oldest"],
    ],
    [
      "an unparseable pausedAt counts as past the cap",
      "stressed",
      [paused("young", NOW - 1), paused("garbled", "not a date")],
      ["garbled"],
    ],
  ] as const)("release: %s", (_name, verdict, pausedThreads, expected) => {
    expect(
      loadResumeCommands({
        mode: "release",
        paused: pausedThreads,
        verdict,
        nowMs: NOW,
        nextResumeAtMs: NOW,
      }),
    ).toEqual(expected.map(clearFor));
  });

  it("releases nothing inside the gap, even when the machine is ok", () => {
    expect(
      loadResumeCommands({
        mode: "release",
        paused: set,
        verdict: "ok",
        nowMs: NOW,
        nextResumeAtMs: NOW + 1,
      }),
    ).toEqual([]);
  });
});
