import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import type { ReviewCommentContext } from "~/reviewCommentContext";

import {
  groupSbsReviewEntries,
  sbsCommentLines,
  sbsReviewAnnotationsOf,
  sbsShowsLines,
  type SbsReviewEntry,
} from "./sbsReviewAnnotations";

const entry = (
  kind: SbsReviewEntry["kind"],
  id: string,
  startLine: number,
  endLine: number,
  side: SbsReviewEntry["side"] = "additions",
): SbsReviewEntry => ({ kind, id, side, startLine, endLine });

const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line${index + 1}`);
const fileOf = (lines: ReadonlyArray<string>) => ({
  name: "file.txt",
  contents: lines.map((line) => `${line}\n`).join(""),
});
const wholeDiffOf = (before: ReadonlyArray<string>, after: ReadonlyArray<string>) =>
  parseDiffFromFile(fileOf(before), fileOf(after));

function patchDiffOf(...hunks: ReadonlyArray<ReadonlyArray<string>>): FileDiffMetadata {
  const patch = [
    "diff --git a/file.txt b/file.txt",
    "--- a/file.txt",
    "+++ b/file.txt",
    ...hunks.flat(),
    "",
  ].join("\n");
  return parsePatchFiles(patch)[0]!.files[0]!;
}

describe("groupSbsReviewEntries", () => {
  it("returns nothing for no entries", () => {
    expect(groupSbsReviewEntries([])).toEqual([]);
  });

  it("keeps one entry as one annotation over its lines", () => {
    const only = entry("note", "n1", 3, 5);
    expect(groupSbsReviewEntries([only])).toEqual([
      { id: "n1", side: "additions", startLine: 3, endLine: 5, data: { entries: [only] } },
    ]);
  });

  it.each([
    { name: "share a line", second: [4, 8], groups: 1 },
    { name: "are identical", second: [3, 4], groups: 1 },
    { name: "nest", second: [3, 3], groups: 1 },
    { name: "touch without sharing a line", second: [5, 6], groups: 2 },
    { name: "leave a gap", second: [9, 9], groups: 2 },
  ])("ranges that $name make $groups annotation(s)", ({ second, groups }) => {
    const annotations = groupSbsReviewEntries([
      entry("note", "a", 3, 4),
      entry("comment", "b", second[0]!, second[1]!),
    ]);
    expect(annotations).toHaveLength(groups);
  });

  it("never merges across sides", () => {
    const annotations = groupSbsReviewEntries([
      entry("note", "a", 3, 4, "additions"),
      entry("note", "b", 3, 4, "deletions"),
    ]);
    expect(annotations.map(({ id, side }) => [id, side])).toEqual([
      ["b", "deletions"],
      ["a", "additions"],
    ]);
  });

  it("orders a group note, comment, draft, selection, then by start line", () => {
    const entries = [
      entry("selection", "s", 1, 9),
      entry("draft", "d", 2, 3),
      entry("comment", "c2", 6, 7),
      entry("comment", "c1", 4, 5),
      entry("note", "n", 8, 9),
    ];
    const [annotation, ...rest] = groupSbsReviewEntries(entries);
    expect(rest).toEqual([]);
    expect(annotation!.data.entries.map(({ id }) => id)).toEqual(["n", "c1", "c2", "d", "s"]);
    expect(annotation!.id).toBe("n");
  });

  it("takes the id of the first entry in order, not the first on screen", () => {
    const [annotation] = groupSbsReviewEntries([
      entry("selection", "s", 1, 2),
      entry("draft", "d", 2, 2),
    ]);
    expect(annotation!.id).toBe("d");
  });

  it("spans the union of the group", () => {
    const [annotation] = groupSbsReviewEntries([
      entry("comment", "a", 10, 20),
      entry("note", "b", 12, 14),
      entry("draft", "c", 18, 25),
    ]);
    expect([annotation!.startLine, annotation!.endLine]).toEqual([10, 25]);
  });

  it("chains overlaps and splits groups apart from the chain", () => {
    const annotations = groupSbsReviewEntries([
      entry("comment", "c", 9, 12),
      entry("comment", "a", 1, 3),
      entry("comment", "b", 3, 6),
      entry("comment", "far", 20, 21),
    ]);
    expect(annotations.map(({ id, startLine, endLine }) => [id, startLine, endLine])).toEqual([
      ["a", 1, 6],
      ["c", 9, 12],
      ["far", 20, 21],
    ]);
  });

  it("does not depend on the order entries come in", () => {
    const entries = [
      entry("note", "n", 5, 6),
      entry("comment", "c", 6, 8),
      entry("draft", "d", 1, 2),
    ];
    expect(groupSbsReviewEntries(entries.toReversed())).toEqual(groupSbsReviewEntries(entries));
  });
});

describe("sbsReviewAnnotationsOf", () => {
  const fileDiff = wholeDiffOf(numbered(10), numbered(10).with(4, "edited"));
  const entries = [entry("note", "n", 2, 3), entry("selection", "s", 7, 8)];

  it("gives the same array for equal entries, even new objects", () => {
    const first = sbsReviewAnnotationsOf(fileDiff, entries);
    expect(first).toEqual(groupSbsReviewEntries(entries));
    expect(
      sbsReviewAnnotationsOf(
        fileDiff,
        entries.map((each) => ({ ...each })),
      ),
    ).toBe(first);
  });

  it.each([
    { name: "kind", change: { kind: "comment" as const } },
    { name: "id", change: { id: "other" } },
    { name: "side", change: { side: "deletions" as const } },
    { name: "start line", change: { startLine: 1 } },
    { name: "end line", change: { endLine: 9 } },
  ])("gives a new array when an entry's $name changes", ({ change }) => {
    const first = sbsReviewAnnotationsOf(fileDiff, entries);
    const changed = sbsReviewAnnotationsOf(fileDiff, [{ ...entries[0]!, ...change }, entries[1]!]);
    expect(changed).not.toBe(first);
    expect(changed).toEqual(groupSbsReviewEntries([{ ...entries[0]!, ...change }, entries[1]!]));
  });

  it("gives a new array when an entry is added or removed", () => {
    const first = sbsReviewAnnotationsOf(fileDiff, entries);
    expect(sbsReviewAnnotationsOf(fileDiff, [...entries, entry("draft", "d", 1, 1)])).not.toBe(
      first,
    );
    expect(sbsReviewAnnotationsOf(fileDiff, [entries[0]!])).not.toBe(first);
  });

  it("gives a new array for another fileDiff with the same entries", () => {
    const other = wholeDiffOf(numbered(10), numbered(10).with(4, "edited"));
    expect(sbsReviewAnnotationsOf(other, entries)).not.toBe(
      sbsReviewAnnotationsOf(fileDiff, entries),
    );
  });

  it("keeps the array of each fileDiff apart", () => {
    const other = wholeDiffOf(numbered(10), numbered(10).with(4, "edited"));
    const mine = sbsReviewAnnotationsOf(fileDiff, entries);
    const theirs = sbsReviewAnnotationsOf(other, entries);
    expect(sbsReviewAnnotationsOf(fileDiff, entries)).toBe(mine);
    expect(sbsReviewAnnotationsOf(other, entries)).toBe(theirs);
  });

  it("returns an empty list for no entries, and the same one again", () => {
    const first = sbsReviewAnnotationsOf(fileDiff, []);
    expect(first).toEqual([]);
    expect(sbsReviewAnnotationsOf(fileDiff, [])).toBe(first);
  });
});

describe("sbsCommentLines", () => {
  const commentOf = (
    diff: string,
    selection?: {
      start: number;
      side: "additions" | "deletions";
      end: number;
      endSide: "additions" | "deletions";
    },
  ): ReviewCommentContext => ({
    id: "c",
    sectionId: "unstaged",
    sectionTitle: "Unstaged",
    filePath: "file.txt",
    startIndex: 0,
    endIndex: 0,
    rangeLabel: "",
    text: "",
    diff,
    fenceLanguage: "diff",
    selection,
  });

  it.each([
    {
      name: "a selection on the additions side",
      selection: { start: 4, side: "additions" as const, end: 7, endSide: "additions" as const },
      lines: { side: "additions", startLine: 4, endLine: 7 },
    },
    {
      name: "a selection on the deletions side",
      selection: { start: 2, side: "deletions" as const, end: 3, endSide: "deletions" as const },
      lines: { side: "deletions", startLine: 2, endLine: 3 },
    },
    {
      name: "a selection dragged upward",
      selection: { start: 9, side: "additions" as const, end: 5, endSide: "additions" as const },
      lines: { side: "additions", startLine: 5, endLine: 9 },
    },
    {
      name: "a one-line selection",
      selection: { start: 6, side: "deletions" as const, end: 6, endSide: "deletions" as const },
      lines: { side: "deletions", startLine: 6, endLine: 6 },
    },
  ])("reads $name from the selection, ignoring the header", ({ selection, lines }) => {
    expect(sbsCommentLines(commentOf("@@ -100,2 +200,2 @@\n x\n x", selection))).toEqual(lines);
  });

  it.each([
    {
      name: "a range across sides ending on additions",
      selection: { start: 3, side: "deletions" as const, end: 12, endSide: "additions" as const },
      diff: "@@ -3,4 +10,5 @@\n x",
      lines: { side: "additions", startLine: 10, endLine: 14 },
    },
    {
      name: "a range across sides ending on deletions",
      selection: { start: 12, side: "additions" as const, end: 4, endSide: "deletions" as const },
      diff: "@@ -3,4 +10,5 @@\n x",
      lines: { side: "deletions", startLine: 3, endLine: 6 },
    },
    {
      name: "no selection, preferring additions",
      selection: undefined,
      diff: "@@ -3,4 +10,5 @@\n x",
      lines: { side: "additions", startLine: 10, endLine: 14 },
    },
    {
      name: "no selection and no added lines",
      selection: undefined,
      diff: "@@ -3,4 +2,0 @@\n-x",
      lines: { side: "deletions", startLine: 3, endLine: 6 },
    },
    {
      name: "an end side with no lines, falling back to the other side",
      selection: { start: 3, side: "additions" as const, end: 3, endSide: "deletions" as const },
      diff: "@@ -3,0 +4,2 @@\n+x\n+y",
      lines: { side: "additions", startLine: 4, endLine: 5 },
    },
    {
      name: "a one-line header range",
      selection: undefined,
      diff: "@@ -7,1 +7,1 @@\n-a\n+b",
      lines: { side: "additions", startLine: 7, endLine: 7 },
    },
  ])("reads the header for $name", ({ selection, diff, lines }) => {
    expect(sbsCommentLines(commentOf(diff, selection))).toEqual(lines);
  });

  it.each([
    { name: "neither side has lines", diff: "@@ -3,0 +4,0 @@" },
    { name: "the diff has no header", diff: "just words" },
    { name: "the diff is empty", diff: "" },
    { name: "the header has no counts", diff: "@@ -3 +4 @@\n x" },
  ])("is null when $name", ({ diff }) => {
    expect(sbsCommentLines(commentOf(diff))).toBeNull();
  });
});

describe("sbsShowsLines", () => {
  // 60 lines; 2 deleted at 11-12 and 5 added at 11-15, so additions run to 63.
  const replacement = numbered(60);
  replacement.splice(10, 2, "a", "b", "c", "d", "e");
  const whole = wholeDiffOf(numbered(60), replacement);

  it.each([
    { name: "a changed line", side: "additions", start: 12, end: 12, shown: true },
    {
      name: "an unchanged line far from a change",
      side: "additions",
      start: 40,
      end: 40,
      shown: true,
    },
    { name: "the first line", side: "deletions", start: 1, end: 1, shown: true },
    { name: "a range between two lines", side: "additions", start: 3, end: 50, shown: true },
    { name: "the last added line", side: "additions", start: 63, end: 63, shown: true },
    { name: "a deleted line", side: "deletions", start: 11, end: 12, shown: true },
    {
      name: "an added-side line the old side lacks",
      side: "deletions",
      start: 63,
      end: 63,
      shown: false,
    },
    { name: "the last old line", side: "deletions", start: 60, end: 60, shown: true },
    { name: "a line past the end", side: "additions", start: 64, end: 64, shown: false },
    { name: "an end past the end", side: "additions", start: 60, end: 64, shown: false },
    { name: "line 0", side: "additions", start: 0, end: 1, shown: false },
  ] as const)("a whole file has $name: $shown", ({ side, start, end, shown }) => {
    expect(sbsShowsLines(whole, { side, startLine: start, endLine: end })).toBe(shown);
  });

  // Additions 3-5 and 21-23, deletions 3-4 and 20-22.
  const patch = patchDiffOf(
    ["@@ -3,2 +3,3 @@", " c3", " c4", "+ins"],
    ["@@ -20,3 +21,3 @@", " c20", "-old", "+new", " c22"],
  );

  it.each([
    { name: "inside the first hunk", side: "additions", start: 3, end: 5, shown: true },
    { name: "inside the second hunk", side: "additions", start: 21, end: 23, shown: true },
    { name: "a line between hunks", side: "additions", start: 10, end: 10, shown: false },
    { name: "before the first hunk", side: "additions", start: 2, end: 2, shown: false },
    { name: "after the last hunk", side: "additions", start: 24, end: 24, shown: false },
    { name: "an end between hunks", side: "additions", start: 4, end: 10, shown: false },
    { name: "a start between hunks", side: "additions", start: 10, end: 22, shown: false },
    { name: "old lines of the second hunk", side: "deletions", start: 20, end: 22, shown: true },
    { name: "an old line past its hunk", side: "deletions", start: 23, end: 23, shown: false },
    {
      name: "an old line only the new side shows",
      side: "deletions",
      start: 5,
      end: 5,
      shown: false,
    },
    {
      name: "a new line the old side counts as a gap",
      side: "additions",
      start: 20,
      end: 20,
      shown: false,
    },
  ] as const)("a patch-only diff has $name: $shown", ({ side, start, end, shown }) => {
    expect(sbsShowsLines(patch, { side, startLine: start, endLine: end })).toBe(shown);
  });
});
