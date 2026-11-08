import { it } from "@effect/vitest";
import {
  ClaimId,
  DEFAULT_SERVER_SETTINGS,
  MACHINE_BUCKETS_MAX,
  MachineClaimError,
  ProviderDriverKind,
  ThreadId,
  type ClaimTarget,
  type MachineActor,
  type MachineBucket,
  type MachineBucketId,
  type ProcessOwner,
  type ResourceMonitorHelloEvent,
  type ResourceMonitorProcessTableEntry,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  makeProcessOwnershipRegistry,
  ProcessOwnershipRegistry,
  type ProcessRoot,
  type RegisteredRoot,
} from "@t3tools/shared/ProcessOwnershipRegistry";
import type { RootCgroup } from "@t3tools/shared/cgroup";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import { ServerSettingsService } from "../serverSettings.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import {
  type AttributionInput,
  type OwnershipRow,
  type ProcessOwnershipIo,
  type ProcessOwnershipShape,
  type ResolvedClaim,
  attributeRows,
  boundRootRow,
  buildProcessTree,
  claimedProcessRoots,
  environmentReadsNeeded,
  expiredClaims,
  makeWith,
  mayWriteBucket,
  matchBucket,
  processKey,
  ProcessOwnership,
  prunePins,
  rootCategories,
  stampBucketPatch,
} from "./ProcessOwnership.ts";

const SERVER = 100;
const MONITOR = 200;
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const EPOCH = DateTime.makeUnsafe(0);
const LATER = DateTime.makeUnsafe(60_000);

const row = (
  pid: number,
  ppid: number,
  startTimeMs: number,
  extra: Partial<OwnershipRow> = {},
): OwnershipRow => ({
  pid,
  ppid,
  startTimeMs,
  name: `p${pid}`,
  command: `p${pid}`,
  exe: "",
  cwd: "",
  user: "",
  cgroup: "",
  containerId: "",
  ...extra,
});

let nextRootId = 0;
const registered = (
  root: ProcessRoot,
  cgroup: RootCgroup = { type: "none" },
  registeredAtMs = 10_000,
): RegisteredRoot => ({ id: nextRootId++, root, registeredAtMs, cgroup });

const threadRoot = (
  pid: number,
  startTimeMs: number,
  threadId: string = THREAD_A,
): ProcessRoot => ({
  pid,
  startTimeMs,
  owner: { type: "thread", threadId },
});

const claimId = (id: string) => ClaimId.make(id);
const bucketId = (id: string) => id as MachineBucketId;

const resolvedClaim = (
  id: string,
  threadId: ThreadId,
  target: ClaimTarget,
  extra: Omit<ResolvedClaim, "claim"> = {},
): ResolvedClaim => ({
  claim: { id: claimId(id), threadId, target, createdAt: EPOCH, createdBy: { type: "user" } },
  ...extra,
});

const bucket = (
  id: string,
  rules: MachineBucket["rules"],
  updatedBy: MachineActor = { type: "user" },
): MachineBucket => ({
  id: bucketId(id),
  name: id,
  rules,
  provenance: { createdBy: updatedBy, updatedBy, updatedAt: EPOCH },
});

function attribute(
  rows: ReadonlyArray<OwnershipRow>,
  input: Partial<Omit<AttributionInput, "tree">> = {},
) {
  const owners = attributeRows({
    tree: buildProcessTree(rows),
    roots: [],
    claims: [],
    buckets: [],
    serverPid: SERVER,
    monitorPid: MONITOR,
    envThread: () => undefined,
    bucketMemo: new Map(),
    ...input,
  });
  return (target: OwnershipRow): ProcessOwner | undefined =>
    owners.get(processKey(target.pid, target.startTimeMs));
}

const serverRow = row(SERVER, 1, 1_000, { name: "node", command: "node t3" });
const threadA: ProcessOwner = { type: "thread", threadId: THREAD_A };
const threadB: ProcessOwner = { type: "thread", threadId: THREAD_B };

describe("buildProcessTree", () => {
  it("links a child to the parent its ppid names", () => {
    const parent = row(300, 1, 5_000);
    const child = row(301, 300, 5_100);
    expect(buildProcessTree([parent, child]).parent(child)).toBe(parent);
  });

  it.each<[string, OwnershipRow, ReadonlyArray<OwnershipRow>]>([
    [
      "a parent started after its child is a reused pid",
      row(301, 300, 5_000),
      [row(300, 1, 9_000)],
    ],
    ["ppid 0", row(301, 0, 5_000), [row(300, 1, 1_000)]],
    ["its own pid as ppid", row(301, 301, 5_000), []],
    ["a parent gone from the table", row(301, 300, 5_000), [row(1, 0, 0)]],
  ])("no parent: %s", (_name, child, others) => {
    expect(buildProcessTree([...others, child]).parent(child)).toBeUndefined();
  });
});

describe("boundRootRow", () => {
  const unstamped: ProcessRoot = { pid: 300, owner: { type: "thread", threadId: THREAD_A } };

  it.each<[string, ProcessRoot, number, boolean]>([
    ["exact start time", threadRoot(300, 5_000), 5_000, true],
    ["start time within 1 s", threadRoot(300, 5_000), 5_999, true],
    ["start time past 1 s is another process", threadRoot(300, 5_000), 6_001, false],
    ["no start time: started before registration", unstamped, 4_000, true],
    ["no start time: started within 2 s of registration", unstamped, 12_000, true],
    ["no start time: the pid reused after registration", unstamped, 12_001, false],
    ["a cgroup-only root", { cgroup: "/a", owner: { type: "t3", label: "x" } }, 5_000, false],
  ])("%s → %s", (_name, root, startTimeMs, bound) => {
    const candidate = row(300, 1, startTimeMs);
    const result = boundRootRow(
      registered(root, { type: "none" }, 10_000),
      new Map([[300, candidate]]),
    );
    expect(result).toBe(bound ? candidate : undefined);
  });

  it("is undefined when the pid is not in the table", () => {
    expect(boundRootRow(registered(threadRoot(300, 5_000)), new Map())).toBeUndefined();
  });
});

describe("rootCategories", () => {
  it("names thread and shared roots provider roots, terminals terminal roots, and skips T3 and unbound roots", () => {
    const rows = [row(300, 1, 5_000), row(301, 1, 5_000), row(302, 1, 5_000), row(303, 1, 5_000)];
    const categories = rootCategories(
      [
        registered(threadRoot(300, 5_000)),
        registered({
          pid: 301,
          startTimeMs: 5_000,
          owner: { type: "thread", threadId: THREAD_A, terminalId: "t1" },
        }),
        registered({
          pid: 302,
          startTimeMs: 5_000,
          owner: { type: "shared", provider: "codex", label: "app-server" },
        }),
        registered({
          pid: 303,
          startTimeMs: 5_000,
          owner: { type: "t3", label: "machine terminal" },
        }),
        registered(threadRoot(304, 5_000)),
      ],
      rows,
    );
    expect(Object.fromEntries(categories)).toEqual({
      [processKey(300, 5_000)]: "provider-root",
      [processKey(301, 5_000)]: "terminal-root",
      [processKey(302, 5_000)]: "provider-root",
    });
  });
});

