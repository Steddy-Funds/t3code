import { parseDiffFromFile } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import { sbsConnectorPath } from "./sbsConnectors";
import { buildSbsDocument } from "./sbsModel";
import { sbsDiffMovesOf, sbsMoveLayerOf, sbsMovesForFile } from "./sbsMoves";
import { sbsSplitCardOf, sbsSplitGeometry, sbsSplitOf } from "./sbsSplit";

const AMOUNT = [
  "function parseAmount(raw) {",
  "  const cleaned = raw.replace(',', '');",
  "  return Number(cleaned);",
  "}",
];
const DATES = [
  "function parseDate(raw) {",
  "  const [day, month, year] = raw.split('/');",
  "  return new Date(year, month - 1, day);",
  "}",
];
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line${index + 1}`);
const fileOf = (name: string, lines: ReadonlyArray<string>) => ({
  name,
  contents: lines.map((line) => `${line}\n`).join(""),
});

describe("sbsSplitOf", () => {
  it("gathers every piece of the block a moved line sits in, and the lines that went nowhere", () => {
    const before = [
      "import x;",
      ...AMOUNT,
      "const dropped = recompute(1, 2, 3);",
      ...DATES,
      ...numbered(10),
    ];
    const after = ["import x;", ...numbered(10), ...DATES];
    const parser = parseDiffFromFile(fileOf("a.ts", before), fileOf("a.ts", after));
    const amounts = parseDiffFromFile(
      fileOf("b.ts", []),
      fileOf("b.ts", ["// amounts", ...AMOUNT]),
    );
    const moves = sbsMovesForFile(
      sbsDiffMovesOf([
        { filePath: "a.ts", fileDiff: parser },
        { filePath: "b.ts", fileDiff: amounts },
      ]),
      "a.ts",
      (path) => path,
    );
    const document = buildSbsDocument(parser);
    const layer = sbsMoveLayerOf(document, moves);

    // Clicked on the dates function, the second piece: the whole block opens.
    const split = sbsSplitOf(document, layer, "deletions", 7)!;
    expect(split.block).toEqual({ start: 1, end: 10 });
    expect(split.pieces.map(({ rows, mark }) => [rows.start, rows.end, mark.move.place])).toEqual([
      [0, 4, "b.ts:2-5"],
      [5, 9, "L12-15"],
    ]);
    expect(split.gaps).toEqual([{ start: 4, end: 5 }]);

    expect(sbsSplitOf(document, layer, "additions", 0)).toBeNull();
  });

  it("keeps only the part of a move's other end that its block holds", () => {
    // Whitespace ignored, say: a line inside the move shows unchanged and cuts it in two blocks.
    const before = ["parseOne(rows);", "parseTwo(rows);", "parseThree(rows);", "}", "four(1);"];
    const parser = parseDiffFromFile(fileOf("a.ts", before), fileOf("a.ts", ["}", "kept();"]));
    const document = buildSbsDocument(parser);
    const move = {
      side: "deletions" as const,
      startLine: 1,
      endLine: 5,
      counterpart: { filePath: "b.ts", sameFile: false, startLine: 10, endLine: 14 },
      label: "→ b.ts:10",
      place: "b.ts:10-14",
      description: "Moved to b.ts:10-14",
    };
    const layer = sbsMoveLayerOf(document, [move]);

    const first = sbsSplitOf(document, layer, "deletions", 0)!;
    expect(first.block).toEqual({ start: 0, end: 3 });
    expect(first.pieces.map((piece) => [piece.counterpart, piece.place])).toEqual([
      [{ startLine: 10, endLine: 12 }, "b.ts:10-12"],
    ]);
    const second = sbsSplitOf(document, layer, "deletions", 4)!;
    expect(second.pieces.map((piece) => [piece.counterpart, piece.place])).toEqual([
      [{ startLine: 14, endLine: 14 }, "b.ts:14"],
    ]);
  });
});

describe("sbsSplitCardOf", () => {
  it("shows a piece with what encloses it, and no more than its hunk holds", () => {
    const after = [
      "export class Parser {",
      "  helper() {",
      "    return 1;",
      "  }",
      "",
      ...AMOUNT.map((line) => `  ${line}`),
      "}",
      "export const x = 1;",
    ];
    const document = buildSbsDocument(parseDiffFromFile(fileOf("p.ts", []), fileOf("p.ts", after)));
    const card = sbsSplitCardOf(document, "additions", 6, 9)!;
    // Up to the class it sits in, down to the brace that closes it.
    expect([card.before, card.after, card.lines.length]).toEqual([5, 1, 10]);
    expect(card.lines.map((line) => line.moved)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(card.lines[0]).toEqual({ text: "export class Parser {", lineNumber: 1, moved: false });

    // Top-level code has nothing enclosing it: two lines each way, inside its own hunk.
    const patch = [
      "diff --git a/c.ts b/c.ts",
      "--- a/c.ts",
      "+++ b/c.ts",
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "+TWO",
      "@@ -20,2 +20,6 @@",
      " twenty",
      ...AMOUNT.map((line) => `+${line}`),
      " twentyone",
      "",
    ].join("\n");
    const hunks = buildSbsDocument(parsePatchFiles(patch)[0]!.files[0]!);
    const topLevel = sbsSplitCardOf(hunks, "additions", 21, 24)!;
    expect(topLevel.lines.map((line) => line.lineNumber)).toEqual([20, 21, 22, 23, 24, 25]);
    expect(sbsSplitCardOf(hunks, "additions", 10, 12)).toBeNull();
  });
});

describe("sbsSplitGeometry", () => {
  it("sets another file's card level with its piece and stacks this file's under the last", () => {
    const pieces = [
      { rows: { start: 0, end: 4 }, before: 1, after: 0, level: true },
      { rows: { start: 5, end: 9 }, before: 2, after: 0, level: false },
    ];
    const input = {
      blockRows: 9,
      pieces,
      gaps: [{ start: 4, end: 5 }],
      lineHeight: 10,
      side: "deletions" as const,
      dividerWidth: 72,
    };
    const geometry = sbsSplitGeometry(input);
    // The block moves down a header and a context line so the first card can sit level.
    expect(geometry.blockTop).toBe(20);
    expect(geometry.cards).toEqual([
      { top: 0, height: 60 },
      { top: 68, height: 70 },
    ]);
    expect(geometry.height).toBe(138);
    expect(geometry.bands).toEqual([
      sbsConnectorPath({ top: 20, bottom: 60 }, { top: 20, bottom: 60 }, 72),
      sbsConnectorPath({ top: 70, bottom: 110 }, { top: 98, bottom: 138 }, 72),
    ]);
    expect(geometry.gaps).toHaveLength(1);

    // Code that arrived: the block is on the right, so its bands run from the cards.
    const arrived = sbsSplitGeometry({ ...input, side: "additions" });
    expect(arrived.bands[1]).toBe(
      sbsConnectorPath({ top: 98, bottom: 138 }, { top: 70, bottom: 110 }, 72),
    );
  });
});
