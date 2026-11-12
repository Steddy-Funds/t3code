import { describe, expect, it } from "@effect/vitest";

import {
  rankWorkspaceSymbols,
  supportsRange,
  toDocumentSymbols,
  toHighlights,
  toHoverMarkdown,
  toLocations,
  toRange,
  toSemanticTokenData,
  toSemanticTokensLegend,
  toSymbolKind,
  toWorkspaceSymbols,
} from "./lspResults.ts";

const FILE = "file:///a.py";

const range = (line: number, start: number, end: number) => ({
  start: { line, character: start },
  end: { line, character: end },
});

describe("lspResults", () => {
  describe("toRange", () => {
    it.each([
      ["not an object", 1],
      ["an array", [0, 1]],
      ["a missing end", { start: { line: 0, character: 0 } }],
      ["a negative line", { start: { line: -1, character: 0 }, end: { line: 0, character: 0 } }],
      [
        "a fractional character",
        { start: { line: 0, character: 0.5 }, end: { line: 0, character: 1 } },
      ],
      ["a string line", { start: { line: "0", character: 0 }, end: { line: 0, character: 1 } }],
    ])("rejects %s", (_name, value) => {
      expect(toRange(value)).toBeUndefined();
    });

    it("keeps a well formed range", () => {
      expect(toRange(range(2, 3, 9))).toEqual(range(2, 3, 9));
    });
  });

  describe("toLocations", () => {
    it("reads a single location, a list, and null", () => {
      const location = { uri: "file:///a.py", range: range(0, 0, 1) };
      expect(toLocations(location)).toEqual([location]);
      expect(toLocations([location, location])).toEqual([location, location]);
      expect(toLocations(null)).toEqual([]);
      expect(toLocations(undefined)).toEqual([]);
    });

    it("reads a location link by its selection range, not its whole declaration", () => {
      expect(
        toLocations([
          {
            targetUri: "file:///a.py",
            targetRange: range(0, 0, 40),
            targetSelectionRange: range(0, 4, 9),
          },
        ]),
      ).toEqual([{ uri: "file:///a.py", range: range(0, 4, 9) }]);
    });

    it("falls back to the full target range of a link without a selection range", () => {
      expect(toLocations([{ targetUri: "file:///a.py", targetRange: range(1, 0, 5) }])).toEqual([
        { uri: "file:///a.py", range: range(1, 0, 5) },
      ]);
    });

    it("drops entries that are not locations without failing the rest", () => {
      const good = { uri: "file:///a.py", range: range(0, 0, 1) };
      expect(
        toLocations([
          good,
          null,
          "x",
          { uri: 7, range: range(0, 0, 1) },
          { uri: "file:///b.py" },
          { uri: "file:///b.py", range: { start: 1 } },
        ]),
      ).toEqual([good]);
    });
  });

  describe("toSymbolKind", () => {
    it.each([
      [5, "class"],
      [6, "method"],
      [12, "function"],
      [13, "variable"],
      [22, "enumMember"],
      [23, "struct"],
      [4, "module"],
      [26, "typeParameter"],
      [16, "other"],
      [0, "other"],
      [99, "other"],
      [-1, "other"],
      ["5", "other"],
      [undefined, "other"],
    ])("maps %s to %s", (kind, expected) => {
      expect(toSymbolKind(kind)).toBe(expected);
    });
  });

  describe("toDocumentSymbols", () => {
    it("keeps the tree and fills the selection range from the range when absent", () => {
      expect(
        toDocumentSymbols(
          [
            {
              name: "Greeter",
              kind: 5,
              detail: "class",
              range: range(0, 0, 10),
              selectionRange: range(0, 6, 13),
              children: [{ name: "greet", kind: 6, range: range(1, 2, 8) }],
            },
          ],
          FILE,
        ),
      ).toEqual([
        {
          name: "Greeter",
          detail: "class",
          kind: "class",
          range: range(0, 0, 10),
          selectionRange: range(0, 6, 13),
          children: [
            {
              name: "greet",
              kind: "method",
              range: range(1, 2, 8),
              selectionRange: range(1, 2, 8),
              children: [],
            },
          ],
        },
      ]);
    });

    it("reads the flat form by its location range, omits an empty detail, and keeps only this file's", () => {
      expect(
        toDocumentSymbols(
          [
            { name: "f", kind: 12, detail: "", location: { uri: FILE, range: range(3, 0, 4) } },
            {
              name: "g",
              kind: 12,
              location: { uri: "file:///opt/t3/lib.py", range: range(0, 0, 1) },
            },
          ],
          FILE,
        ),
      ).toEqual([
        {
          name: "f",
          kind: "function",
          range: range(3, 0, 4),
          selectionRange: range(3, 0, 4),
          children: [],
        },
      ]);
    });

    it("skips an entry without a name or a range, and anything that is not a list", () => {
      expect(
        toDocumentSymbols(
          [{ kind: 12, range: range(0, 0, 1) }, { name: "x", kind: 12 }, 5, null],
          FILE,
        ),
      ).toEqual([]);
      expect(toDocumentSymbols(null, FILE)).toEqual([]);
      expect(toDocumentSymbols({ name: "x" }, FILE)).toEqual([]);
    });

    it("stops at 5000 symbols", () => {
      const many = Array.from({ length: 6_000 }, (_, index) => ({
        name: `s${index}`,
        kind: 12,
        range: range(index, 0, 1),
      }));
      expect(toDocumentSymbols(many, FILE)).toHaveLength(5_000);
    });

    it("stops descending at depth 32", () => {
      let node: Record<string, unknown> = { name: "leaf", kind: 12, range: range(0, 0, 1) };
      for (let depth = 0; depth < 50; depth++) {
        node = { name: `n${depth}`, kind: 12, range: range(0, 0, 1), children: [node] };
      }
      let levels = 0;
      let current: ReadonlyArray<{ children: ReadonlyArray<unknown> }> = toDocumentSymbols(
        [node],
        FILE,
      ) as never;
      while (current.length > 0) {
        levels += 1;
        current = current[0]!.children as never;
      }
      expect(levels).toBe(33);
    });
  });

  describe("toHoverMarkdown", () => {
    it("reads MarkupContent, a string, and a list of both forms joined by a blank line", () => {
      expect(toHoverMarkdown({ kind: "markdown", value: "**a**" })).toBe("**a**");
      expect(toHoverMarkdown("plain")).toBe("plain");
      expect(
        toHoverMarkdown([
          "one",
          { language: "python", value: "def f()" },
          { kind: "plaintext", value: "two" },
        ]),
      ).toBe("one\n\n```python\ndef f()\n```\n\ntwo");
    });

    it("is null for nothing worth showing", () => {
      expect(toHoverMarkdown(null)).toBeNull();
      expect(toHoverMarkdown("   ")).toBeNull();
      expect(toHoverMarkdown([{ value: 1 }, 2])).toBeNull();
      expect(toHoverMarkdown({ kind: "markdown", value: "" })).toBeNull();
    });

    it("caps the text at 64 KiB", () => {
      expect(toHoverMarkdown("a".repeat(100_000))?.length).toBe(64 * 1024);
    });
  });

  describe("toHighlights", () => {
    it("maps read and write and treats the rest as text", () => {
      expect(
        toHighlights([
          { range: range(0, 0, 1), kind: 2 },
          { range: range(1, 0, 1), kind: 3 },
          { range: range(2, 0, 1), kind: 1 },
          { range: range(3, 0, 1) },
          { range: { nope: true }, kind: 2 },
          null,
        ]),
      ).toEqual([
        { range: range(0, 0, 1), kind: "read" },
        { range: range(1, 0, 1), kind: "write" },
        { range: range(2, 0, 1), kind: "text" },
        { range: range(3, 0, 1), kind: "text" },
      ]);
      expect(toHighlights(null)).toEqual([]);
    });
  });

  describe("toWorkspaceSymbols", () => {
    it("reads the location, the kind and the container, leaving out empty containers", () => {
      const location = { uri: "file:///a.py", range: range(0, 4, 9) };
      expect(
        toWorkspaceSymbols([
          { name: "greet", kind: 12, containerName: "Greeter", location },
          { name: "other", kind: 5, containerName: "", location },
        ]),
      ).toEqual([
        { name: "greet", kind: "function", containerName: "Greeter", location },
        { name: "other", kind: "class", containerName: undefined, location },
      ]);
    });

    it("drops a symbol with no range, such as a WorkspaceSymbol with only a uri", () => {
      expect(
        toWorkspaceSymbols([
          { name: "lazy", kind: 12, location: { uri: "file:///a.py" } },
          { kind: 12, location: { uri: "file:///a.py", range: range(0, 0, 1) } },
        ]),
      ).toEqual([]);
      expect(toWorkspaceSymbols(null)).toEqual([]);
    });
  });

  describe("rankWorkspaceSymbols", () => {
    const named = (...names: ReadonlyArray<string>) => names.map((name) => ({ name }));

    it("ranks the exact name, then the same name in another case, then prefixes, then the rest", () => {
      expect(
        rankWorkspaceSymbols(
          named("a_greet", "greeter", "Greet", "greet", "Greeting", "xgreetx"),
          "greet",
        ).map((symbol) => symbol.name),
      ).toEqual(["greet", "Greet", "greeter", "Greeting", "a_greet", "xgreetx"]);
    });

    it("keeps the server's order inside a rank", () => {
      expect(
        rankWorkspaceSymbols(named("zeta_greet", "alpha_greet", "greet_b", "greet_a"), "greet").map(
          (symbol) => symbol.name,
        ),
      ).toEqual(["greet_b", "greet_a", "zeta_greet", "alpha_greet"]);
    });

    it("returns the list as is for an empty query", () => {
      const symbols = named("b", "a");
      expect(rankWorkspaceSymbols(symbols, "")).toBe(symbols);
    });

    it("does not change its input", () => {
      const symbols = named("b_x", "x");
      rankWorkspaceSymbols(symbols, "x");
      expect(symbols.map((symbol) => symbol.name)).toEqual(["b_x", "x"]);
    });
  });

  describe("semantic tokens", () => {
    it("keeps whole tokens of non-negative integers and nothing else", () => {
      expect(toSemanticTokenData({ data: [0, 1, 2, 3, 4, 1, 0, 2, 1, 0] })).toEqual([
        0, 1, 2, 3, 4, 1, 0, 2, 1, 0,
      ]);
      expect(toSemanticTokenData({ data: [0, 1, 2, 3] })).toEqual([]);
      expect(toSemanticTokenData({ data: [0, 1, 2, 3, -4] })).toEqual([]);
      expect(toSemanticTokenData({ data: [0, 1, 2, 3, 0.5] })).toEqual([]);
      expect(toSemanticTokenData({ data: "no" })).toEqual([]);
      expect(toSemanticTokenData(null)).toEqual([]);
    });

    it("reads the legend and ignores non-string entries", () => {
      expect(
        toSemanticTokensLegend({
          legend: { tokenTypes: ["class", 1, "function"], tokenModifiers: "x" },
        }),
      ).toEqual({ tokenTypes: ["class", "function"], tokenModifiers: [] });
      expect(toSemanticTokensLegend({})).toBeUndefined();
      expect(toSemanticTokensLegend(undefined)).toBeUndefined();
    });

    it("supports a range only when the provider says so", () => {
      expect(supportsRange({ range: true })).toBe(true);
      expect(supportsRange({ range: {} })).toBe(true);
      expect(supportsRange({ range: false })).toBe(false);
      expect(supportsRange({ full: true })).toBe(false);
      expect(supportsRange(undefined)).toBe(false);
    });
  });
});