describe("attributeRows", () => {
  it("names the server and the monitor T3's own, even under a root", () => {
    const monitor = row(MONITOR, 300, 6_000);
    const owner = attribute([serverRow, row(300, SERVER, 5_000), monitor], {
      roots: [registered(threadRoot(300, 5_000))],
    });
    expect(owner(serverRow)).toEqual({ type: "t3", label: "server" });
    expect(owner(monitor)).toEqual({ type: "t3", label: "resource monitor" });
  });

  describe("process tree", () => {
    const rootRow = row(300, SERVER, 5_000);
    const child = row(301, 300, 5_100);
    const grandchild = row(302, 301, 5_200);

    it("gives a root's whole subtree to its owner", () => {
      const owner = attribute([serverRow, rootRow, child, grandchild], {
        roots: [registered(threadRoot(300, 5_000))],
      });
      expect([owner(rootRow), owner(child), owner(grandchild)]).toEqual([
        threadA,
        threadA,
        threadA,
      ]);
    });

    it("binds a root to its start time, not to a reused pid", () => {
      const reused = row(300, SERVER, 50_000, { name: "codex" });
      const owner = attribute([serverRow, reused], { roots: [registered(threadRoot(300, 5_000))] });
      expect(owner(reused)).toEqual({ type: "provider", provider: "codex" });
    });

    it("follows a reparented process to its new parent's owner", () => {
      const moved = row(301, 400, 5_100);
      const owner = attribute([serverRow, rootRow, row(400, 1, 4_000), moved], {
        roots: [registered(threadRoot(300, 5_000)), registered(threadRoot(400, 4_000, THREAD_B))],
      });
      expect(owner(moved)).toEqual(threadB);
    });

    it("loses an orphan once the root exits and it is reparented to init", () => {
      const orphan = row(301, 1, 5_100);
      const owner = attribute([serverRow, orphan], { roots: [registered(threadRoot(300, 5_000))] });
      expect(owner(orphan)).toEqual({ type: "other" });
    });

    it("keeps an orphan in the root's adopted cgroup after the root exits", () => {
      const orphan = row(301, 1, 5_100, { cgroup: "/user.slice/agent-1.scope" });
      const owner = attribute([serverRow, orphan], {
        roots: [
          registered(threadRoot(300, 5_000), {
            type: "adopted",
            cgroup: "/user.slice/agent-1.scope",
          }),
        ],
      });
      expect(owner(orphan)).toEqual(threadA);
    });

    it("counts only the pid subtree of a root still pending in the server's cgroup", () => {
      const beside = row(500, 1, 5_000, { cgroup: "/t3.service" });
      const owner = attribute([serverRow, rootRow, beside], {
        roots: [registered(threadRoot(300, 5_000), { type: "pending" })],
      });
      expect(owner(rootRow)).toEqual(threadA);
      expect(owner(beside)).toEqual({ type: "other" });
    });

    it("gives a nested root's subtree to the nearest root, a terminal with its id", () => {
      const terminal = row(302, 301, 5_200);
      const shell = row(303, 302, 5_300);
      const owner = attribute([serverRow, rootRow, child, terminal, shell], {
        roots: [
          registered(threadRoot(300, 5_000)),
          registered({
            pid: 302,
            startTimeMs: 5_200,
            owner: { type: "thread", threadId: THREAD_B, terminalId: "t1" },
          }),
        ],
      });
      expect(owner(child)).toEqual(threadA);
      expect(owner(shell)).toEqual({ type: "thread", threadId: THREAD_B, terminalId: "t1" });
    });

    it("prefers a pid root over a cgroup root, and the deepest cgroup root over its parent", () => {
      const inBoth = row(301, 300, 5_100, { cgroup: "/a/b/c" });
      const deep = row(600, 1, 5_000, { cgroup: "/a/b/c" });
      const shallow = row(601, 1, 5_000, { cgroup: "/a/x" });
      const owner = attribute([serverRow, rootRow, inBoth, deep, shallow], {
        roots: [
          registered(threadRoot(300, 5_000)),
          registered(
            { cgroup: "/a", owner: { type: "t3", label: "outer" } },
            { type: "adopted", cgroup: "/a" },
          ),
          registered(
            { cgroup: "/a/b", owner: { type: "thread", threadId: THREAD_B } },
            { type: "adopted", cgroup: "/a/b" },
          ),
        ],
      });
      expect(owner(inBoth)).toEqual(threadA);
      expect(owner(deep)).toEqual(threadB);
      expect(owner(shallow)).toEqual({ type: "t3", label: "outer" });
    });
  });

  describe("shared roots", () => {
    const appServer = row(500, SERVER, 5_000, { name: "codex" });
    const sharedRoot = (extra: Partial<ProcessRoot> = {}) =>
      registered({
        pid: 500,
        startTimeMs: 5_000,
        owner: { type: "shared", provider: "codex", label: "app-server" },
        ...extra,
      });

    it.each<[string, ProcessRoot["threads"], number]>([
      ["no thread list", undefined, 0],
      ["one thread", () => [THREAD_A], 1],
      ["several threads", () => [THREAD_A, THREAD_B, "thread-c"], 3],
    ])("shares the subtree, %s", (_name, threads, threadCount) => {
      const child = row(501, 500, 5_100);
      const owner = attribute([serverRow, appServer, child], {
        roots: [sharedRoot(threads === undefined ? {} : { threads })],
      });
      const shared = { type: "shared", provider: "codex", label: "app-server", threadCount };
      expect([owner(appServer), owner(child)]).toEqual([shared, shared]);
    });

    it("splits by the nearest T3CODE_THREAD_ID below the root, and never reads the root's own", () => {
      const mcpA = row(501, 500, 5_100);
      const underA = row(502, 501, 5_200);
      const ownB = row(503, 501, 5_300);
      const unmarked = row(504, 500, 5_400);
      const env = new Map<number, ThreadId | null>([
        [500, ThreadId.make("thread-server")],
        [501, THREAD_A],
        [503, THREAD_B],
        [504, null],
      ]);
      const owner = attribute([serverRow, appServer, mcpA, underA, ownB, unmarked], {
        roots: [sharedRoot({ splitByEnv: true, threads: () => [THREAD_A, THREAD_B] })],
        envThread: (target) => env.get(target.pid),
      });
      const shared = { type: "shared", provider: "codex", label: "app-server", threadCount: 2 };
      expect(owner(appServer)).toEqual(shared);
      expect(owner(mcpA)).toEqual(threadA);
      expect(owner(underA)).toEqual(threadA);
      expect(owner(ownB)).toEqual(threadB);
      expect(owner(unmarked)).toEqual(shared);
    });

    it("keeps a shared root whole when it does not split", () => {
      const child = row(501, 500, 5_100);
      const owner = attribute([serverRow, appServer, child], {
        roots: [sharedRoot()],
        envThread: () => THREAD_A,
      });
      expect(owner(child)).toMatchObject({ type: "shared" });
    });

    it("names a shared root with a provider that is not a driver kind a T3 group", () => {
      const owner = attribute([serverRow, appServer], {
        roots: [
          registered({
            pid: 500,
            startTimeMs: 5_000,
            owner: { type: "shared", provider: "not a kind", label: "helper" },
          }),
        ],
      });
      expect(owner(appServer)).toEqual({ type: "t3", label: "helper" });
    });
  });

  describe("claims", () => {
    const claimed = row(600, 1, 7_000);
    const claimedChild = row(601, 600, 7_100);
    const processTarget = (pid: number, startTimeMs: number): ClaimTarget => ({
      type: "process",
      pid,
      startTimeMs,
    });

    it("gives a claimed process and its subtree to the claim", () => {
      const owner = attribute([serverRow, claimed, claimedChild], {
        claims: [resolvedClaim("c1", THREAD_A, processTarget(600, 7_000))],
      });
      const expected = { type: "claimed", claimId: "c1", threadId: THREAD_A };
      expect([owner(claimed), owner(claimedChild)]).toEqual([expected, expected]);
    });

    it("ignores a process claim whose start time no longer matches", () => {
      const owner = attribute([serverRow, claimed], {
        claims: [resolvedClaim("c1", THREAD_A, processTarget(600, 1_000))],
      });
      expect(owner(claimed)).toEqual({ type: "other" });
    });

    it("lets the oldest of several claims on one process win", () => {
      const owner = attribute([serverRow, claimed], {
        claims: [
          resolvedClaim("c1", THREAD_A, processTarget(600, 7_000)),
          resolvedClaim("c2", THREAD_B, processTarget(600, 7_000)),
        ],
      });
      expect(owner(claimed)).toEqual({ type: "claimed", claimId: "c1", threadId: THREAD_A });
    });

    it("gives a container's processes to the oldest of several threads claiming it", () => {
      const inContainer = row(700, 1, 7_000, { containerId: "abc123full" });
      const elsewhere = row(701, 1, 7_000, { containerId: "other" });
      const target: ClaimTarget = { type: "container", id: "abc123full" };
      const owner = attribute([serverRow, inContainer, elsewhere], {
        claims: [
          resolvedClaim("c1", THREAD_A, target, { containerId: "abc123full" }),
          resolvedClaim("c2", THREAD_B, target, { containerId: "abc123full" }),
        ],
      });
      expect(owner(inContainer)).toEqual({ type: "claimed", claimId: "c1", threadId: THREAD_A });
      expect(owner(elsewhere)).toEqual({ type: "container", id: "other" });
    });

    it("gives a cgroup and the cgroups below it to a cgroup claim, never a row without a cgroup", () => {
      const inside = row(800, 1, 7_000, { cgroup: "/system.slice/foo.service/sub" });
      const outside = row(801, 1, 7_000, { cgroup: "/system.slice/foobar.service" });
      const unknown = row(802, 1, 7_000);
      const path = "/system.slice/foo.service";
      const owner = attribute([serverRow, inside, outside, unknown], {
        claims: [resolvedClaim("c1", THREAD_A, { type: "cgroup", path }, { cgroup: path })],
      });
      expect(owner(inside)).toEqual({ type: "claimed", claimId: "c1", threadId: THREAD_A });
      expect(owner(outside)).toEqual({ type: "other" });
      expect(owner(unknown)).toEqual({ type: "other" });
    });

    it("prefers a process claim over a group claim, and a root over any claim", () => {
      const both = row(700, 1, 7_000, { containerId: "abc" });
      const rooted = row(301, 300, 5_100, { containerId: "abc" });
      const owner = attribute([serverRow, both, row(300, SERVER, 5_000), rooted], {
        roots: [registered(threadRoot(300, 5_000))],
        claims: [
          resolvedClaim(
            "group",
            THREAD_A,
            { type: "container", id: "abc" },
            { containerId: "abc" },
          ),
          resolvedClaim("process", THREAD_B, processTarget(700, 7_000)),
          resolvedClaim("rooted", THREAD_B, processTarget(301, 5_100)),
        ],
      });
      expect(owner(both)).toEqual({ type: "claimed", claimId: "process", threadId: THREAD_B });
      expect(owner(rooted)).toEqual(threadA);
    });

    it("puts a claim ahead of a bucket", () => {
      const owner = attribute([serverRow, claimed], {
        claims: [resolvedClaim("c1", THREAD_A, processTarget(600, 7_000))],
        buckets: [bucket("all", [{ field: "command", op: "contains", value: "p" }])],
      });
      expect(owner(claimed)).toMatchObject({ type: "claimed" });
    });
  });

  describe("buckets", () => {
    const cargo = row(900, 1, 8_000, {
      name: "cargo",
      command: "cargo build",
      exe: "/usr/bin/cargo",
    });
    const rustc = row(901, 900, 8_100, { name: "rustc", command: "rustc --crate-name x" });

    it("gives a matching process and its children to the bucket", () => {
      const owner = attribute([serverRow, cargo, rustc], {
        buckets: [bucket("builds", [{ field: "exe", op: "equals", value: "/usr/bin/cargo" }])],
      });
      expect([owner(cargo), owner(rustc)]).toEqual([
        { type: "bucket", bucketId: "builds" },
        { type: "bucket", bucketId: "builds" },
      ]);
    });

    it("gives a child its own bucket over its parent's", () => {
      const owner = attribute([serverRow, cargo, rustc], {
        buckets: [
          bucket("builds", [{ field: "command", op: "glob", value: "cargo *" }]),
          bucket("compilers", [{ field: "command", op: "contains", value: "rustc" }]),
        ],
      });
      expect(owner(cargo)).toEqual({ type: "bucket", bucketId: "builds" });
      expect(owner(rustc)).toEqual({ type: "bucket", bucketId: "compilers" });
    });

    it("takes the first bucket in settings order when several match", () => {
      const owner = attribute([serverRow, cargo], {
        buckets: [
          bucket("first", [{ field: "command", op: "contains", value: "cargo" }]),
          bucket("second", [{ field: "command", op: "equals", value: "cargo build" }]),
        ],
      });
      expect(owner(cargo)).toEqual({ type: "bucket", bucketId: "first" });
    });

    it("uses carried matches from the memo and fills it for every row", () => {
      const memo = new Map<string, MachineBucketId | null>([
        [processKey(900, 8_000), bucketId("carried")],
      ]);
      const owner = attribute([serverRow, cargo, rustc], { buckets: [], bucketMemo: memo });
      expect(owner(rustc)).toEqual({ type: "bucket", bucketId: "carried" });
      expect(memo.get(processKey(901, 8_100))).toBeNull();
    });
  });

  describe("fallbacks", () => {
    it.each<[string, OwnershipRow, ProcessOwner]>([
      [
        "a provider child of the server",
        row(300, SERVER, 5_000, { name: "codex" }),
        { type: "provider", provider: ProviderDriverKind.make("codex") },
      ],
      [
        "a script provider under a JS runtime",
        row(300, SERVER, 5_000, {
          name: "node",
          command: "node /x/@anthropic-ai/claude-code/cli.js",
        }),
        { type: "provider", provider: ProviderDriverKind.make("claude") },
      ],
      [
        "a terminal child of the server",
        row(300, SERVER, 5_000, { name: "bash" }),
        { type: "t3", label: "terminal" },
      ],
      [
        "another child of the server",
        row(300, SERVER, 5_000, { name: "git" }),
        { type: "t3", label: "other" },
      ],
      [
        "a container process",
        row(300, 1, 5_000, { containerId: "abc" }),
        { type: "container", id: "abc" },
      ],
      ["anything else", row(300, 1, 5_000), { type: "other" }],
    ])("%s", (_name, target, expected) => {
      expect(attribute([serverRow, target])(target)).toEqual(expected);
    });

    it("gives a server child's descendants its group", () => {
      const provider = row(300, SERVER, 5_000, { name: "codex" });
      const helper = row(301, 300, 5_100, { name: "rg" });
      expect(attribute([serverRow, provider, helper])(helper)).toEqual({
        type: "provider",
        provider: "codex",
      });
    });
  });
});

