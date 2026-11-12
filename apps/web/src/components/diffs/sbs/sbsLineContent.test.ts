import { describe, expect, it } from "vite-plus/test";

import {
  NO_LINE_MARKS,
  sbsTextPieces,
  sbsTokensFromHast,
  sbsTokenStyle,
  type SbsLineMarks,
  type SbsToken,
} from "./sbsLineContent";

const piece = (
  start: number,
  text: string,
  extra: { style?: string; changed?: boolean; match?: 0 | 1 | 2 } = {},
) => ({
  start,
  text,
  style: extra.style,
  changed: extra.changed ?? false,
  match: extra.match ?? 0,
});

describe("sbsTextPieces", () => {
  const tokens: ReadonlyArray<SbsToken> = [
    { start: 0, end: 3, style: "color:red" },
    { start: 3, end: 5, style: undefined },
  ];

  it.each([
    {
      name: "plain text is one piece",
      text: "abcde",
      tokens: null,
      marks: NO_LINE_MARKS,
      expected: [piece(0, "abcde")],
    },
    {
      name: "an empty line has no pieces",
      text: "",
      tokens: null,
      marks: NO_LINE_MARKS,
      expected: [],
    },
    {
      name: "tokens cut the line where they end",
      text: "abcde",
      tokens,
      marks: NO_LINE_MARKS,
      expected: [piece(0, "abc", { style: "color:red" }), piece(3, "de")],
    },
    {
      name: "a gap between tokens is unstyled",
      text: "abcdef",
      tokens: [{ start: 2, end: 4, style: "color:red" }],
      marks: NO_LINE_MARKS,
      expected: [piece(0, "ab"), piece(2, "cd", { style: "color:red" }), piece(4, "ef")],
    },
    {
      name: "a changed range cuts inside a token and keeps its style",
      text: "abcde",
      tokens,
      marks: { ...NO_LINE_MARKS, changed: [[1, 2]] },
      expected: [
        piece(0, "a", { style: "color:red" }),
        piece(1, "b", { style: "color:red", changed: true }),
        piece(2, "c", { style: "color:red" }),
        piece(3, "de"),
      ],
    },
    {
      name: "a find match is 1 and the current match is 2 where they overlap",
      text: "abcdef",
      tokens: null,
      marks: { changed: [], matches: [[0, 4]], currentMatch: [2, 5] },
      expected: [
        piece(0, "ab", { match: 1 }),
        piece(2, "cd", { match: 2 }),
        piece(4, "e", { match: 2 }),
        piece(5, "f"),
      ],
    },
    {
      name: "a range past the line is cut to it",
      text: "abc",
      tokens: null,
      marks: { ...NO_LINE_MARKS, changed: [[2, 99]], matches: [[-5, 1]] },
      expected: [piece(0, "a", { match: 1 }), piece(1, "b"), piece(2, "c", { changed: true })],
    },
  ] satisfies ReadonlyArray<{
    name: string;
    text: string;
    tokens: ReadonlyArray<SbsToken> | null;
    marks: SbsLineMarks;
    expected: ReadonlyArray<ReturnType<typeof piece>>;
  }>)("$name", ({ text, tokens: given, marks, expected }) => {
    const pieces = sbsTextPieces(text, given, marks);
    expect(pieces).toEqual(expected);
    expect(pieces.map((entry) => entry.text).join("")).toBe(text);
  });
});

describe("sbsTokensFromHast", () => {
  const span = (text: string, style?: string) => ({
    type: "element",
    tagName: "span",
    properties: style === undefined ? {} : { style },
    children: [{ type: "text", value: text }],
  });

  it.each([
    {
      name: "one token per span",
      row: { type: "element", children: [span("const", "color:#fff"), span(" x")] },
      text: "const x",
      expected: [
        { start: 0, end: 5, style: "color:#fff" },
        { start: 5, end: 7, style: undefined },
      ],
    },
    {
      name: "text nested in a span",
      row: {
        type: "element",
        children: [
          {
            type: "element",
            properties: { style: "color:red" },
            children: [span("a"), { type: "text", value: "bc" }],
          },
        ],
      },
      text: "abc",
      expected: [{ start: 0, end: 3, style: "color:red" }],
    },
    {
      name: "empty spans and empty styles left out",
      row: { type: "element", children: [span(""), span("ab", ""), span("c")] },
      text: "abc",
      expected: [
        { start: 0, end: 2, style: undefined },
        { start: 2, end: 3, style: undefined },
      ],
    },
    {
      name: "an empty row of an empty line",
      row: { type: "element", children: [] },
      text: "",
      expected: [],
    },
  ])("reads $name", ({ row, text, expected }) => {
    expect(sbsTokensFromHast(row, text)).toEqual(expected);
  });

  it.each([
    { name: "the row is longer than the line", row: { children: [span("abcd")] }, text: "abc" },
    { name: "the row is shorter than the line", row: { children: [span("ab")] }, text: "abc" },
    { name: "the row is not an object", row: "abc", text: "abc" },
    { name: "there is no row", row: null, text: "abc" },
  ])("gives null when $name", ({ row, text }) => {
    expect(sbsTokensFromHast(row, text)).toBeNull();
  });
});

describe("sbsTokenStyle", () => {
  it.each([
    { style: "color:red", expected: { color: "red" } },
    {
      style: "color: #fff; font-style:italic ;font-weight : 600",
      expected: { color: "#fff", fontStyle: "italic", fontWeight: "600" },
    },
    {
      style: "--shiki-dark:#abc;--x-y: 1;background-color:blue",
      expected: { "--shiki-dark": "#abc", "--x-y": "1", backgroundColor: "blue" },
    },
    { style: "color:;nonsense;:red;font-size:12px", expected: { fontSize: "12px" } },
  ])("reads $style", ({ style, expected }) => {
    expect(sbsTokenStyle(style)).toEqual(expected);
  });

  it("gives nothing for no style, and the same object for the same string", () => {
    expect(sbsTokenStyle(undefined)).toBeUndefined();
    expect(sbsTokenStyle("color:green")).toBe(sbsTokenStyle("color:green"));
  });
});
