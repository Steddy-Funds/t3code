import { describe, expect, it } from "vite-plus/test";

import { SBS_FIND_MATCH_LIMIT, sbsFindMatches, sbsFindMatchesByLine, sbsFindStep } from "./sbsFind";

describe("sbsFindMatches", () => {
  it.each([
    { name: "an empty query", lines: ["abc"], query: "", expected: [] },
    { name: "no match", lines: ["abc"], query: "z", expected: [] },
    {
      name: "case-insensitive matches in reading order",
      lines: ["Foo bar", "none", "fOO foo"],
      query: "FOO",
      expected: [
        { line: 0, start: 0, end: 3 },
        { line: 2, start: 0, end: 3 },
        { line: 2, start: 4, end: 7 },
      ],
    },
    {
      name: "matches that do not overlap",
      lines: ["aaaa"],
      query: "aa",
      expected: [
        { line: 0, start: 0, end: 2 },
        { line: 0, start: 2, end: 4 },
      ],
    },
  ])("finds $name", ({ lines, query, expected }) => {
    expect(sbsFindMatches(lines, query)).toEqual({ matches: expected, truncated: false });
  });

  it.each([
    { count: SBS_FIND_MATCH_LIMIT, truncated: false },
    { count: SBS_FIND_MATCH_LIMIT + 1, truncated: true },
  ])("stops at $count lines of matches: truncated $truncated", ({ count, truncated }) => {
    const result = sbsFindMatches(
      Array.from({ length: count }, () => "x"),
      "x",
    );
    expect(result.matches).toHaveLength(SBS_FIND_MATCH_LIMIT);
    expect(result.truncated).toBe(truncated);
  });

  it("answers again from memory for the same lines and query", () => {
    const lines = ["alpha", "beta"];
    const first = sbsFindMatches(lines, "a");
    expect(sbsFindMatches(lines, "a")).toBe(first);
    expect(sbsFindMatches(lines, "b")).not.toBe(first);
    expect(sbsFindMatches([...lines], "b")).not.toBe(sbsFindMatches(lines, "b"));
  });
});

describe("sbsFindMatchesByLine", () => {
  it("groups the matches under their lines, once per result", () => {
    const result = sbsFindMatches(["ab ab", "x", "ab"], "ab");
    const byLine = sbsFindMatchesByLine(result);
    expect([...byLine.keys()]).toEqual([0, 2]);
    expect(byLine.get(0)).toEqual([
      { line: 0, start: 0, end: 2 },
      { line: 0, start: 3, end: 5 },
    ]);
    expect(sbsFindMatchesByLine(result)).toBe(byLine);
  });
});

describe("sbsFindStep", () => {
  it.each([
    { current: 0, count: 3, direction: 1, expected: 1 },
    { current: 2, count: 3, direction: 1, expected: 0 },
    { current: 1, count: 3, direction: -1, expected: 0 },
    { current: 0, count: 3, direction: -1, expected: 2 },
    { current: 0, count: 1, direction: 1, expected: 0 },
    { current: 0, count: 1, direction: -1, expected: 0 },
    { current: 0, count: 0, direction: 1, expected: -1 },
    { current: -1, count: 0, direction: -1, expected: -1 },
  ] as const)(
    "steps $direction from $current of $count to $expected",
    ({ current, count, direction, expected }) => {
      expect(sbsFindStep(current, count, direction)).toBe(expected);
    },
  );
});