describe("matchBucket", () => {
  const target = row(900, 800, 8_000, {
    name: "cargo",
    command: "cargo build --release",
    exe: "/usr/bin/cargo",
    cwd: "/srv/app",
    user: "akiva",
    containerId: "abcdef",
  });
  const parent = row(800, 1, 7_000, { name: "make", command: "make all" });
  const only = (rule: MachineBucket["rules"][number]) => [bucket("b", [rule])];

  it.each<[string, MachineBucket["rules"][number], ThreadId | null | undefined, boolean]>([
    [
      "command equals",
      { field: "command", op: "equals", value: "cargo build --release" },
      undefined,
      true,
    ],
    [
      "command equals is exact",
      { field: "command", op: "equals", value: "cargo build" },
      undefined,
      false,
    ],
    ["exe contains", { field: "exe", op: "contains", value: "bin/car" }, undefined, true],
    ["cwd glob", { field: "cwd", op: "glob", value: "/srv/*" }, undefined, true],
    ["glob is anchored", { field: "cwd", op: "glob", value: "/srv" }, undefined, false],
    ["glob ? is one character", { field: "user", op: "glob", value: "akiv?" }, undefined, true],
    [
      "glob escapes regex characters",
      { field: "command", op: "glob", value: "cargo.build*" },
      undefined,
      false,
    ],
    ["user equals", { field: "user", op: "equals", value: "akiva" }, undefined, true],
    ["container prefix", { field: "container", op: "glob", value: "abc*" }, undefined, true],
    ["parent name", { field: "parent", op: "equals", value: "make" }, undefined, true],
    ["parent command", { field: "parent", op: "contains", value: "all" }, undefined, true],
    [
      "thread rule matches the environment's thread",
      { field: "thread", threadId: THREAD_A },
      THREAD_A,
      true,
    ],
    ["thread rule, another thread", { field: "thread", threadId: THREAD_A }, THREAD_B, false],
    ["thread rule, no thread", { field: "thread", threadId: THREAD_A }, null, false],
    ["thread rule, unread environment", { field: "thread", threadId: THREAD_A }, undefined, false],
    ["pin", { field: "pid", pid: 900, startTimeMs: 8_000 }, undefined, true],
    ["pin within 1 s", { field: "pid", pid: 900, startTimeMs: 8_900 }, undefined, true],
    ["pin on a reused pid", { field: "pid", pid: 900, startTimeMs: 2_000 }, undefined, false],
  ])("%s → %s", (_name, rule, envThread, matches) => {
    expect(matchBucket(only(rule), target, parent, envThread)).toBe(matches ? "b" : null);
  });

  it("never matches an empty field", () => {
    const bare = row(900, 1, 8_000, { command: "" });
    expect(
      matchBucket(only({ field: "command", op: "glob", value: "*" }), bare, undefined, undefined),
    ).toBeNull();
    expect(
      matchBucket(only({ field: "parent", op: "glob", value: "*" }), bare, undefined, undefined),
    ).toBeNull();
  });
});

