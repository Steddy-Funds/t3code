import { describe, expect, it } from "@effect/vitest";

import { findDiffMoves, type DiffLineRun, type DiffMoveFile } from "./diffMoves.ts";

const PARSE = [
  "def parse_date(raw):",
  "    for fmt in DATE_FORMATS:",
  "        return datetime.strptime(raw, fmt)",
  "    raise ValueError(raw)",
];
const AMOUNT = [
  "def parse_amount(raw):",
  "    cleaned = raw.replace(',', '')",
  "    return Decimal(cleaned)",
];

function run(startLine: number, lines: ReadonlyArray<string>, block: number): DiffLineRun {
  return { startLine, lines, block };
}

function file(
  path: string,
  removed: ReadonlyArray<DiffLineRun>,
  added: ReadonlyArray<DiffLineRun>,
): DiffMoveFile {
  return { path, removed, added };
}

describe("findDiffMoves", () => {
  it("finds a block moved down its own file, and one moved to another file", () => {
    const moves = findDiffMoves([
      file("importer.py", [run(10, PARSE, 0), run(20, AMOUNT, 2)], [run(40, PARSE, 1)]),
      file("parsers/amounts.py", [], [run(5, AMOUNT, 0)]),
    ]);
    expect(moves).toEqual([
      {
        from: { path: "importer.py", startLine: 10, endLine: 13 },
        to: { path: "importer.py", startLine: 40, endLine: 43 },
      },
      {
        from: { path: "importer.py", startLine: 20, endLine: 22 },
        to: { path: "parsers/amounts.py", startLine: 5, endLine: 7 },
      },
    ]);
  });

  it("splits a removed block that went to two places, and ignores indentation", () => {
    const indented = PARSE.map((line) => `    ${line}`);
    const moves = findDiffMoves([
      file("importer.py", [run(1, [...AMOUNT, "", ...PARSE], 0)], []),
      file("parsers/amounts.py", [], [run(5, AMOUNT, 0)]),
      file("parsers/dates.py", [], [run(9, indented, 0)]),
    ]);
    expect(moves.map((move) => [move.from.startLine, move.from.endLine, move.to.path])).toEqual([
      [1, 3, "parsers/amounts.py"],
      [5, 8, "parsers/dates.py"],
    ]);
  });

  it("takes lines rewritten in place for an edit, not a move", () => {
    const indented = PARSE.map((line) => `  ${line}`);
    expect(findDiffMoves([file("a.py", [run(10, PARSE, 0)], [run(10, indented, 0)])])).toEqual([]);
  });

  it("leaves out blocks too small to mean anything, and a block that fits two places", () => {
    const braces = ["}", "", "}"];
    expect(
      findDiffMoves([file("a.ts", [run(1, braces, 0)], []), file("b.ts", [], [run(1, braces, 0)])]),
    ).toEqual([]);
    expect(
      findDiffMoves([
        file("a.py", [run(1, PARSE, 0)], []),
        file("b.py", [], [run(1, PARSE, 0)]),
        file("c.py", [], [run(1, PARSE, 0)]),
      ]),
    ).toEqual([]);
  });

  it("prefers the longest match when a shorter one shares its lines", () => {
    const moves = findDiffMoves([
      file("a.py", [run(1, [...PARSE, ...AMOUNT], 0)], []),
      file("b.py", [], [run(1, PARSE, 0)]),
      file("c.py", [], [run(1, [...PARSE, ...AMOUNT], 0)]),
    ]);
    expect(moves).toEqual([
      {
        from: { path: "a.py", startLine: 1, endLine: 7 },
        to: { path: "c.py", startLine: 1, endLine: 7 },
      },
    ]);
  });
});
