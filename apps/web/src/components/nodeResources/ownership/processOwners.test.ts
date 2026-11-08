import type { MachineProcessRow } from "@t3tools/client-runtime/state/machineProcessFrames";
import {
  ClaimId,
  MachineBucketId,
  type ProcessOwner,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { OwnerNames } from "../primitives/OwnerLabel";
import {
  ownerGroupOf,
  ownerKey,
  ownersSummary,
  processMatches,
  topMemoryOwners,
  totalsBy,
} from "./processOwners";

const MIB = 1024 ** 2;
const THREAD_A = ThreadId.make("thread-aaaaaaaaaa");
const THREAD_B = ThreadId.make("thread-bbbbbbbbbb");
const BUCKET = MachineBucketId.make("bucket_builds");
const CODEX = ProviderDriverKind.make("codex");

const thread = (threadId: ThreadId): ProcessOwner => ({ type: "thread", threadId });
const claimed = (threadId: ThreadId): ProcessOwner => ({
  type: "claimed",
  claimId: ClaimId.make("claim-1"),
  threadId,
});
const bucket = (bucketId: MachineBucketId = BUCKET): ProcessOwner => ({ type: "bucket", bucketId });

const names: OwnerNames = {
  threadTitle: (threadId) => (threadId === THREAD_A ? "Fix the build" : undefined),
  bucketName: (bucketId) => (bucketId === BUCKET ? "Builds" : undefined),
};

let nextPid = 100;
const row = (
  owner: ProcessOwner | undefined,
  overrides: Partial<MachineProcessRow> = {},
): MachineProcessRow => {
  const pid = nextPid++;
  return {
    key: pid,
    pid,
    ppid: 1,
    startTimeMs: 0,
    name: `p${pid}`,
    user: "akiva",
    command: `/bin/p${pid}`,
    cpu: 1,
    rss: MIB,
    ...(owner === undefined ? {} : { owner }),
    ...overrides,
  };
};

describe("ownerKey", () => {
  it("gives a claim the key of its thread", () => {
    expect(ownerKey(claimed(THREAD_A))).toBe(ownerKey(thread(THREAD_A)));
    expect(ownerKey({ type: "thread", threadId: THREAD_A, terminalId: "t1" })).toBe(
      ownerKey(thread(THREAD_A)),
    );
    expect(ownerKey(claimed(THREAD_A))).not.toBe(ownerKey(thread(THREAD_B)));
  });

  it("puts no owner and other under one key", () => {
    expect(ownerKey(undefined)).toBe(ownerKey({ type: "other" }));
  });
});

describe("topMemoryOwners", () => {
  const owners: ReadonlyArray<ProcessOwner> = [
    thread(ThreadId.make("t-a")),
    thread(ThreadId.make("t-b")),
    thread(ThreadId.make("t-c")),
    thread(ThreadId.make("t-d")),
    thread(ThreadId.make("t-e")),
    thread(ThreadId.make("t-f")),
  ];

  it("keeps the five largest, coloured in key order rather than by rank", () => {
    const rows = owners.map((owner, index) => row(owner, { rss: (index + 1) * MIB }));
    expect(topMemoryOwners(rows).map(({ key, bytes, color }) => [key, bytes, color])).toEqual([
      ["thread:t-b", 2 * MIB, "--owner-1"],
      ["thread:t-c", 3 * MIB, "--owner-2"],
      ["thread:t-d", 4 * MIB, "--owner-3"],
      ["thread:t-e", 5 * MIB, "--owner-4"],
      ["thread:t-f", 6 * MIB, "--owner-5"],
    ]);
  });

  it("keeps each owner's colour when the same five trade ranks", () => {
    const rising = owners.slice(0, 5).map((owner, index) => row(owner, { rss: (index + 1) * MIB }));
    const falling = owners.slice(0, 5).map((owner, index) => row(owner, { rss: (5 - index) * MIB }));
    const colors = (rows: ReadonlyArray<MachineProcessRow>) =>
      Object.fromEntries(topMemoryOwners(rows).map(({ key, color }) => [key, color]));
    expect(colors(falling)).toEqual(colors(rising));
  });

  it("sums a thread with its claims and leaves out rows without an owner or with other", () => {
    const rows = [
      row(thread(THREAD_A), { rss: 2 * MIB }),
      row(claimed(THREAD_A), { rss: 3 * MIB }),
      row({ type: "other" }, { rss: 100 * MIB }),
      row(undefined, { rss: 100 * MIB }),
    ];
    expect(topMemoryOwners(rows)).toEqual([
      { key: `thread:${THREAD_A}`, owner: thread(THREAD_A), bytes: 5 * MIB, color: "--owner-1" },
    ]);
  });
});

describe("totalsBy", () => {
  const byOwner = (rows: ReadonlyArray<MachineProcessRow>) =>
    totalsBy(rows, (value) => (value.owner ? ownerKey(value.owner) : null));

  it("counts and sums CPU and memory, leaving out rows keyed null", () => {
    const totals = byOwner([
      row(bucket(), { cpu: 10, rss: MIB }),
      row(bucket(), { cpu: 5, rss: 2 * MIB }),
      row(undefined, { cpu: 99 }),
    ]);
    expect([...totals]).toEqual([[`bucket:${BUCKET}`, { count: 2, cpu: 15, rss: 3 * MIB }]]);
  });

  it.each<[string, ReadonlyArray<Partial<MachineProcessRow>>, unknown]>([
    [
      "sums measured GPU use",
      [
        { gpuUtil: 10, vram: MIB },
        { gpuUtil: 5, vram: 2 * MIB },
      ],
      { gpuUtil: 15, vram: 3 * MIB },
    ],
    [
      "is null once a later member is unmeasured",
      [
        { gpuUtil: 10, vram: MIB },
        { gpuUtil: null, vram: null },
      ],
      { gpuUtil: null, vram: null },
    ],
    [
      "stays null after an unmeasured first member",
      [
        { gpuUtil: null, vram: null },
        { gpuUtil: 10, vram: MIB },
      ],
      { gpuUtil: null, vram: null },
    ],
  ])("%s", (_name, members, expected) => {
    const [totals] = byOwner(members.map((overrides) => row(bucket(), overrides))).values();
    expect(totals).toMatchObject(expected as object);
  });

  it("has no GPU fields when the rows carry none", () => {
    const [totals] = byOwner([row(bucket()), row(bucket())]).values();
    expect(totals).not.toHaveProperty("gpuUtil");
    expect(totals).not.toHaveProperty("vram");
  });
});

describe("ownerGroupOf", () => {
  it("groups a claim with its thread, under the thread's name", () => {
    const groupOf = ownerGroupOf("thread", names);
    const fromThread = groupOf(row(thread(THREAD_A)));
    const fromClaim = groupOf(row(claimed(THREAD_A)));
    expect(fromClaim).toBe(fromThread);
    expect(fromThread).toEqual({ id: `thread:${THREAD_A}`, label: "Fix the build" });
    // A thread this client hasn't loaded shows a short id.
    expect(groupOf(row(thread(THREAD_B))).label).toBe("thread thread-b");
  });

  it("groups by thread with the other owners in groups of their own", () => {
    const groupOf = ownerGroupOf("thread", names);
    expect(groupOf(row(bucket())).label).toBe("Builds");
    expect(groupOf(row({ type: "provider", provider: CODEX })).id).toBe("provider:codex");
    expect(groupOf(row(undefined))).toEqual({ id: "other", label: "other" });
  });

  it("puts everything but buckets under No bucket when grouping by bucket", () => {
    const groupOf = ownerGroupOf("bucket", names);
    expect(groupOf(row(bucket()))).toEqual({ id: `bucket:${BUCKET}`, label: "Builds" });
    const noBucket = { id: "bucket:none", label: "No bucket" };
    for (const owner of [thread(THREAD_A), claimed(THREAD_A), { type: "other" } as const]) {
      expect(groupOf(row(owner))).toEqual(noBucket);
    }
    expect(groupOf(row(undefined))).toEqual(noBucket);
  });
});

describe("processMatches", () => {
  const sample = row(claimed(THREAD_A), {
    pid: 4242,
    name: "cargo",
    command: "cargo build --release",
    user: "builder",
  });

  it.each([
    ["an empty query", "  "],
    ["the name, ignoring case", "CARGO"],
    ["the command", "--release"],
    ["the PID", "4242"],
    ["the user", "builder"],
    ["the owner label", "fix the"],
    ["the thread id", "thread-aaaa"],
  ])("matches %s", (_name, query) => {
    expect(processMatches(sample, query, names)).toBe(true);
  });

  it("matches a bucket by name and by id", () => {
    const inBucket = row(bucket());
    expect(processMatches(inBucket, "builds", names)).toBe(true);
    expect(processMatches(inBucket, "bucket_bu", names)).toBe(true);
  });

  it("misses what no field holds", () => {
    expect(processMatches(sample, "postgres", names)).toBe(false);
    expect(processMatches(row(undefined), "other", names)).toBe(false);
  });
});

describe("ownersSummary", () => {
  it.each<[string, ReadonlyArray<ProcessOwner | undefined>, string | null]>([
    ["nothing for no owners", [], null],
    ["nothing for only other or none", [{ type: "other" }, undefined], null],
    ["the single owner", [thread(THREAD_A), claimed(THREAD_A), undefined], "Fix the build"],
    ["N threads", [thread(THREAD_A), thread(THREAD_B), { type: "other" }], "2 threads"],
    ["N owners", [thread(THREAD_A), bucket()], "2 owners"],
  ])("gives %s", (_name, owners, expected) => {
    expect(ownersSummary(owners, names)).toBe(expected);
  });
});
