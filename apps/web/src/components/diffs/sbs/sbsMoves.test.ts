import { parseDiffFromFile } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import { buildSbsDocument } from "./sbsModel";
import {
  SBS_MOVED,
  SBS_MOVED_OUT,
  SBS_MOVE_NONE,
  sbsDiffMovesOf,
  sbsMoveLayerOf,
  sbsMovesForFile,
} from "./sbsMoves";

const FUNCTION = [
  "function parseAmount(raw) {",
  "  const cleaned = raw.replace(',', '');",
  "  return Number(cleaned);",
  "}",
];
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line${index + 1}`);
const fileOf = (name: string, lines: ReadonlyArray<string>) => ({
  name,
  contents: lines.map((line) => `${line}\n`).join(""),
});
const shownPath = (path: string) => path;

describe("sbsMovesForFile", () => {
  it("marks a block moved down its own file at both ends, with chips that point at each other", () => {
    const before = [...numbered(2), ...FUNCTION, ...numbered(14).map((line) => `${line}b`)];
    const after = [...numbered(2), ...numbered(14).map((line) => `${line}b`), ...FUNCTION];
    const fileDiff = parseDiffFromFile(fileOf("a.ts", before), fileOf("a.ts", after));
    const moves = sbsMovesForFile(
      sbsDiffMovesOf([{ filePath: "a.ts", fileDiff }]),
      "a.ts",
      shownPath,
    );
    expect(
      moves.map(({ side, startLine, endLine, label }) => [side, startLine, endLine, label]),
    ).toEqual([
      ["deletions", 3, 6, "→ L17"],
      ["additions", 17, 20, "← from L3"],
    ]);

    const document = buildSbsDocument(fileDiff);
    const layer = sbsMoveLayerOf(document, moves);
    expect(Array.from(layer.tints.deletions.slice(1, 7))).toEqual([
      SBS_MOVE_NONE,
      SBS_MOVED,
      SBS_MOVED,
      SBS_MOVED,
      SBS_MOVED,
      SBS_MOVE_NONE,
    ]);
    // Both changes moved whole, so the band between them stands in for their connectors.
    expect(layer.movedChanges.size).toBe(document.changes.length);
    expect(layer.marks.deletions[0]?.counterpartRange).toEqual({ start: 16, end: 20 });

    // A blank line added elsewhere in the file keeps its own connector.
    const spacedDiff = parseDiffFromFile(fileOf("a.ts", before), fileOf("a.ts", ["", ...after]));
    const spacedDocument = buildSbsDocument(spacedDiff);
    const spacedLayer = sbsMoveLayerOf(
      spacedDocument,
      sbsMovesForFile(
        sbsDiffMovesOf([{ filePath: "a.ts", fileDiff: spacedDiff }]),
        "a.ts",
        shownPath,
      ),
    );
    expect(spacedDocument.changes).toHaveLength(3);
    expect(spacedLayer.movedChanges.size).toBe(2);
  });

  it("reads a patch's line numbers for a block that left for another file", () => {
    const patch = [
      "diff --git a/src/importer.ts b/src/importer.ts",
      "--- a/src/importer.ts",
      "+++ b/src/importer.ts",
      "@@ -8,7 +8,3 @@ export function load() {",
      " line8",
      " line9",
      ...FUNCTION.map((line) => `-${line}`),
      " line14",
      "diff --git a/src/amounts.ts b/src/amounts.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/amounts.ts",
      "@@ -0,0 +1,5 @@",
      "+import { log } from './log';",
      ...FUNCTION.map((line) => `+${line}`),
      "",
    ].join("\n");
    const [importer, amounts] = parsePatchFiles(patch)[0]!.files;
    const diffMoves = sbsDiffMovesOf([
      { filePath: "src/importer.ts", fileDiff: importer! },
      { filePath: "src/amounts.ts", fileDiff: amounts! },
    ]);
    const outgoing = sbsMovesForFile(diffMoves, "src/importer.ts", shownPath);
    expect(outgoing.map(({ startLine, endLine, label }) => [startLine, endLine, label])).toEqual([
      [10, 13, "→ src/amounts.ts:2"],
    ]);
    expect(sbsMovesForFile(diffMoves, "src/amounts.ts", shownPath)[0]?.label).toBe(
      "← from src/importer.ts:10",
    );

    // The patch alone, as a file too large to read whole is shown: its own line numbering.
    const layer = sbsMoveLayerOf(buildSbsDocument(importer!), outgoing);
    expect(Array.from(layer.tints.deletions)).toEqual([
      SBS_MOVE_NONE,
      SBS_MOVE_NONE,
      SBS_MOVED_OUT,
      SBS_MOVED_OUT,
      SBS_MOVED_OUT,
      SBS_MOVED_OUT,
      SBS_MOVE_NONE,
    ]);
  });
});
