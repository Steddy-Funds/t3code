import { describe, expect, it } from "@effect/vitest";
import { SERVED_SITE_NAME_PATTERN } from "@t3tools/contracts";

import type { HookRun } from "./ServedSitesHost.ts";
import {
  chooseServePort,
  dedupeSiteName,
  interpretExpose,
  servesPort,
  slugSiteName,
  stoppableProcessTree,
} from "./rules.ts";

describe("slugSiteName", () => {
  it.each([
    ["My App!", "my-app"],
    ["--Vite  Dev--", "vite-dev"],
    ["", "site"],
    ["!!!", "site"],
    // Cut at 40 first, then the trailing hyphen the cut left goes.
    [`${"a".repeat(39)} tail`, "a".repeat(39)],
  ])("%j → %j", (raw, slug) => {
    expect(slugSiteName(raw)).toBe(slug);
    expect(slug).toMatch(SERVED_SITE_NAME_PATTERN);
  });
});

describe("dedupeSiteName", () => {
  it("adds -2, -3 and keeps a 40-char name within the label", () => {
    const long = "a".repeat(40);
    expect(dedupeSiteName("web", new Set())).toBe("web");
    expect(dedupeSiteName("web", new Set(["web"]))).toBe("web-2");
    expect(dedupeSiteName("web", new Set(["web", "web-2"]))).toBe("web-3");
    const second = dedupeSiteName(long, new Set([long]));
    expect(second).toBe(`${"a".repeat(38)}-2`);
    const third = dedupeSiteName(long, new Set([long, second]));
    expect(third).toBe(`${"a".repeat(38)}-3`);
    // A cut that lands on a hyphen does not leave a double hyphen.
    const hyphened = `${"a".repeat(37)}-bb`;
    expect(dedupeSiteName(hyphened, new Set([hyphened]))).toBe(`${"a".repeat(37)}-2`);
    for (const name of [second, third]) expect(name).toMatch(SERVED_SITE_NAME_PATTERN);
  });
});

describe("chooseServePort", () => {
  it("keeps a free local port, else takes the first free from 10000", () => {
    expect(chooseServePort(3000, new Set([443]))).toBe(3000);
    expect(chooseServePort(3000, new Set([3000]))).toBe(10_000);
    expect(chooseServePort(3000, new Set([3000, 10_000, 10_001]))).toBe(10_002);
    expect(chooseServePort(10_000, new Set([10_000]))).toBe(10_001);
  });
});

describe("interpretExpose", () => {
  const exited = (code: number, stdout = "", stderr = ""): HookRun => ({
    _tag: "exited",
    code,
    stdout,
    stderr,
  });

  it.each<[string, HookRun, ReturnType<typeof interpretExpose>]>([
    [
      "one https line",
      exited(0, "\n  https://web.example.com  \n\n"),
      { _tag: "exposed", url: "https://web.example.com" },
    ],
    [
      "no line",
      exited(0, "\n", "nope"),
      {
        _tag: "failed",
        error: "Expose hook failed.\nIt did not print exactly one https:// URL: nope",
      },
    ],
    [
      "two lines",
      exited(0, "https://a.example.com\nhttps://b.example.com\n"),
      { _tag: "failed", error: "Expose hook failed.\nIt did not print exactly one https:// URL" },
    ],
    [
      "an http line",
      exited(0, "http://web.example.com\n"),
      { _tag: "failed", error: "Expose hook failed.\nIt did not print exactly one https:// URL" },
    ],
    [
      "exit 3",
      exited(3, "", ` quota exceeded\n`),
      { _tag: "refused", error: "Public URL refused by the expose hook.\nquota exceeded" },
    ],
    [
      "exit 3, no stderr",
      exited(3),
      { _tag: "refused", error: "Public URL refused by the expose hook." },
    ],
    [
      "another exit",
      exited(1, "https://web.example.com\n", "boom"),
      { _tag: "failed", error: "Expose hook failed.\nIt exited 1: boom" },
    ],
    [
      "another exit, no stderr",
      exited(2),
      { _tag: "failed", error: "Expose hook failed.\nIt exited 2" },
    ],
    ["a timeout", { _tag: "timed-out" }, { _tag: "failed", error: "Expose hook timed out." }],
    [
      "a spawn failure",
      { _tag: "spawn-failed", detail: "ENOENT" },
      { _tag: "failed", error: "Expose hook failed.\nCould not run it: ENOENT" },
    ],
  ])("%s", (_name, run, outcome) => {
    expect(interpretExpose(run)).toEqual(outcome);
  });

  it("keeps at most 500 chars of stderr", () => {
    const stderr = "x".repeat(600);
    expect(interpretExpose(exited(3, "", stderr))).toEqual({
      _tag: "refused",
      error: `Public URL refused by the expose hook.\n${"x".repeat(500)}`,
    });
    expect(interpretExpose(exited(1, "", stderr))).toEqual({
      _tag: "failed",
      error: `Expose hook failed.\nIt exited 1: ${"x".repeat(500)}`,
    });
  });
});

