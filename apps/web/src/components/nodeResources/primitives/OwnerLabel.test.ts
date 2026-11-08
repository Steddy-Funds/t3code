import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type ClaimId,
  type MachineBucketId,
  type OwnerLabel,
  type OwnerNames,
  type ProcessOwner,
  ownerLabel,
  sharedText,
} from "./OwnerLabel";

const KNOWN = ThreadId.make("thread-known-1234");
const UNKNOWN = ThreadId.make("abcdef0123456789");
const BUCKET = "bucket-builds" as MachineBucketId;
const GONE = "bucket-gone" as MachineBucketId;
const CONTAINER = "0123456789abcdef0123456789abcdef";

const names: OwnerNames = {
  threadTitle: (threadId) => (threadId === KNOWN ? "Native monitor v4" : undefined),
  bucketName: (bucketId) => (bucketId === BUCKET ? "Builds" : undefined),
};

describe("ownerLabel", () => {
  const cases: ReadonlyArray<[string, ProcessOwner, OwnerLabel]> = [
    [
      "known thread",
      { type: "thread", threadId: KNOWN },
      { kind: "thread", text: "Native monitor v4" },
    ],
    [
      "unknown thread falls back to the first 8 of its id",
      { type: "thread", threadId: UNKNOWN },
      { kind: "thread", text: "thread abcdef01" },
    ],
    [
      "thread terminal",
      { type: "thread", threadId: KNOWN, terminalId: "term-1" },
      { kind: "thread", text: "Native monitor v4", detail: "Native monitor v4 · terminal" },
    ],
    [
      "unknown thread terminal",
      { type: "thread", threadId: UNKNOWN, terminalId: "term-1" },
      { kind: "thread", text: "thread abcdef01", detail: "thread abcdef01 · terminal" },
    ],
    [
      "shared by one thread",
      {
        type: "shared",
        provider: ProviderDriverKind.make("codex"),
        label: "app-server",
        threadCount: 1,
      },
      { kind: "shared", text: "shared (1 thread)", detail: "Codex app-server: shared (1 thread)" },
    ],
    [
      "shared by several threads",
      {
        type: "shared",
        provider: ProviderDriverKind.make("codex"),
        label: "app-server",
        threadCount: 3,
      },
      {
        kind: "shared",
        text: "shared (3 threads)",
        detail: "Codex app-server: shared (3 threads)",
      },
    ],
    [
      "shared by an unknown provider kind keeps the raw kind",
      {
        type: "shared",
        provider: ProviderDriverKind.make("mystery"),
        label: "mcp",
        threadCount: 2,
      },
      { kind: "shared", text: "shared (2 threads)", detail: "mystery mcp: shared (2 threads)" },
    ],
    ["t3", { type: "t3", label: "machine terminal" }, { kind: "t3", text: "machine terminal" }],
    [
      "claimed by a known thread",
      { type: "claimed", claimId: "claim-1" as ClaimId, threadId: KNOWN },
      { kind: "claimed", text: "Native monitor v4", detail: "Claimed by Native monitor v4" },
    ],
    [
      "claimed by an unknown thread",
      { type: "claimed", claimId: "claim-1" as ClaimId, threadId: UNKNOWN },
      { kind: "claimed", text: "thread abcdef01", detail: "Claimed by thread abcdef01" },
    ],
    ["known bucket", { type: "bucket", bucketId: BUCKET }, { kind: "bucket", text: "Builds" }],
    [
      "deleted bucket",
      { type: "bucket", bucketId: GONE },
      { kind: "bucket", text: "deleted bucket", detail: "bucket bucket-gone" },
    ],
    [
      "provider",
      { type: "provider", provider: ProviderDriverKind.make("claudeAgent") },
      { kind: "provider", text: "Claude" },
    ],
    [
      "unknown provider kind",
      { type: "provider", provider: ProviderDriverKind.make("mystery") },
      { kind: "provider", text: "mystery" },
    ],
    [
      "container shows the first 12 of its id, the full id in detail",
      { type: "container", id: CONTAINER },
      { kind: "container", text: "container 0123456789ab", detail: `container ${CONTAINER}` },
    ],
    [
      "other",
      { type: "other" },
      { kind: "other", text: "other", detail: "Not attributable to a thread or bucket" },
    ],
  ];

  it.each(cases)("%s", (_name, owner, expected) => {
    expect(ownerLabel(owner, names)).toEqual(expected);
  });
});

describe("sharedText", () => {
  it.each([
    [0, "shared (0 threads)"],
    [1, "shared (1 thread)"],
    [2, "shared (2 threads)"],
    [12, "shared (12 threads)"],
  ])("%i → %s", (count, text) => {
    expect(sharedText(count)).toBe(text);
  });
});
