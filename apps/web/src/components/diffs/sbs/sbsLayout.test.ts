import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSbsLayout,
  sbsChangeRows,
  sbsFoldsCovering,
  sbsLayoutOf,
  sbsLineRow,
  sbsRangeRows,
  sbsRowCount,
  sbsRowTarget,
  type SbsLayout,
  type SbsLayoutOptions,
} from "./sbsLayout";
import { buildSbsDocument } from "./sbsModel";

const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line${index + 1}`);
const fileOf = (lines: ReadonlyArray<string>) => ({
  name: "file.txt",
  contents: lines.map((line) => `${line}\n`).join(""),
});

/** A file of `count` lines with the given lines edited. */
function documentWithEdits(count: number, ...edits: ReadonlyArray<number>) {
  const before = numbered(count);
  const after = before.map((line, index) => (edits.includes(index) ? `edited${index}` : line));
  return buildSbsDocument(parseDiffFromFile(fileOf(before), fileOf(after)));
}

function patchDocument(...hunks: ReadonlyArray<ReadonlyArray<string>>) {
  const patch = [
    "diff --git a/file.txt b/file.txt",
    "--- a/file.txt",
    "+++ b/file.txt",
    ...hunks.flat(),
    "",
  ].join("\n");
  const fileDiff: FileDiffMetadata = parsePatchFiles(patch)[0]!.files[0]!;
  return buildSbsDocument(fileDiff);
}

const COLLAPSED: SbsLayoutOptions = { collapseUnchanged: true, expandedFolds: new Set() };

/** Segments as `kind:rows-of-the-deletions-side` so a layout reads as one array. */
function shape(layout: SbsLayout): ReadonlyArray<string> {
  return layout.segments.map((segment) => {
    if (segment.kind === "change") return "change";
    if (segment.kind === "omitted") return `omitted:${segment.lines}`;
    return `${segment.kind}:${segment.deletions.end - segment.deletions.start}`;
  });
}

describe("buildSbsLayout folding", () => {
  it("folds 60 unchanged lines between two changes to 4 + fold + 4", () => {
    const layout = buildSbsLayout(documentWithEdits(100, 10, 71), COLLAPSED);
    expect(shape(layout)).toEqual([
      "fold:6",
      "lines:4",
      "change",
      "lines:4",
      "fold:52",
      "lines:4",
      "change",
      "lines:4",
      "fold:24",
    ]);
    expect(sbsRowCount(layout, "deletions")).toBe(21);
    expect(sbsRowCount(layout, "additions")).toBe(21);
  });

  it.each([
    { gap: 8, folded: false },
    { gap: 9, folded: false },
    { gap: 10, folded: true },
    { gap: 11, folded: true },
  ])("a gap of $gap unchanged lines folds: $folded", ({ gap, folded }) => {
    const layout = buildSbsLayout(documentWithEdits(gap + 10, 4, 5 + gap), COLLAPSED);
    expect(shape(layout)).toEqual([
      "lines:4",
      "change",
      ...(folded ? ["lines:4", `fold:${gap - 8}`, "lines:4"] : [`lines:${gap}`]),
      "change",
      "lines:4",
    ]);
  });

  it.each([
    {
      name: "far from both ends",
      edit: 20,
      expected: ["fold:16", "lines:4", "change", "lines:4", "fold:5"],
    },
    {
      name: "5 lines from the top, where only one line would hide",
      edit: 5,
      expected: ["lines:5", "change", "lines:4", "fold:20"],
    },
  ])("keeps the last 4 lines before and the first 4 after a change $name", ({ edit, expected }) => {
    expect(shape(buildSbsLayout(documentWithEdits(30, edit), COLLAPSED))).toEqual(expected);
  });

  it("never folds an identical file", () => {
    const document = buildSbsDocument(
      parseDiffFromFile(fileOf(numbered(50)), fileOf(numbered(50))),
    );
    expect(shape(buildSbsLayout(document, COLLAPSED))).toEqual(["lines:50"]);
  });

  it("folds nothing when asked not to collapse", () => {
    const layout = buildSbsLayout(documentWithEdits(100, 10, 71), {
      collapseUnchanged: false,
      expandedFolds: new Set(),
    });
    expect(shape(layout)).toEqual(["lines:10", "change", "lines:60", "change", "lines:28"]);
  });

  it("shows an expanded fold's lines and keeps the other folds", () => {
    const document = documentWithEdits(100, 10, 71);
    const layout = buildSbsLayout(document, { ...COLLAPSED, expandedFolds: new Set([1]) });
    expect(shape(layout)).toEqual([
      "fold:6",
      "lines:4",
      "change",
      "lines:60",
      "change",
      "lines:4",
      "fold:24",
    ]);
    expect(
      layout.segments.flatMap((segment) => (segment.kind === "fold" ? [segment.fold] : [])),
    ).toEqual([0, 2]);
  });

  it("keeps a different number of lines beside changes when asked", () => {
    const layout = buildSbsLayout(documentWithEdits(100, 10, 71), {
      ...COLLAPSED,
      contextLines: 2,
    });
    expect(shape(layout)).toEqual([
      "fold:8",
      "lines:2",
      "change",
      "lines:2",
      "fold:56",
      "lines:2",
      "change",
      "lines:2",
      "fold:26",
    ]);
  });

  it("gives an insertion no rows on the old side", () => {
    const before = numbered(30);
    const after = [...before.slice(0, 10), "new1", "new2", ...before.slice(10)];
    const layout = buildSbsLayout(
      buildSbsDocument(parseDiffFromFile(fileOf(before), fileOf(after))),
      { collapseUnchanged: false, expandedFolds: new Set() },
    );
    expect(sbsChangeRows(layout, 0, "deletions")).toEqual({ start: 10, end: 10 });
    expect(sbsChangeRows(layout, 0, "additions")).toEqual({ start: 10, end: 12 });
    expect(sbsRowCount(layout, "deletions")).toBe(30);
    expect(sbsRowCount(layout, "additions")).toBe(32);
  });
});

describe("buildSbsLayout of a patch only", () => {
  it("puts an omitted row before each hunk that skips lines, after an insertion that ends a hunk", () => {
    const layout = buildSbsLayout(
      patchDocument(
        ["@@ -3,2 +3,3 @@", " c3", " c4", "+ins"],
        ["@@ -20,3 +21,3 @@", " c20", "-old", "+new", " c22"],
      ),
      COLLAPSED,
    );
    expect(shape(layout)).toEqual([
      "omitted:2",
      "lines:2",
      "change",
      "omitted:15",
      "lines:1",
      "change",
      "lines:1",
    ]);
    expect(layout.rows.deletions).toEqual([0, 1, 3, 3, 4, 5, 6, 7]);
    expect(layout.rows.additions).toEqual([0, 1, 3, 4, 5, 6, 7, 8]);
    const insertion = layout.changeSegments[0]!;
    expect(layout.segments[insertion + 1]).toMatchObject({ kind: "omitted", lines: 15 });
  });

  it("has no omitted row before a hunk at the top of the file or one that follows directly", () => {
    const layout = buildSbsLayout(
      patchDocument(
        ["@@ -1,3 +1,3 @@", " c1", "-old", "+new", " c3"],
        ["@@ -10,3 +10,3 @@", " c10", "-x", "+y", " c12"],
        ["@@ -13,2 +13,2 @@", " c13", "-z", "+w"],
      ),
      COLLAPSED,
    );
    expect(shape(layout)).toEqual([
      "lines:1",
      "change",
      "lines:1",
      "omitted:6",
      "lines:1",
      "change",
      "lines:2",
      "change",
    ]);
  });

  it("never folds across an omitted row", () => {
    const layout = buildSbsLayout(
      patchDocument(["@@ -30,3 +30,3 @@", " a", "-old", "+new", " b"]),
      COLLAPSED,
    );
    expect(shape(layout)).toEqual(["omitted:29", "lines:1", "change", "lines:1"]);
  });
});

describe("sbsLayoutOf", () => {
  it("returns the same layout for the same options, however the folds are given", () => {
    const document = documentWithEdits(100, 10, 71);
    const first = sbsLayoutOf(document, { ...COLLAPSED, expandedFolds: new Set([2, 0]) });
    expect(sbsLayoutOf(document, { ...COLLAPSED, expandedFolds: new Set([0, 2]) })).toBe(first);
    expect(sbsLayoutOf(document, COLLAPSED)).toBe(sbsLayoutOf(document, COLLAPSED));
    expect(sbsLayoutOf(document, COLLAPSED)).not.toBe(first);
    expect(sbsLayoutOf(document, { ...COLLAPSED, collapseUnchanged: false })).not.toBe(
      sbsLayoutOf(document, COLLAPSED),
    );
  });
});

describe("row helpers", () => {
  // Rows: fold 0, lines 1-4, change 5, lines 6-9, fold 10, lines 11-14, change 15, lines 16-19, fold 20.
  const document = documentWithEdits(100, 10, 71);
  const layout = buildSbsLayout(document, COLLAPSED);

  it.each([
    { row: -1, expected: null },
    { row: 0, expected: { segment: 0, line: null } },
    { row: 1, expected: { segment: 1, line: 6 } },
    { row: 5, expected: { segment: 2, line: 10 } },
    { row: 10, expected: { segment: 4, line: null } },
    { row: 20, expected: { segment: 8, line: null } },
    { row: 21, expected: null },
  ])("names what row $row shows", ({ row, expected }) => {
    expect(sbsRowTarget(layout, "additions", row)).toEqual(expected);
  });

  it.each([
    { line: 0, expected: { segment: 0, row: 0, folded: true } },
    { line: 5, expected: { segment: 0, row: 0, folded: true } },
    { line: 6, expected: { segment: 1, row: 1, folded: false } },
    { line: 10, expected: { segment: 2, row: 5, folded: false } },
    { line: 30, expected: { segment: 4, row: 10, folded: true } },
    { line: 99, expected: { segment: 8, row: 20, folded: true } },
    { line: 100, expected: { segment: 8, row: 21, folded: false } },
  ])("puts line $line on a row", ({ line, expected }) => {
    expect(sbsLineRow(layout, "deletions", line)).toEqual(expected);
  });

  it.each([
    { name: "a line", range: { start: 10, end: 11 }, expected: { start: 5, end: 6 } },
    { name: "an empty range", range: { start: 10, end: 10 }, expected: { start: 5, end: 5 } },
    { name: "a range across a fold", range: { start: 2, end: 8 }, expected: { start: 0, end: 3 } },
    {
      name: "the lines after a change",
      range: { start: 11, end: 15 },
      expected: { start: 6, end: 10 },
    },
  ])("gives $name its rows", ({ range, expected }) => {
    expect(sbsRangeRows(layout, "additions", range)).toEqual(expected);
  });

  it("gives the rows of each change, and none for a change that is not there", () => {
    expect(sbsChangeRows(layout, 0, "deletions")).toEqual({ start: 5, end: 6 });
    expect(sbsChangeRows(layout, 1, "additions")).toEqual({ start: 15, end: 16 });
    expect(sbsChangeRows(layout, 2, "additions")).toEqual({ start: 0, end: 0 });
  });

  it.each([
    { name: "a shown line", range: { start: 10, end: 11 }, expected: [] },
    { name: "a folded line", range: { start: 2, end: 3 }, expected: [0] },
    { name: "an empty range inside a fold", range: { start: 30, end: 30 }, expected: [1] },
    { name: "a range across all folds", range: { start: 0, end: 100 }, expected: [0, 1, 2] },
    { name: "the line just past a fold", range: { start: 6, end: 7 }, expected: [] },
  ])("lists the folds that hide $name", ({ range, expected }) => {
    expect(sbsFoldsCovering(layout, "deletions", range)).toEqual(expected);
  });
});