describe("servesPort", () => {
  // init → systemd --user (10) → tmux (20) → npm (30) → node listener (40) → worker (50)
  const table = [
    { pid: 10, ppid: 1, name: "systemd" },
    { pid: 20, ppid: 10, name: "tmux" },
    { pid: 30, ppid: 20, name: "npm" },
    { pid: 40, ppid: 30, name: "node" },
    { pid: 50, ppid: 40, name: "worker" },
    { pid: 60, ppid: 20, name: "zsh" },
  ];

  it.each<[string, number, boolean]>([
    ["the listener", 40, true],
    ["a descendant", 50, true],
    ["its parent", 30, false],
    ["a far ancestor (the tmux server)", 20, false],
    ["an unrelated process", 60, false],
  ])("%s", (_name, pid, accepted) => {
    expect(servesPort(table, pid, [40])).toBe(accepted);
  });
});

describe("stoppableProcessTree", () => {
  // 50 → T3 server (100) → agent CLI (110) → its shell (120), which started two servers in one
  // process group: npm (130) → node (131) → worker (132), and docs (140).
  const SERVER = 100;
  const START = 1_000;
  const table = [
    { pid: 50, ppid: 1, name: "systemd", startTimeMs: START },
    { pid: SERVER, ppid: 50, name: "t3", startTimeMs: START },
    { pid: 110, ppid: SERVER, name: "claude", startTimeMs: START },
    { pid: 120, ppid: 110, name: "bash", startTimeMs: START },
    { pid: 130, ppid: 120, name: "npm", startTimeMs: START },
    { pid: 131, ppid: 130, name: "node", startTimeMs: START },
    { pid: 132, ppid: 131, name: "worker", startTimeMs: START },
    { pid: 140, ppid: 120, name: "docs", startTimeMs: START },
  ];
  const pinned = (...pids: ReadonlyArray<number>) =>
    pids.map((pid) => ({ pid, startTimeMs: START }));

  it.each<
    [string, ReadonlyArray<{ pid: number; startTimeMs: number }>, ReadonlyArray<number> | null]
  >([
    ["the listener and its descendants, not a sibling in its group", pinned(131), [131, 132]],
    ["a pinned wrapper's descendants", pinned(130), [130, 131, 132]],
    ["the other site alone", pinned(140), [140]],
    ["nothing for a pid reused by a later process", [{ pid: 131, startTimeMs: START + 5_000 }], []],
    ["no agent CLI", pinned(110), null],
    ["no ancestor of the T3 server", pinned(50), null],
  ])("%s", (_name, roots, expected) => {
    const tree = stoppableProcessTree(table, roots, SERVER);
    expect(tree === null ? null : tree.map((entry) => entry.pid).toSorted()).toEqual(expected);
  });
});
