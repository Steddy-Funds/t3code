import { LineDiffRangeCache, parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { sbsLineChange, type SbsHighlightMode } from "./sbsInline";
import { buildSbsDocument } from "./sbsModel";

const fileOf = (lines: ReadonlyArray<string>) => ({
  name: "file.txt",
  contents: lines.map((line) => `${line}\n`).join(""),
});

function documentOf(before: ReadonlyArray<string>, after: ReadonlyArray<string>) {
  return buildSbsDocument(parseDiffFromFile(fileOf(before), fileOf(after)));
}

const words = () => new LineDiffRangeCache("word", 1_000);

describe("sbsLineChange", () => {
  const edit = documentOf(
    ["keep", "const total = 1;", "keep2"],
    ["keep", "const total = 2;", "keep2"],
  );
  const insertion = documentOf(["a", "b"], ["a", "new", "b"]);
  const deletion = documentOf(["a", "gone", "b"], ["a", "b"]);
  // Two lines become five: the first two lines have partners, the other three do not.
  const uneven = documentOf(["one", "two"], ["alpha beta", "gamma delta", "eps", "zeta", "eta"]);

  it.each([
    { document: insertion, side: "additions", line: 1, tint: "inserted" },
    { document: deletion, side: "deletions", line: 1, tint: "deleted" },
  ] as const)("paints a $tint line in full colour with no changed columns", (row) => {
    expect(
      sbsLineChange(row.document, words(), "words", row.side, row.line, row.document.changes[0]!),
    ).toEqual({ tint: row.tint, changed: [] });
  });

  it("mutes a modified line with a partner and gives the changed columns of each side", () => {
    const change = edit.changes[0]!;
    const left = sbsLineChange(edit, words(), "words", "deletions", 1, change);
    const right = sbsLineChange(edit, words(), "words", "additions", 1, change);
    expect(left.tint).toBe("modified-muted");
    expect(right.tint).toBe("modified-muted");
    expect(left.changed).toEqual([[14, 15]]);
    expect(right.changed).toEqual([[14, 15]]);
  });

  it("pairs lines by their place in the block", () => {
    const change = uneven.changes[0]!;
    const first = sbsLineChange(uneven, words(), "words", "additions", 1, change);
    expect(first.tint).toBe("modified-muted");
    expect(first.changed.length).toBeGreaterThan(0);
  });

  it.each([
    { side: "additions", line: 2 },
    { side: "additions", line: 4 },
  ] as const)(
    "paints the $side line $line, which has no partner, in full modified colour",
    (row) => {
      expect(
        sbsLineChange(uneven, words(), "words", row.side, row.line, uneven.changes[0]!),
      ).toEqual({ tint: "modified", changed: [] });
    },
  );

  it("paints a modified line in full colour when its words cannot be compared", () => {
    const tooLong = new LineDiffRangeCache("word", 3);
    expect(sbsLineChange(edit, tooLong, "words", "additions", 1, edit.changes[0]!)).toEqual({
      tint: "modified",
      changed: [],
    });
  });

  it.each([
    { document: edit, side: "deletions", line: 1, tint: "modified" },
    { document: edit, side: "additions", line: 1, tint: "modified" },
    { document: insertion, side: "additions", line: 1, tint: "inserted" },
    { document: deletion, side: "deletions", line: 1, tint: "deleted" },
  ] as const)("colours the whole $tint line in lines mode", (row) => {
    expect(
      sbsLineChange(row.document, words(), "lines", row.side, row.line, row.document.changes[0]!),
    ).toEqual({ tint: row.tint, changed: [] });
  });

  it.each([
    { document: edit, side: "deletions", line: 1 },
    { document: insertion, side: "additions", line: 1 },
    { document: deletion, side: "deletions", line: 1 },
    { document: uneven, side: "additions", line: 3 },
  ] as const)("paints nothing in none mode ($side $line)", (row) => {
    const mode: SbsHighlightMode = "none";
    expect(
      sbsLineChange(row.document, words(), mode, row.side, row.line, row.document.changes[0]!),
    ).toEqual({ tint: null, changed: [] });
  });
});
