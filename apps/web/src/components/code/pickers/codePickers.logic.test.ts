import type { CodeSymbol, CodeSymbolKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  matchIndices,
  methodJumpTarget,
  rowAtPosition,
  stepHighlight,
  structureRows,
} from "./codePickers.logic";

function symbol(
  name: string,
  kind: CodeSymbolKind,
  lines: readonly [start: number, end: number],
  children: ReadonlyArray<CodeSymbol> = [],
): CodeSymbol {
  return {
    name,
    kind,
    range: { start: { line: lines[0], character: 0 }, end: { line: lines[1], character: 1 } },
    selectionRange: {
      start: { line: lines[0], character: 4 },
      end: { line: lines[0], character: 4 + name.length },
    },
    children,
  };
}

// Out of source order on purpose: a server may list a class's members in any order.
const FILE: ReadonlyArray<CodeSymbol> = [
  symbol(
    "Invoice",
    "class",
    [2, 30],
    [
      symbol("total", "method", [20, 24]),
      symbol("constructor", "constructor", [4, 8]),
      symbol("lines", "property", [3, 3]),
      symbol("addLine", "method", [10, 18], [symbol("line", "variable", [11, 11])]),
    ],
  ),
  symbol("formatMoney", "function", [32, 36]),
  symbol("VERSION", "constant", [0, 0]),
];

const ids = (rows: ReturnType<typeof structureRows>) =>
  rows.map(
    (row) => `${"  ".repeat(row.depth)}${row.symbol.name}${row.matches ? "" : " (context)"}`,
  );

describe("matchIndices", () => {
  it.each([
    ["InvoiceLine", "inl", [0, 1, 7]],
    ["InvoiceLine", "IL", [0, 7]],
    ["InvoiceLine", "inv line", [0, 1, 2, 7, 8, 9, 10]],
    ["InvoiceLine", "", []],
    ["InvoiceLine", "lx", null],
    ["Invoice", "ecio", null],
  ] as const)("%s for %j", (value, query, expected) => {
    expect(matchIndices(value, query)).toEqual(expected);
  });
});

describe("structureRows", () => {
  it("lists the whole tree in source order", () => {
    expect(ids(structureRows(FILE, ""))).toEqual([
      "VERSION",
      "Invoice",
      "  lines",
      "  constructor",
      "  addLine",
      "    line",
      "  total",
      "formatMoney",
    ]);
  });

  it("keeps a parent as context when only its children match", () => {
    expect(ids(structureRows(FILE, "line"))).toEqual([
      "Invoice (context)",
      "  lines",
      "  addLine",
      "    line",
    ]);
  });

  it("keeps ids stable while filtering, so the highlight survives typing", () => {
    const all = new Map(structureRows(FILE, "").map((row) => [row.symbol.name, row.id]));
    for (const row of structureRows(FILE, "t")) {
      expect(row.id).toBe(all.get(row.symbol.name));
    }
  });
});

describe("rowAtPosition", () => {
  const rows = structureRows(FILE, "");

  it.each([
    [{ line: 11, character: 1 }, "line"],
    [{ line: 12, character: 0 }, "addLine"],
    [{ line: 26, character: 0 }, "Invoice"],
    [{ line: 31, character: 0 }, "total"],
    [{ line: 40, character: 0 }, "formatMoney"],
    [null, "VERSION"],
  ] as const)("at %j is %s", (position, name) => {
    expect(rowAtPosition(rows, position)?.symbol.name).toBe(name);
  });

  it("skips context rows", () => {
    expect(rowAtPosition(structureRows(FILE, "line"), { line: 2, character: 0 })?.symbol.name).toBe(
      "lines",
    );
  });
});

describe("methodJumpTarget", () => {
  it.each([
    [{ line: 0, character: 0 }, "next", 4],
    [{ line: 4, character: 4 }, "next", 10],
    [{ line: 12, character: 0 }, "next", 20],
    [{ line: 20, character: 4 }, "next", 32],
    [{ line: 33, character: 0 }, "next", null],
    [{ line: 33, character: 0 }, "previous", 32],
    [{ line: 12, character: 0 }, "previous", 10],
    [{ line: 4, character: 4 }, "previous", null],
    [null, "next", 4],
  ] as const)("from %j, %s lands on line %s", (position, direction, line) => {
    expect(methodJumpTarget(FILE, position, direction)?.line ?? null).toBe(line);
  });
});

describe("stepHighlight", () => {
  it.each([
    [null, "next", 0],
    [null, "previous", 4],
    [0, "previous", 0],
    [4, "next", 4],
    [1, "pageDown", 4],
    [3, "pageUp", 0],
    [2, "next", 3],
  ] as const)("from %s, %s goes to %s of five", (index, step, expected) => {
    expect(stepHighlight(index, 5, step)).toBe(expected);
  });

  it("has nothing to highlight in an empty list", () => {
    expect(stepHighlight(null, 0, "next")).toBeNull();
  });
});
