import { describe, expect, it } from "vite-plus/test";

import {
  decodeSemanticTokens,
  semanticChunkRange,
  semanticChunksFor,
  textLines,
  unchangedLineMap,
} from "./semanticHighlighting";

describe("decodeSemanticTokens", () => {
  it("positions each token from the one before: same line by column, a new line from column 0", () => {
    const lines = decodeSemanticTokens([
      // line 0, col 4, `greet`, type 1, modifier bits 0b01
      0, 4, 5, 1, 1,
      // same line, 6 columns on: col 10
      0, 6, 4, 2, 0,
      // two lines down, col 2 (not 12)
      2, 2, 3, 0, 2,
      // same line, col 2 + 5
      0, 5, 1, 3, 0,
    ]);

    expect([...lines]).toEqual([
      [
        0,
        [
          { start: 4, length: 5, type: 1, modifiers: 1 },
          { start: 10, length: 4, type: 2, modifiers: 0 },
        ],
      ],
      [
        2,
        [
          { start: 2, length: 3, type: 0, modifiers: 2 },
          { start: 7, length: 1, type: 3, modifiers: 0 },
        ],
      ],
    ]);
  });

  it("ignores a trailing group shorter than five integers", () => {
    expect([...decodeSemanticTokens([0, 1, 2, 3, 0, 1, 0])]).toEqual([
      [0, [{ start: 1, length: 2, type: 3, modifiers: 0 }]],
    ]);
  });
});

describe("textLines", () => {
  it("numbers lines as the viewer does, dropping CRLF's carriage return", () => {
    expect(textLines("a\r\nb\n\nc")).toEqual(["a", "b", "", "c"]);
  });
});

describe("unchangedLineMap", () => {
  const before = ["a", "b", "c", "d", "e"];

  it.each([
    {
      name: "a line inserted keeps lines above in place and shifts lines below down",
      after: ["a", "b", "new", "c", "d", "e"],
      expected: [0, 1, null, 2, 3, 4],
    },
    {
      name: "a line deleted shifts lines below up",
      after: ["a", "c", "d", "e"],
      expected: [0, 2, 3, 4],
    },
    {
      name: "an edited line has no counterpart",
      after: ["a", "b", "C!", "d", "e"],
      expected: [0, 1, null, 3, 4],
    },
    {
      name: "lines between two edits have no counterpart either",
      after: ["a", "B", "c", "D", "e"],
      expected: [0, null, null, null, 4],
    },
    {
      name: "the same text maps every line to itself",
      after: before,
      expected: [0, 1, 2, 3, 4],
    },
  ])("$name", ({ after, expected }) => {
    const lineOf = unchangedLineMap(before, after);
    expect(after.map((_, line) => lineOf(line))).toEqual(expected);
  });

  it("never maps a line twice when repeated lines make prefix and suffix overlap", () => {
    const lineOf = unchangedLineMap(["x", "x", "x"], ["x", "x"]);
    expect([lineOf(0), lineOf(1)]).toEqual([0, 1]);
  });

  it("has nothing for lines outside the new text", () => {
    const lineOf = unchangedLineMap(before, before);
    expect([lineOf(-1), lineOf(5)]).toEqual([null, null]);
  });
});

describe("semantic chunks", () => {
  it("covers the rendered rows with whole 1,000-line chunks", () => {
    expect(semanticChunksFor(0, 999)).toEqual([0]);
    expect(semanticChunksFor(950, 1_100)).toEqual([0, 1]);
    expect(semanticChunksFor(4_200, 4_260)).toEqual([4]);
  });

  it("asks for a chunk's lines up to the next chunk's first line", () => {
    expect(semanticChunkRange(2)).toEqual({
      start: { line: 2_000, character: 0 },
      end: { line: 3_000, character: 0 },
    });
  });
});