describe("mayWriteBucket and stampBucketPatch", () => {
  const auto: MachineActor = { type: "auto", threadId: THREAD_A };
  const otherAuto: MachineActor = { type: "auto", threadId: THREAD_B };
  const agent: MachineActor = { type: "agent", threadId: THREAD_A };
  const user: MachineActor = { type: "user" };
  const rules: MachineBucket["rules"] = [{ field: "exe", op: "equals", value: "cargo" }];

  it.each<[string, MachineBucket | undefined, MachineActor, boolean]>([
    ["anyone creates", undefined, auto, true],
    ["auto updates auto's", bucket("b", rules, otherAuto), auto, true],
    ["auto never updates a user's", bucket("b", rules, user), auto, false],
    ["auto never updates an agent's", bucket("b", rules, agent), auto, false],
    ["a user updates auto's", bucket("b", rules, auto), user, true],
    ["an agent updates a user's", bucket("b", rules, user), agent, true],
  ])("%s → %s", (_name, existing, actor, allowed) => {
    expect(mayWriteBucket(existing, actor)).toBe(allowed);
  });

  it("stamps new entries as the actor, ignoring a client's provenance", () => {
    const result = stampBucketPatch({
      current: {},
      entries: {
        b: {
          id: bucketId("b"),
          name: "Builds",
          rules,
          provenance: { createdBy: agent, updatedBy: agent, updatedAt: LATER },
        },
      },
      actor: user,
      now: EPOCH,
    });
    expect(result).toEqual(
      Result.succeed({
        b: {
          id: "b",
          name: "Builds",
          rules,
          provenance: { createdBy: user, updatedBy: user, updatedAt: EPOCH },
        },
      }),
    );
  });

  it("keeps who created a bucket when someone else updates it, and the key as its id", () => {
    const result = stampBucketPatch({
      current: { b: bucket("b", rules, auto) },
      entries: { b: { id: bucketId("other"), name: "Renamed", rules } },
      actor: user,
      now: LATER,
    });
    expect(result).toEqual(
      Result.succeed({
        b: {
          id: "b",
          name: "Renamed",
          rules,
          provenance: { createdBy: auto, updatedBy: user, updatedAt: LATER },
        },
      }),
    );
  });

  it.each<[string, MachineActor, Record<string, MachineBucket>, boolean]>([
    ["auto updating a user's bucket", auto, { b: bucket("b", rules, user) }, true],
    ["auto deleting a user's bucket", auto, { b: bucket("b", rules, user) }, true],
    ["a user deleting auto's bucket", user, { b: bucket("b", rules, auto) }, false],
  ])("BucketEditedError: %s → %s", (name, actor, current, edited) => {
    const result = stampBucketPatch({
      current,
      entries: { b: name.includes("deleting") ? null : { id: bucketId("b"), name: "b", rules } },
      actor,
      now: EPOCH,
    });
    expect(Result.isFailure(result) && result.failure._tag === "BucketEditedError").toBe(edited);
  });

  it("deletes with null, and passes a delete of an unknown bucket through", () => {
    expect(
      stampBucketPatch({
        current: { b: bucket("b", rules, auto) },
        entries: { b: null, gone: null },
        actor: auto,
        now: EPOCH,
      }),
    ).toEqual(Result.succeed({ b: null, gone: null }));
  });

  describe("the bucket limit", () => {
    const full = Object.fromEntries(
      Array.from({ length: MACHINE_BUCKETS_MAX }, (_, index) => [
        `b${index}`,
        bucket(`b${index}`, rules),
      ]),
    );
    const entry = (id: string) => ({ id: bucketId(id), name: id, rules });

    it.each<
      [
        string,
        Record<string, MachineBucket>,
        Record<string, ReturnType<typeof entry> | null>,
        boolean,
      ]
    >([
      ["one more at the limit", full, { extra: entry("extra") }, true],
      ["an update at the limit", full, { b0: entry("b0") }, false],
      ["a swap at the limit", full, { b0: null, extra: entry("extra") }, false],
      [
        "up to the limit",
        { b0: bucket("b0", rules) },
        Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`n${i}`, entry(`n${i}`)])),
        false,
      ],
    ])("%s → limit %s", (_name, current, entries, limited) => {
      const result = stampBucketPatch({ current, entries, actor: user, now: EPOCH });
      expect(Result.isFailure(result) && result.failure._tag === "MachineBucketLimitError").toBe(
        limited,
      );
    });

    it("lets a server already past the limit shrink", () => {
      const over = { ...full, extra: bucket("extra", rules) };
      expect(
        Result.isSuccess(
          stampBucketPatch({ current: over, entries: { b0: null }, actor: user, now: EPOCH }),
        ),
      ).toBe(true);
    });
  });
});

describe("prunePins", () => {
  it("drops pins of exited processes and returns only the buckets it changed, provenance kept", () => {
    const auto: MachineActor = { type: "auto", threadId: THREAD_A };
    const pinned = bucket(
      "pinned",
      [
        { field: "pid", pid: 10, startTimeMs: 1_000 },
        { field: "pid", pid: 11, startTimeMs: 1_000 },
        { field: "exe", op: "equals", value: "cargo" },
      ],
      auto,
    );
    const alive = bucket("alive", [{ field: "pid", pid: 10, startTimeMs: 1_000 }]);
    const plain = bucket("plain", [{ field: "exe", op: "equals", value: "make" }]);
    const pruned = prunePins([pinned, alive, plain], (pid) => pid === 10);
    expect(pruned).toEqual({ pinned: { ...pinned, rules: [pinned.rules[0], pinned.rules[2]] } });
  });
});

describe("environmentReadsNeeded", () => {
  const rows = [
    serverRow,
    row(500, SERVER, 5_000),
    row(501, 500, 5_100),
    row(502, 501, 5_200),
    row(600, 1, 5_000),
  ];
  const split = registered({
    pid: 500,
    startTimeMs: 5_000,
    owner: { type: "shared", provider: "codex", label: "app-server" },
    splitByEnv: true,
  });
  const pids = (needed: ReadonlyArray<OwnershipRow>) => needed.map((entry) => entry.pid);

  it.each<
    [
      string,
      ReadonlyArray<RegisteredRoot>,
      ReadonlyArray<MachineBucket>,
      ReadonlyArray<number>,
      ReadonlyArray<number>,
    ]
  >([
    [
      "nothing needs an environment",
      [registered(threadRoot(500, 5_000))],
      [bucket("b", [{ field: "exe", op: "equals", value: "x" }])],
      [],
      [],
    ],
    ["a split root's descendants, not the root", [split], [], [], [501, 502]],
    ["a split root's descendants not yet read", [split], [], [501], [502]],
    [
      "an unsplit shared root",
      [
        registered({
          pid: 500,
          startTimeMs: 5_000,
          owner: { type: "shared", provider: "codex", label: "x" },
        }),
      ],
      [],
      [],
      [],
    ],
    [
      "every unread row once a bucket has a thread rule",
      [],
      [bucket("b", [{ field: "thread", threadId: THREAD_A }])],
      [100, 600],
      [500, 501, 502],
    ],
  ])("%s", (_name, roots, buckets, known, expected) => {
    const tree = buildProcessTree(rows);
    expect(
      pids(
        environmentReadsNeeded({
          tree,
          roots,
          buckets,
          known: (entry) => known.includes(entry.pid),
        }),
      ),
    ).toEqual(expected);
  });
});

