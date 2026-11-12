import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSbsDocument,
  sbsDocumentOf,
  sbsGroupRanges,
  sbsLineIndex,
  sbsLineNumber,
} from "./sbsModel";

const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line${index + 1}`);
const fileOf = (lines: ReadonlyArray<string>) => ({
  name: "file.txt",
  contents: lines.map((line) => `${line}\n`).join(""),
});

function diffOf(before: ReadonlyArray<string> | null, after: ReadonlyArray<string> | null) {
  return parseDiffFromFile(before && fileOf(before), after && fileOf(after));
}

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

const edited = (...indices: ReadonlyArray<number>) =>
  numbered(60).map((line, index) => (indices.includes(index) ? `edited${index + 1}` : line));

const replacing = (start: number, count: number, ...replacement: ReadonlyArray<string>) => {
  const lines = numbered(60);
  lines.splice(start, count, ...replacement);
  return lines;
};

// A hunk that ends in an insertion, then one after 15 skipped lines.
const patchWithGaps = () =>
  patchDiffOf(
    ["@@ -3,2 +3,3 @@", " c3", " c4", "+ins"],
    ["@@ -20,3 +21,3 @@", " c20", "-old", "+new", " c22"],
  );

describe("buildSbsDocument changes", () => {
  it("counts 3 separate changes as 3 changes in 3 groups", () => {
    const document = buildSbsDocument(diffOf(numbered(60), edited(5, 30, 55)));
    expect(document.changes.map((change) => [change.kind, change.group])).toEqual([
      ["modified", 0],
      ["modified", 1],
      ["modified", 2],
    ]);
    expect(document.changes.map((change) => change.deletions.start)).toEqual([5, 30, 55]);
    expect(document.groupCount).toBe(3);
  });

  it("keeps a (2 deleted, 5 added) region Pierre reports as one block as one change", () => {
    const document = buildSbsDocument(
      diffOf(numbered(60), replacing(10, 2, "a", "b", "c", "d", "e")),
    );
    expect(document.changes).toEqual([
      {
        kind: "modified",
        deletions: { start: 10, end: 12 },
        additions: { start: 10, end: 15 },
        group: 0,
      },
    ]);
    expect(document.groupCount).toBe(1);
  });

  it("gives blocks Pierre splits one group, however many changes", () => {
    const whole = diffOf(numbered(60), replacing(10, 2, "a", "b", "c", "d", "e"));
    const [hunk] = whole.hunks;
    const block = hunk!.hunkContent.find((content) => content.type === "change")!;
    const split: FileDiffMetadata = {
      ...whole,
      hunks: [
        {
          ...hunk!,
          hunkContent: hunk!.hunkContent.flatMap((content) =>
            content === block && content.type === "change"
              ? [
                  { ...content, deletions: 2, additions: 0 },
                  {
                    ...content,
                    deletions: 0,
                    additions: 5,
                    deletionLineIndex: content.deletionLineIndex + 2,
                  },
                ]
              : [content],
          ),
        },
      ],
    };
    const document = buildSbsDocument(split);
    expect(document.changes).toEqual([
      {
        kind: "deleted",
        deletions: { start: 10, end: 12 },
        additions: { start: 10, end: 10 },
        group: 0,
      },
      {
        kind: "inserted",
        deletions: { start: 12, end: 12 },
        additions: { start: 10, end: 15 },
        group: 0,
      },
    ]);
    expect(document.groupCount).toBe(1);
    expect(sbsGroupRanges(document)).toEqual([
      { deletions: { start: 10, end: 12 }, additions: { start: 10, end: 15 } },
    ]);
  });

  it("starts a group after any unchanged line, also inside one hunk", () => {
    const document = buildSbsDocument(
      parseDiffFromFile(fileOf(["a", "b", "c", "d", "e"]), fileOf(["a", "B", "c", "D", "e"]), {
        ignoreWhitespace: true,
      }),
    );
    expect(document.changes.map((change) => change.group)).toEqual([0, 1]);
    expect(document.groupCount).toBe(2);
  });

  it.each([
    {
      name: "a pure insertion",
      before: numbered(60),
      after: replacing(10, 0, "new"),
      change: {
        kind: "inserted",
        deletions: { start: 10, end: 10 },
        additions: { start: 10, end: 11 },
      },
    },
    {
      name: "a pure deletion",
      before: numbered(60),
      after: replacing(10, 1),
      change: {
        kind: "deleted",
        deletions: { start: 10, end: 11 },
        additions: { start: 10, end: 10 },
      },
    },
    {
      name: "an insertion at the top",
      before: numbered(60),
      after: replacing(0, 0, "new"),
      change: {
        kind: "inserted",
        deletions: { start: 0, end: 0 },
        additions: { start: 0, end: 1 },
      },
    },
    {
      name: "a deletion at the end",
      before: numbered(60),
      after: numbered(59),
      change: {
        kind: "deleted",
        deletions: { start: 59, end: 60 },
        additions: { start: 59, end: 59 },
      },
    },
  ])(
    "reads $name as one change with an empty range on the other side",
    ({ before, after, change }) => {
      expect(buildSbsDocument(diffOf(before, after)).changes).toEqual([{ ...change, group: 0 }]);
    },
  );

  it.each([
    {
      name: "a new file",
      before: null,
      after: ["a", "b", "c"],
      lines: { deletions: [], additions: ["a", "b", "c"] },
      change: {
        kind: "inserted",
        deletions: { start: 0, end: 0 },
        additions: { start: 0, end: 3 },
      },
    },
    {
      name: "a deleted file",
      before: ["a", "b", "c"],
      after: null,
      lines: { deletions: ["a", "b", "c"], additions: [] },
      change: { kind: "deleted", deletions: { start: 0, end: 3 }, additions: { start: 0, end: 0 } },
    },
  ])("gives $name no lines on one side and one change over the other", (row) => {
    const document = buildSbsDocument(diffOf(row.before, row.after));
    expect(document.lines).toEqual(row.lines);
    expect(document.changes).toEqual([{ ...row.change, group: 0 }]);
    expect(document.groupCount).toBe(1);
  });

  it("finds no change in identical files", () => {
    const document = buildSbsDocument(diffOf(numbered(5), numbered(5)));
    expect(document.changes).toEqual([]);
    expect(document.groupCount).toBe(0);
    expect(document.lines.deletions).toEqual(numbered(5));
  });
});

describe("buildSbsDocument lines", () => {
  it("strips line endings, keeps a last line without one, and measures tabs at full width", () => {
    const document = buildSbsDocument(
      parseDiffFromFile(
        { name: "f.txt", contents: "one\r\ntwo\nthree" },
        { name: "f.txt", contents: "one\r\n\t\tdeeper\nthree" },
      ),
    );
    expect(document.lines.deletions).toEqual(["one", "two", "three"]);
    expect(document.lines.additions).toEqual(["one", "\t\tdeeper", "three"]);
    expect(document.maxColumns).toBe(2 * 4 + "deeper".length);
  });

  it.each([
    { count: 9, digits: 1 },
    { count: 10, digits: 2 },
    { count: 120, digits: 3 },
  ])("sizes the gutter for $count lines at $digits digits", ({ count, digits }) => {
    expect(buildSbsDocument(diffOf(numbered(count), numbered(count))).lineNumberDigits).toBe(
      digits,
    );
  });

  it("numbers lines from 1 across a whole file and finds them back", () => {
    const document = buildSbsDocument(diffOf(numbered(60), replacing(10, 0, "new")));
    expect(sbsLineNumber(document, "additions", 10)).toBe(11);
    expect(sbsLineNumber(document, "deletions", 10)).toBe(11);
    expect(sbsLineIndex(document, "additions", 11)).toBe(10);
    expect(sbsLineIndex(document, "additions", 61)).toBe(60);
    expect(sbsLineIndex(document, "additions", 62)).toBe(-1);
    expect(sbsLineIndex(document, "additions", 0)).toBe(-1);
  });
});

describe("buildSbsDocument of a patch only", () => {
  it("marks the document partial and records each hunk's gap", () => {
    const document = buildSbsDocument(patchWithGaps());
    expect(document.partial).toBe(true);
    expect(document.omitted).toEqual([
      { deletions: 0, additions: 0, lines: 2 },
      { deletions: 2, additions: 3, lines: 15 },
    ]);
  });

  it("has no gap before a hunk that starts at line 1", () => {
    const document = buildSbsDocument(
      patchDiffOf(["@@ -1,3 +1,3 @@", " c1", "-old", "+new", " c3"]),
    );
    expect(document.omitted).toEqual([]);
  });

  it("restarts line numbers at every hunk", () => {
    const document = buildSbsDocument(patchWithGaps());
    expect(document.lines.additions).toHaveLength(6);
    expect([0, 1, 2, 3, 4, 5].map((index) => sbsLineNumber(document, "additions", index))).toEqual([
      3, 4, 5, 21, 22, 23,
    ]);
    expect([0, 1, 2, 3, 4].map((index) => sbsLineNumber(document, "deletions", index))).toEqual([
      3, 4, 20, 21, 22,
    ]);
    expect(document.lineNumberDigits).toBe(2);
  });

  it.each([
    { lineNumber: 2, index: -1 },
    { lineNumber: 5, index: 2 },
    { lineNumber: 6, index: -1 },
    { lineNumber: 20, index: -1 },
    { lineNumber: 21, index: 3 },
    { lineNumber: 23, index: 5 },
    { lineNumber: 24, index: -1 },
  ])("finds additions line $lineNumber at index $index", ({ lineNumber, index }) => {
    expect(sbsLineIndex(buildSbsDocument(patchWithGaps()), "additions", lineNumber)).toBe(index);
  });
});

describe("sbsDocumentOf", () => {
  it("builds one document per diff object", () => {
    const first = diffOf(["a"], ["b"]);
    const second = { ...first };
    expect(sbsDocumentOf(first)).toBe(sbsDocumentOf(first));
    expect(sbsDocumentOf(second)).not.toBe(sbsDocumentOf(first));
  });
});
