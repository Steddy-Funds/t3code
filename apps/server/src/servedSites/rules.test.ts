import { describe, expect, it } from "@effect/vitest";
import { SERVED_SITE_NAME_PATTERN } from "@t3tools/contracts";

import type { HookRun } from "./ServedSitesHost.ts";
import { chooseServePort, dedupeSiteName, interpretExpose, slugSiteName } from "./rules.ts";

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
      { _tag: "failed", error: "The public URL hook did not print exactly one https:// URL: nope" },
    ],
    [
      "two lines",
      exited(0, "https://a.example.com\nhttps://b.example.com\n"),
      { _tag: "failed", error: "The public URL hook did not print exactly one https:// URL" },
    ],
    [
      "an http line",
      exited(0, "http://web.example.com\n"),
      { _tag: "failed", error: "The public URL hook did not print exactly one https:// URL" },
    ],
    [
      "exit 3",
      exited(3, "", ` quota exceeded\n`),
      { _tag: "refused", error: "Public URL refused: quota exceeded" },
    ],
    [
      "another exit",
      exited(1, "https://web.example.com\n", "boom"),
      { _tag: "failed", error: "The public URL hook exited 1: boom" },
    ],
    [
      "another exit, no stderr",
      exited(2),
      { _tag: "failed", error: "The public URL hook exited 2" },
    ],
    [
      "a timeout",
      { _tag: "timed-out" },
      { _tag: "failed", error: "The public URL hook timed out." },
    ],
    [
      "a spawn failure",
      { _tag: "spawn-failed", detail: "ENOENT" },
      { _tag: "failed", error: "Could not run the public URL hook: ENOENT" },
    ],
  ])("%s", (_name, run, outcome) => {
    expect(interpretExpose(run)).toEqual(outcome);
  });

  it("keeps at most 500 chars of stderr", () => {
    const stderr = "x".repeat(600);
    expect(interpretExpose(exited(3, "", stderr))).toEqual({
      _tag: "refused",
      error: `Public URL refused: ${"x".repeat(500)}`,
    });
    expect(interpretExpose(exited(1, "", stderr))).toEqual({
      _tag: "failed",
      error: `The public URL hook exited 1: ${"x".repeat(500)}`,
    });
  });
});