describe("expiredClaims and claimedProcessRoots", () => {
  const alive = (pid: number, startTimeMs: number) => pid === 600 && startTimeMs === 7_000;
  const processClaim = (id: string, pid: number) =>
    resolvedClaim(id, THREAD_A, { type: "process", pid, startTimeMs: 7_000 });
  const container = (id: string, extra: Omit<ResolvedClaim, "claim">) =>
    resolvedClaim(id, THREAD_A, { type: "container", id: "abc" }, { containerId: "abc", ...extra });

  it.each<[string, ResolvedClaim, boolean]>([
    ["a live process", processClaim("c", 600), false],
    ["an exited process", processClaim("c", 601), true],
    [
      "a container whose cgroup dir is gone",
      container("c", { cgroup: "/gone", init: { pid: 600, startTimeMs: 7_000 } }),
      true,
    ],
    [
      "a container whose init changed identity",
      container("c", { cgroup: "/here", init: { pid: 600, startTimeMs: 9_000 } }),
      true,
    ],
    [
      "a live container",
      container("c", { cgroup: "/here", init: { pid: 600, startTimeMs: 7_000 } }),
      false,
    ],
    ["an unmeasurable container", container("c", {}), false],
    [
      "a cgroup claim whose dir is gone",
      resolvedClaim("c", THREAD_A, { type: "cgroup", path: "/gone" }, { cgroup: "/gone" }),
      true,
    ],
  ])("%s → expired %s", (_name, claim, expired) => {
    const result = expiredClaims({
      claims: [claim],
      isAlive: alive,
      cgroupExists: (path) => path === "/here",
    });
    expect(result.has(claim.claim.id)).toBe(expired);
  });

  it("skips process and init checks when the process table is unreadable", () => {
    const claims = [
      processClaim("p", 601),
      container("c", { cgroup: "/here", init: { pid: 600, startTimeMs: 9_000 } }),
      container("gone", { cgroup: "/gone" }),
    ];
    const result = expiredClaims({
      claims,
      isAlive: undefined,
      cgroupExists: (path) => path === "/here",
    });
    expect([...result]).toEqual(["gone"]);
  });

  it("hands the monitor process claims only", () => {
    expect(
      claimedProcessRoots([
        processClaim("p", 600),
        container("c", { cgroup: "/here" }),
        processClaim("q", 601),
      ]),
    ).toEqual([
      { pid: 600, startTimeMs: 7_000 },
      { pid: 601, startTimeMs: 7_000 },
    ]);
  });
});

const SELF = "/user.slice/t3.service";
const PARENT = 3_000_001;
const TARGET = 3_000_010;
const TARGET_CHILD = 3_000_011;
const INIT = 3_000_100;
const FULL_ID = "f".repeat(64);
const CONTAINER_CGROUP = `/system.slice/docker-${FULL_ID}.scope`;
const SERVICE_MONITOR = 3_000_200;

const hello: ResourceMonitorHelloEvent = {
  version: 4,
  type: "hello",
  sidecarVersion: "0.4.0",
  sidecarPid: SERVICE_MONITOR,
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
    hostProcesses: true,
  },
};

interface Fakes {
  table: Array<ResourceMonitorProcessTableEntry> | null;
  docker: (
    id: string,
    host: string | undefined,
  ) => Effect.Effect<{ id: string; pid: number; running: boolean } | null, MachineClaimError>;
  readonly pidCgroups: Map<number, string>;
  readonly cgroups: Set<string>;
  readonly env: Map<number, ThreadId | null>;
  readonly calls: {
    docker: Array<[string, string | undefined]>;
    cgroupReads: Array<number>;
    env: Array<ReadonlyArray<number>>;
    tableReads: number;
    claimed: Array<ReadonlyArray<{ readonly pid: number; readonly startTimeMs?: number }>>;
    settingsPatches: Array<ServerSettingsPatch>;
  };
}

const baseTable = (): Array<ResourceMonitorProcessTableEntry> => [
  { pid: PARENT, ppid: 1, name: "systemd", startTimeMs: 100 },
  { pid: process.pid, ppid: PARENT, name: "node", startTimeMs: 200 },
  { pid: SERVICE_MONITOR, ppid: process.pid, name: "t3-resource-monitor", startTimeMs: 300 },
  { pid: TARGET, ppid: 1, name: "cargo", startTimeMs: 7_000 },
  { pid: TARGET_CHILD, ppid: TARGET, name: "rustc", startTimeMs: 7_100 },
  { pid: INIT, ppid: 1, name: "tini", startTimeMs: 9_000 },
];

function serviceTest<A, E>(
  body: (input: {
    readonly ownership: ProcessOwnershipShape;
    readonly fakes: Fakes;
    readonly settings: ServerSettingsService["Service"];
    readonly registerRoot: (root: ProcessRoot) => void;
  }) => Effect.Effect<A, E, never>,
  options: { readonly platform?: NodeJS.Platform } = {},
) {
  const fakes: Fakes = {
    table: baseTable(),
    docker: () => Effect.succeed(null),
    pidCgroups: new Map([[INIT, CONTAINER_CGROUP]]),
    cgroups: new Set([CONTAINER_CGROUP]),
    env: new Map(),
    calls: {
      docker: [],
      cgroupReads: [],
      env: [],
      tableReads: 0,
      claimed: [],
      settingsPatches: [],
    },
  };
  const io: ProcessOwnershipIo = {
    dockerInspect: (id, host) =>
      Effect.suspend(() => {
        fakes.calls.docker.push([id, host]);
        return fakes.docker(id, host);
      }),
    readPidCgroup: (pid) => {
      fakes.calls.cgroupReads.push(pid);
      return fakes.pidCgroups.get(pid);
    },
    cgroupExists: (path) => fakes.cgroups.has(path),
    selfCgroup: SELF,
    readThreadEnv: (pids) =>
      Effect.sync(() => {
        fakes.calls.env.push([...pids]);
        return new Map(
          pids.flatMap((pid) => (fakes.env.has(pid) ? [[pid, fakes.env.get(pid)!] as const] : [])),
        );
      }),
  };
  const native = NativeTelemetryClient.layerTest({
    processTable: Effect.suspend(() => {
      fakes.calls.tableReads++;
      return fakes.table === null
        ? Effect.fail(new NativeTelemetryClient.NativeTelemetryUnavailable({ reason: "test" }))
        : Effect.succeed([...fakes.table]);
    }),
    health: Effect.succeed({
      status: "healthy",
      hello: Option.some(hello),
      lastSampleAt: Option.none(),
      lastError: Option.none(),
      restartCount: 0,
      sampleIntervalMs: 1_000,
    }),
    setClaimedProcesses: (roots) =>
      Effect.sync(() => {
        fakes.calls.claimed.push(roots);
      }),
  });
  const countedSettings = Layer.effect(
    ServerSettingsService,
    Effect.gen(function* () {
      const inner = yield* ServerSettingsService;
      return ServerSettingsService.of({
        ...inner,
        updateSettings: (patch) => {
          fakes.calls.settingsPatches.push(patch);
          return inner.updateSettings(patch);
        },
      });
    }),
  ).pipe(Layer.provide(ServerSettingsService.layerTest()));
  const registry = makeProcessOwnershipRegistry({
    readPidCgroup: () => undefined,
    selfCgroup: SELF,
    now: () => 0,
  });
  return Effect.gen(function* () {
    const ownership = yield* makeWith(io);
    const settings = yield* ServerSettingsService;
    return yield* body({
      ownership,
      fakes,
      settings,
      registerRoot: (root) => void registry.registerRoot(root),
    });
  }).pipe(
    Effect.provide(Layer.mergeAll(native, countedSettings)),
    Effect.provideService(ProcessOwnershipRegistry, registry),
    Effect.provideService(HostProcess.Platform, options.platform ?? "linux"),
  );
}

const claimError = <A, R>(effect: Effect.Effect<A, MachineClaimError, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.reason));

const processTarget = (pid: number, startTimeMs: number): ClaimTarget => ({
  type: "process",
  pid,
  startTimeMs,
});
const user: MachineActor = { type: "user" };
const auto: MachineActor = { type: "auto", threadId: THREAD_A };

describe("ProcessOwnership service", () => {
  describe("claim", () => {
    it.effect.each<[string, ClaimTarget, MachineClaimError["reason"]]>([
      ["pid 1", processTarget(1, 0), "refused"],
      ["the resource monitor", processTarget(SERVICE_MONITOR, 300), "refused"],
      ["the server", processTarget(process.pid, 200), "refused"],
      ["a process the server runs under", processTarget(PARENT, 100), "refused"],
      ["a pid not running", processTarget(3_999_999, 7_000), "not-found"],
      ["a reused pid", processTarget(TARGET, 8_001), "not-found"],
      ["a cgroup holding the server", { type: "cgroup", path: SELF }, "refused"],
      ["a cgroup above the server", { type: "cgroup", path: "/user.slice" }, "refused"],
      ["the root cgroup", { type: "cgroup", path: "/" }, "refused"],
      [
        "a cgroup that does not exist",
        { type: "cgroup", path: "/system.slice/gone.service" },
        "not-found",
      ],
    ])("refuses %s: %s", ([_name, target, reason]) =>
      serviceTest(({ ownership, fakes }) =>
        Effect.gen(function* () {
          expect(yield* claimError(ownership.claim({ threadId: THREAD_A, target }, user))).toBe(
            reason,
          );
          expect(yield* ownership.claims).toEqual([]);
          expect(fakes.calls.claimed).toEqual([]);
        }),
      ),
    );

    it.effect("needs the monitor's process table to claim a process", () =>
      serviceTest(({ ownership, fakes }) =>
        Effect.gen(function* () {
          fakes.table = null;
          expect(
            yield* claimError(
              ownership.claim({ threadId: THREAD_A, target: processTarget(TARGET, 7_000) }, user),
            ),
          ).toBe("not-supported");
        }),
      ),
    );

    it.effect("needs Linux for a cgroup claim", () =>
      serviceTest(
        ({ ownership }) =>
          Effect.gen(function* () {
            expect(
              yield* claimError(
                ownership.claim(
                  { threadId: THREAD_A, target: { type: "cgroup", path: CONTAINER_CGROUP } },
                  user,
                ),
              ),
            ).toBe("not-supported");
          }),
        { platform: "darwin" },
      ),
    );

    it.effect("claims a process within the start-time tolerance and tells the monitor", () =>
      serviceTest(({ ownership, fakes }) =>
        Effect.gen(function* () {
          const claim = yield* ownership.claim(
            { threadId: THREAD_A, target: processTarget(TARGET, 7_900) },
            auto,
          );
          expect(claim).toMatchObject({
            threadId: THREAD_A,
            target: processTarget(TARGET, 7_900),
            createdBy: auto,
          });
          expect(claim).not.toHaveProperty("measurable");
          expect(yield* ownership.claims).toEqual([claim]);
          expect(fakes.calls.claimed).toEqual([[{ pid: TARGET, startTimeMs: 7_900 }]]);
        }),
      ),
    );

    it.effect("claims a cgroup and measures through it, without telling the monitor", () =>
      serviceTest(({ ownership, fakes }) =>
        Effect.gen(function* () {
          const target: ClaimTarget = { type: "cgroup", path: CONTAINER_CGROUP };
          const claim = yield* ownership.claim({ threadId: THREAD_A, target }, user);
          expect(yield* ownership.resolvedClaims).toEqual([{ claim, cgroup: CONTAINER_CGROUP }]);
          expect(fakes.calls.claimed).toEqual([[]]);
        }),
      ),
    );

    describe("containers", () => {
      const running = { id: FULL_ID, pid: INIT, running: true };

      it.effect(
        "inspects once, stores the full id and measures a local container through its cgroup",
        () =>
          serviceTest(({ ownership, fakes }) =>
            Effect.gen(function* () {
              fakes.docker = () => Effect.succeed(running);
              const claim = yield* ownership.claim(
                { threadId: THREAD_A, target: { type: "container", id: "web" } },
                user,
              );
              expect(claim.target).toEqual({ type: "container", id: FULL_ID });
              expect(claim).not.toHaveProperty("measurable");
              expect(yield* ownership.resolvedClaims).toEqual([
                {
                  claim,
                  containerId: FULL_ID,
                  cgroup: CONTAINER_CGROUP,
                  init: { pid: INIT, startTimeMs: 9_000 },
                },
              ]);
              yield* ownership.attribute([row(INIT, 1, 9_000, { containerId: FULL_ID })]);
              yield* TestClock.adjust(60_000);
              yield* ownership.claims;
              expect(fakes.calls.docker).toEqual([["web", undefined]]);
            }),
          ),
      );

      it.effect.each<[string, string | undefined, boolean, ReadonlyArray<number>]>([
        ["a unix socket is local", "unix:///var/run/docker.sock", true, [INIT]],
        ["a remote daemon is unmeasurable", "tcp://10.0.0.2:2375", false, []],
        ["an ssh daemon is unmeasurable", "ssh://box", false, []],
      ])("%s", ([_name, dockerHost, measured, reads]) =>
        serviceTest(({ ownership, fakes }) =>
          Effect.gen(function* () {
            fakes.docker = () => Effect.succeed(running);
            const target: ClaimTarget = {
              type: "container",
              id: "web",
              ...(dockerHost === undefined ? {} : { dockerHost }),
            };
            const claim = yield* ownership.claim({ threadId: THREAD_A, target }, user);
            expect(claim.target).toEqual({ ...target, id: FULL_ID });
            expect(claim.measurable).toBe(measured ? undefined : false);
            expect(fakes.calls.docker).toEqual([["web", dockerHost]]);
            expect(fakes.calls.cgroupReads).toEqual(reads);
          }),
        ),
      );

      it.effect("keeps a stopped container's claim, unmeasurable", () =>
        serviceTest(({ ownership, fakes }) =>
          Effect.gen(function* () {
            fakes.docker = () => Effect.succeed({ id: FULL_ID, pid: 0, running: false });
            const claim = yield* ownership.claim(
              { threadId: THREAD_A, target: { type: "container", id: "web" } },
              user,
            );
            expect(claim.measurable).toBe(false);
            expect(yield* ownership.resolvedClaims).toEqual([{ claim, containerId: FULL_ID }]);
          }),
        ),
      );

      it.effect.each<[string, Fakes["docker"], MachineClaimError["reason"]]>([
        ["no such container", () => Effect.succeed(null), "not-found"],
        [
          "docker unreachable",
          () =>
            Effect.fail(
              new MachineClaimError({ reason: "docker-unavailable", detail: "Cannot connect" }),
            ),
          "docker-unavailable",
        ],
        [
          "a container holding the server",
          () => Effect.succeed({ id: FULL_ID, pid: process.pid, running: true }),
          "refused",
        ],
      ])("%s → %s", ([_name, docker, reason]) =>
        serviceTest(({ ownership, fakes }) =>
          Effect.gen(function* () {
            fakes.docker = docker;
            fakes.pidCgroups.set(process.pid, SELF);
            expect(
              yield* claimError(
                ownership.claim(
                  { threadId: THREAD_A, target: { type: "container", id: "web" } },
                  user,
                ),
              ),
            ).toBe(reason);
            expect(fakes.calls.docker).toHaveLength(1);
          }),
        ),
      );

      it.effect(
        "lets several threads claim one container and gives its processes to the oldest claim",
        () =>
          serviceTest(({ ownership, fakes }) =>
            Effect.gen(function* () {
              fakes.docker = () => Effect.succeed(running);
              const first = yield* ownership.claim(
                { threadId: THREAD_A, target: { type: "container", id: "web" } },
                user,
              );
              yield* ownership.claim(
                { threadId: THREAD_B, target: { type: "container", id: FULL_ID } },
                user,
              );
              expect(yield* ownership.claims).toHaveLength(2);
              const initRow = row(INIT, 1, 9_000, {
                containerId: FULL_ID,
                cgroup: CONTAINER_CGROUP,
              });
              const owners = yield* ownership.attribute([initRow]);
              expect(owners.get(processKey(INIT, 9_000))).toEqual({
                type: "claimed",
                claimId: first.id,
                threadId: THREAD_A,
              });
            }),
          ),
      );
    });

    it.effect("holds at most 256 claims", () =>
      serviceTest(({ ownership, fakes }) =>
        Effect.gen(function* () {
          for (let index = 0; index <= 256; index++) fakes.cgroups.add(`/claims/${index}`);
          for (let index = 0; index < 256; index++) {
            yield* ownership.claim(
              { threadId: THREAD_A, target: { type: "cgroup", path: `/claims/${index}` } },
              user,
            );
          }
          expect(
            yield* claimError(
              ownership.claim(
                { threadId: THREAD_A, target: { type: "cgroup", path: "/claims/256" } },
                user,
              ),
            ),
          ).toBe("limit");
          expect(yield* ownership.claims).toHaveLength(256);
        }),
      ),
    );
  });

  describe("release", () => {
    it.effect(
      "releases one claim, is idempotent, and keeps the claims array until it changes",
      () =>
        serviceTest(({ ownership, fakes }) =>
          Effect.gen(function* () {
            const first = yield* ownership.claim(
              { threadId: THREAD_A, target: processTarget(TARGET, 7_000) },
              user,
            );
            const second = yield* ownership.claim(
              { threadId: THREAD_A, target: processTarget(TARGET_CHILD, 7_100) },
              user,
            );
            const before = yield* ownership.claims;
            expect(yield* ownership.claims).toBe(before);

            yield* ownership.release(first.id);
            const after = yield* ownership.claims;
            expect(after).toEqual([second]);
            expect(after).not.toBe(before);

            const notified = fakes.calls.claimed.length;
            yield* ownership.release(first.id);
            yield* ownership.release(claimId("never-existed"));
            expect(yield* ownership.claims).toBe(after);
            expect(fakes.calls.claimed).toHaveLength(notified);
            expect(fakes.calls.claimed.at(-1)).toEqual([{ pid: TARGET_CHILD, startTimeMs: 7_100 }]);
          }),
        ),
    );

    it.effect("releases every claim of a deleted thread and no other", () =>
      serviceTest(({ ownership }) =>
        Effect.gen(function* () {
          yield* ownership.claim(
            { threadId: THREAD_A, target: processTarget(TARGET, 7_000) },
            user,
          );
          yield* ownership.claim(
            { threadId: THREAD_A, target: { type: "cgroup", path: CONTAINER_CGROUP } },
            user,
          );
          const kept = yield* ownership.claim(
            { threadId: THREAD_B, target: processTarget(TARGET_CHILD, 7_100) },
            user,
          );
          yield* ownership.releaseThread(THREAD_A);
          expect(yield* ownership.claims).toEqual([kept]);
        }),
      ),
    );
  });

  describe("prune", () => {
    it.effect("runs at most once every 30 s", () =>
      serviceTest(({ ownership, fakes }) =>
        Effect.gen(function* () {
          yield* ownership.claims;
          yield* ownership.attribute([]);
          yield* ownership.prune;
          expect(fakes.calls.tableReads).toBe(1);
          yield* TestClock.adjust(29_999);
          yield* ownership.prune;
          expect(fakes.calls.tableReads).toBe(1);
          yield* TestClock.adjust(1);
          yield* ownership.claims;
          expect(fakes.calls.tableReads).toBe(2);
        }),
      ),
    );

    it.effect("ends a process claim once the process exits, and tells the monitor", () =>
      serviceTest(({ ownership, fakes }) =>
        Effect.gen(function* () {
          yield* ownership.claim(
            { threadId: THREAD_A, target: processTarget(TARGET, 7_000) },
            user,
          );
          yield* ownership.prune;
          expect(yield* ownership.claims).toHaveLength(1);

          fakes.table = baseTable().filter((entry) => entry.pid !== TARGET);
          yield* TestClock.adjust(30_000);
          expect(yield* ownership.claims).toEqual([]);
          expect(fakes.calls.claimed.at(-1)).toEqual([]);
        }),
      ),
    );

    it.effect("keeps process claims while the process table is unreadable", () =>
      serviceTest(({ ownership, fakes }) =>
        Effect.gen(function* () {
          yield* ownership.claim(
            { threadId: THREAD_A, target: processTarget(TARGET, 7_000) },
            user,
          );
          fakes.table = null;
          expect(yield* ownership.claims).toHaveLength(1);
        }),
      ),
    );

    it.effect.each<[string, (fakes: Fakes) => void]>([
      ["its cgroup dir is gone", (fakes) => fakes.cgroups.delete(CONTAINER_CGROUP)],
      [
        "its init changed identity",
        (fakes) => {
          fakes.table = baseTable().map((entry) =>
            entry.pid === INIT ? { ...entry, startTimeMs: 20_000 } : entry,
          );
        },
      ],
    ])("ends a container claim once %s, without inspecting again", ([_name, remove]) =>
      serviceTest(({ ownership, fakes }) =>
        Effect.gen(function* () {
          fakes.docker = () => Effect.succeed({ id: FULL_ID, pid: INIT, running: true });
          yield* ownership.claim(
            { threadId: THREAD_A, target: { type: "container", id: "web" } },
            user,
          );
          yield* ownership.prune;
          expect(yield* ownership.claims).toHaveLength(1);
          remove(fakes);
          yield* TestClock.adjust(30_000);
          expect(yield* ownership.claims).toEqual([]);
          expect(fakes.calls.docker).toHaveLength(1);
        }),
      ),
    );

    it.effect("drops exited pins in one settings write, provenance unchanged", () =>
      serviceTest(({ ownership, fakes, settings }) =>
        Effect.gen(function* () {
          const stored = yield* ownership.upsertBucket(
            {
              id: bucketId("pins"),
              name: "Pins",
              rules: [
                { field: "pid", pid: TARGET, startTimeMs: 7_000 },
                { field: "pid", pid: 3_999_999, startTimeMs: 1_000 },
              ],
            },
            auto,
          );
          yield* TestClock.adjust(5_000);
          fakes.calls.settingsPatches.length = 0;
          yield* ownership.prune;
          expect(fakes.calls.settingsPatches).toHaveLength(1);
          const current = (yield* settings.getSettings).machineResources.buckets[bucketId("pins")];
          expect(current).toEqual({ ...stored, rules: [stored.rules[0]] });

          yield* TestClock.adjust(30_000);
          yield* ownership.prune;
          expect(fakes.calls.settingsPatches).toHaveLength(1);
        }),
      ),
    );

    it.effect("keeps pins while the process table is unreadable", () =>
      serviceTest(({ ownership, fakes }) =>
        Effect.gen(function* () {
          yield* ownership.upsertBucket(
            {
              id: bucketId("pins"),
              name: "Pins",
              rules: [{ field: "pid", pid: 3_999_999, startTimeMs: 1_000 }],
            },
            user,
          );
          fakes.table = null;
          fakes.calls.settingsPatches.length = 0;
          yield* ownership.prune;
          expect(fakes.calls.settingsPatches).toEqual([]);
        }),
      ),
    );
  });

  describe("writeSettingsPatch", () => {
    const rules: MachineBucket["rules"] = [{ field: "exe", op: "equals", value: "cargo" }];

    it.effect("passes a patch without buckets through untouched", () =>
      serviceTest(({ ownership, settings }) =>
        Effect.gen(function* () {
          const patch: ServerSettingsPatch = { machineResources: { thresholds: {} } };
          const seen: Array<ServerSettingsPatch> = [];
          yield* ownership.writeSettingsPatch(patch, auto, (written) => {
            seen.push(written);
            return settings.updateSettings(written);
          });
          expect(seen[0]).toBe(patch);
        }),
      ),
    );

    it.effect("stamps bucket entries as the writer, replacing a client's provenance", () =>
      serviceTest(({ ownership, settings }) =>
        Effect.gen(function* () {
          yield* TestClock.adjust(5_000);
          const next = yield* ownership.writeSettingsPatch(
            {
              machineResources: {
                buckets: {
                  [bucketId("b")]: {
                    id: bucketId("b"),
                    name: "Builds",
                    rules,
                    provenance: { createdBy: auto, updatedBy: auto, updatedAt: LATER },
                  },
                },
              },
            },
            user,
            settings.updateSettings,
          );
          expect(next.machineResources.buckets[bucketId("b")]?.provenance).toEqual({
            createdBy: user,
            updatedBy: user,
            updatedAt: DateTime.makeUnsafe(5_000),
          });
        }),
      ),
    );

    it.effect("refuses an auto write to a bucket a user edited, without writing", () =>
      serviceTest(({ ownership, fakes }) =>
        Effect.gen(function* () {
          yield* ownership.upsertBucket({ id: bucketId("b"), name: "Builds", rules }, auto);
          yield* ownership.upsertBucket({ id: bucketId("b"), name: "Builds", rules }, user);
          fakes.calls.settingsPatches.length = 0;
          const upsert = yield* Effect.flip(
            ownership.upsertBucket({ id: bucketId("b"), name: "Mine", rules }, auto),
          );
          expect(upsert._tag).toBe("BucketEditedError");
          const remove = yield* Effect.flip(ownership.deleteBucket(bucketId("b"), auto));
          expect(remove._tag).toBe("BucketEditedError");
          expect(fakes.calls.settingsPatches).toEqual([]);
        }),
      ),
    );

    it.effect("lets auto keep maintaining its own bucket, keeping who created it", () =>
      serviceTest(({ ownership }) =>
        Effect.gen(function* () {
          yield* ownership.upsertBucket({ id: bucketId("b"), name: "Builds", rules }, auto);
          const other: MachineActor = { type: "auto", threadId: THREAD_B };
          const updated = yield* ownership.upsertBucket(
            { id: bucketId("b"), name: "Builds 2", rules },
            other,
          );
          expect(updated.provenance).toMatchObject({ createdBy: auto, updatedBy: other });
          yield* ownership.deleteBucket(bucketId("b"), other);
        }),
      ),
    );

    it.effect(
      "serialises bucket writes, so auto never overwrites an edit that landed while it waited",
      () =>
        serviceTest(({ ownership, settings }) =>
          Effect.gen(function* () {
            yield* ownership.upsertBucket({ id: bucketId("b"), name: "Builds", rules }, auto);
            const entered = yield* Deferred.make<void>();
            const gate = yield* Deferred.make<void>();
            const userWrite = yield* ownership
              .writeSettingsPatch(
                {
                  machineResources: {
                    buckets: { [bucketId("b")]: { id: bucketId("b"), name: "Mine", rules } },
                  },
                },
                user,
                (patch) =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(gate)),
                    Effect.andThen(settings.updateSettings(patch)),
                  ),
              )
              .pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            const autoWrite = yield* ownership
              .upsertBucket({ id: bucketId("b"), name: "Auto", rules }, auto)
              .pipe(Effect.exit, Effect.forkChild);
            yield* Deferred.succeed(gate, undefined);
            yield* Fiber.join(userWrite);
            const autoExit = yield* Fiber.join(autoWrite);
            expect(Exit.isFailure(autoExit)).toBe(true);
            expect(
              (yield* settings.getSettings).machineResources.buckets[bucketId("b")]?.name,
            ).toBe("Mine");
          }),
        ),
    );
  });

  describe("attribute", () => {
    it.effect("names the server and the monitor from its hello", () =>
      serviceTest(({ ownership }) =>
        Effect.gen(function* () {
          const owners = yield* ownership.attribute([
            row(process.pid, PARENT, 200),
            row(SERVICE_MONITOR, process.pid, 300),
          ]);
          expect(owners.get(processKey(process.pid, 200))).toEqual({ type: "t3", label: "server" });
          expect(owners.get(processKey(SERVICE_MONITOR, 300))).toEqual({
            type: "t3",
            label: "resource monitor",
          });
        }),
      ),
    );

    it.effect("reads a split root's environments once per identity, unreadable ones included", () =>
      serviceTest(({ ownership, fakes, registerRoot }) =>
        Effect.gen(function* () {
          registerRoot({
            pid: TARGET,
            startTimeMs: 7_000,
            owner: { type: "shared", provider: "codex", label: "app-server" },
            splitByEnv: true,
          });
          fakes.env.set(TARGET_CHILD, THREAD_B);
          const rows = [
            row(TARGET, 1, 7_000),
            row(TARGET_CHILD, TARGET, 7_100),
            row(3_000_012, TARGET, 7_200),
          ];
          const owners = yield* ownership.attribute(rows);
          expect(owners.get(processKey(TARGET_CHILD, 7_100))).toEqual(threadB);
          expect(owners.get(processKey(3_000_012, 7_200))).toMatchObject({ type: "shared" });
          yield* ownership.attribute(rows);
          expect(fakes.calls.env).toEqual([[TARGET_CHILD, 3_000_012]]);

          const reused = [rows[0]!, rows[1]!, row(3_000_012, TARGET, 9_000)];
          yield* ownership.attribute(reused);
          expect(fakes.calls.env).toEqual([[TARGET_CHILD, 3_000_012], [3_000_012]]);

          // A host-table call (rows with exe) without these processes keeps their entries.
          yield* ownership.attribute([row(3_000_099, 1, 9_500, { exe: "/usr/bin/top" })]);
          yield* ownership.attribute(reused);
          expect(fakes.calls.env).toEqual([[TARGET_CHILD, 3_000_012], [3_000_012]]);
        }),
      ),
    );

    it.effect("re-matches buckets after they change", () =>
      serviceTest(({ ownership }) =>
        Effect.gen(function* () {
          const cargo = row(TARGET, 1, 7_000, { exe: "/usr/bin/cargo" });
          yield* ownership.upsertBucket(
            {
              id: bucketId("b"),
              name: "Builds",
              rules: [{ field: "exe", op: "equals", value: "/usr/bin/cargo" }],
            },
            user,
          );
          expect((yield* ownership.attribute([cargo])).get(processKey(TARGET, 7_000))).toEqual({
            type: "bucket",
            bucketId: "b",
          });
          yield* ownership.upsertBucket(
            {
              id: bucketId("b"),
              name: "Builds",
              rules: [{ field: "exe", op: "equals", value: "/usr/bin/make" }],
            },
            user,
          );
          expect((yield* ownership.attribute([cargo])).get(processKey(TARGET, 7_000))).toEqual({
            type: "other",
          });
        }),
      ),
    );
  });

  it.effect("defaults to no claims, no owners and unstamped settings writes", () =>
    Effect.gen(function* () {
      const ownership = yield* ProcessOwnership;
      expect(yield* ownership.claims).toEqual([]);
      expect((yield* ownership.attribute([row(1, 0, 0)])).size).toBe(0);
      const reason = yield* claimError(
        ownership.claim({ threadId: THREAD_A, target: processTarget(TARGET, 7_000) }, user),
      );
      expect(reason).toBe("not-supported");
      const patch: ServerSettingsPatch = { machineResources: { buckets: {} } };
      const seen: Array<ServerSettingsPatch> = [];
      yield* ownership.writeSettingsPatch(patch, auto, (written) => {
        seen.push(written);
        return Effect.succeed(DEFAULT_SERVER_SETTINGS);
      });
      expect(seen).toEqual([patch]);
      expect(seen[0]).toBe(patch);
    }),
  );
});
