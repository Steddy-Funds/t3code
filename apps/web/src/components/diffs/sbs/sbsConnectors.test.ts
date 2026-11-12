import { parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  sbsConnectorPath,
  sbsRowsSpan,
  sbsVisibleConnectors,
  sbsVisibleFoldLinks,
  sbsVisibleMoveShapes,
} from "./sbsConnectors";
import { buildSbsLayout, type SbsLayoutOptions } from "./sbsLayout";
import { buildSbsDocument } from "./sbsModel";
import { sbsDiffMovesOf, sbsMoveLayerOf, sbsMovesForFile } from "./sbsMoves";

const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line${index + 1}`);
const fileOf = (lines: ReadonlyArray<string>) => ({
  name: "file.txt",
  contents: lines.map((line) => `${line}\n`).join(""),
});

const LINE_HEIGHT = 20;
const FLAT: SbsLayoutOptions = { collapseUnchanged: false, expandedFolds: new Set() };

/** 60 lines in which `removed` lines at `at` become `added` new ones. */
function replaced(at: number, removed: number, added: number) {
  const before = numbered(60);
  const after = [
    ...before.slice(0, at),
    ...Array.from({ length: added }, (_, index) => `new${index}`),
    ...before.slice(at + removed),
  ];
  const document = buildSbsDocument(parseDiffFromFile(fileOf(before), fileOf(after)));
  return { document, layout: buildSbsLayout(document, FLAT) };
}

const atTop = { deletions: 0, additions: 0 };

describe("sbsRowsSpan", () => {
  it.each([
    { name: "rows", rows: { start: 5, end: 8 }, expected: { top: 100, bottom: 160 } },
    { name: "a row at the top", rows: { start: 0, end: 1 }, expected: { top: 0, bottom: 20 } },
    {
      name: "no rows at the top of the file",
      rows: { start: 0, end: 0 },
      expected: { top: 0, bottom: 1 },
    },
    { name: "no rows mid-file", rows: { start: 5, end: 5 }, expected: { top: 99, bottom: 100 } },
  ])("measures $name", ({ rows, expected }) => {
    expect(sbsRowsSpan(rows, LINE_HEIGHT)).toEqual(expected);
  });
});

describe("sbsConnectorPath", () => {
  it("draws curves with control points at 0.3 and 0.7 of the width", () => {
    expect(sbsConnectorPath({ top: 100, bottom: 160 }, { top: 100, bottom: 240 }, 24)).toBe(
      "M0,100C7.2,100 16.8,100 24,100L24,240C16.8,240 7.2,160 0,160Z",
    );
  });

  it("rounds to two decimals", () => {
    expect(sbsConnectorPath({ top: 0.123456, bottom: 10 }, { top: 5, bottom: 10.5 }, 10)).toBe(
      "M0,0.12C3,0.12 7,5 10,5L10,10.5C7,10.5 3,10 0,10Z",
    );
  });
});

describe("sbsVisibleConnectors", () => {
  const connectorPaths = (
    shape: ReturnType<typeof replaced>,
    scrollTop = atTop,
    viewportHeight = 1000,
  ) =>
    sbsVisibleConnectors({
      ...shape,
      scrollTop,
      viewportHeight,
      lineHeight: LINE_HEIGHT,
    }).map((connector) => [connector.kind, connector.path]);

  it.each([
    {
      name: "a modified change",
      shape: replaced(10, 2, 5),
      expected: [["modified", "M0,200C7.2,200 16.8,200 24,200L24,300C16.8,300 7.2,240 0,240Z"]],
    },
    {
      name: "an insertion, empty on the left",
      shape: replaced(10, 0, 5),
      expected: [["inserted", "M0,199C7.2,199 16.8,200 24,200L24,300C16.8,300 7.2,200 0,200Z"]],
    },
    {
      name: "a deletion, empty on the right",
      shape: replaced(10, 5, 0),
      expected: [["deleted", "M0,200C7.2,200 16.8,199 24,199L24,200C16.8,200 7.2,300 0,300Z"]],
    },
    {
      name: "an insertion at row 0",
      shape: replaced(0, 0, 5),
      expected: [["inserted", "M0,0C7.2,0 16.8,0 24,0L24,100C16.8,100 7.2,1 0,1Z"]],
    },
    {
      name: "a deletion at row 0",
      shape: replaced(0, 5, 0),
      expected: [["deleted", "M0,0C7.2,0 16.8,0 24,0L24,1C16.8,1 7.2,100 0,100Z"]],
    },
  ])("draws $name", ({ shape, expected }) => {
    expect(connectorPaths(shape)).toEqual(expected);
  });

  it("measures each side from its own scroll position", () => {
    expect(connectorPaths(replaced(10, 2, 5), { deletions: 100, additions: 50 })).toEqual([
      ["modified", "M0,100C7.2,100 16.8,150 24,150L24,250C16.8,250 7.2,140 0,140Z"],
    ]);
  });

  it("scales the curves to a given width", () => {
    const shape = replaced(10, 2, 5);
    const [connector] = sbsVisibleConnectors({
      ...shape,
      scrollTop: atTop,
      viewportHeight: 1000,
      lineHeight: LINE_HEIGHT,
      width: 10,
    });
    expect(connector!.path).toBe("M0,200C3,200 7,200 10,200L10,300C7,300 3,240 0,240Z");
  });

  // The change sits at rows 10-11 on the left (y 200-240) and 10-14 on the right (y 200-300).
  it.each([
    {
      name: "above the viewport",
      scrollTop: { deletions: 0, additions: 0 },
      viewport: 100,
      visible: false,
    },
    {
      name: "starting at the viewport's bottom edge",
      scrollTop: { deletions: 100, additions: 100 },
      viewport: 100,
      visible: false,
    },
    {
      name: "starting 1px inside the bottom edge",
      scrollTop: { deletions: 101, additions: 101 },
      viewport: 100,
      visible: true,
    },
    {
      name: "ending at the viewport's top edge",
      scrollTop: { deletions: 300, additions: 300 },
      viewport: 100,
      visible: false,
    },
    {
      name: "ending 1px inside the top edge",
      scrollTop: { deletions: 299, additions: 299 },
      viewport: 100,
      visible: true,
    },
    {
      name: "with the left end above and the right end below",
      scrollTop: { deletions: 300, additions: 0 },
      viewport: 100,
      visible: true,
    },
    {
      name: "with the left end below and the right end above",
      scrollTop: { deletions: 0, additions: 300 },
      viewport: 100,
      visible: true,
    },
  ])("counts a change $name as visible: $visible", ({ scrollTop, viewport, visible }) => {
    expect(connectorPaths(replaced(10, 2, 5), scrollTop, viewport)).toHaveLength(visible ? 1 : 0);
  });

  it("keeps the change index of the connectors that cross", () => {
    const before = numbered(60);
    const after = before.map((line, index) =>
      index === 5 || index === 40 ? `edited${index}` : line,
    );
    const document = buildSbsDocument(parseDiffFromFile(fileOf(before), fileOf(after)));
    const layout = buildSbsLayout(document, FLAT);
    const connectors = sbsVisibleConnectors({
      document,
      layout,
      scrollTop: { deletions: 600, additions: 600 },
      viewportHeight: 400,
      lineHeight: LINE_HEIGHT,
    });
    expect(connectors.map((connector) => connector.change)).toEqual([1]);
  });
});

describe("sbsVisibleFoldLinks", () => {
  // Folds sit at rows 0, 10 and 20; the changes at rows 5 and 15.
  const { layout } = replaced(10, 2, 5);
  const folded = (() => {
    const before = numbered(100);
    const after = before.map((line, index) =>
      index === 10 || index === 71 ? `edited${index}` : line,
    );
    const document = buildSbsDocument(parseDiffFromFile(fileOf(before), fileOf(after)));
    return buildSbsLayout(document, { collapseUnchanged: true, expandedFolds: new Set() });
  })();

  it("has no links in a layout without folds", () => {
    expect(
      sbsVisibleFoldLinks({
        layout,
        scrollTop: atTop,
        viewportHeight: 1000,
        lineHeight: LINE_HEIGHT,
      }),
    ).toEqual([]);
  });

  it.each([
    {
      name: "the folds in the viewport",
      scrollTop: atTop,
      viewport: 300,
      expected: [
        { fold: 0, left: 10, right: 10 },
        { fold: 1, left: 210, right: 210 },
      ],
    },
    {
      name: "a fold whose two ends sit at different heights",
      scrollTop: { deletions: 0, additions: 150 },
      viewport: 300,
      expected: [
        { fold: 0, left: 10, right: -140 },
        { fold: 1, left: 210, right: 60 },
        { fold: 2, left: 410, right: 260 },
      ],
    },
    {
      name: "a fold centred on the top edge",
      scrollTop: { deletions: 10, additions: 10 },
      viewport: 5,
      expected: [{ fold: 0, left: 0, right: 0 }],
    },
    {
      name: "a fold centred just above the top edge",
      scrollTop: { deletions: 11, additions: 11 },
      viewport: 5,
      expected: [],
    },
    {
      name: "a fold centred on the bottom edge",
      scrollTop: atTop,
      viewport: 10,
      expected: [{ fold: 0, left: 10, right: 10 }],
    },
    {
      name: "a fold centred just below the bottom edge",
      scrollTop: atTop,
      viewport: 9,
      expected: [],
    },
  ])("lists $name", ({ scrollTop, viewport, expected }) => {
    expect(
      sbsVisibleFoldLinks({
        layout: folded,
        scrollTop,
        viewportHeight: viewport,
        lineHeight: LINE_HEIGHT,
      }),
    ).toEqual(expected);
  });
});

describe("sbsVisibleMoveShapes", () => {
  const block = [
    "function parseAmount(raw) {",
    "  const cleaned = raw.trim();",
    "  return Number(cleaned);",
  ];
  // The block sits at lines 3-5 before and 58-60 after: 55 rows, 1100px, apart.
  const before = [...numbered(2), ...block, ...numbered(55).map((line) => `${line}b`)];
  const after = [...numbered(2), ...numbered(55).map((line) => `${line}b`), ...block];
  const fileDiff = parseDiffFromFile(fileOf(before), fileOf(after));
  const document = buildSbsDocument(fileDiff);
  const moves = sbsMovesForFile(
    sbsDiffMovesOf([{ filePath: "file.txt", fileDiff }]),
    "file.txt",
    (path) => path,
  );
  const shapes = (scrollTop: { deletions: number; additions: number }, viewportHeight: number) =>
    sbsVisibleMoveShapes({
      layout: buildSbsLayout(document, FLAT),
      scrollTop,
      viewportHeight,
      lineHeight: LINE_HEIGHT,
      moves: sbsMoveLayerOf(document, moves),
    }).map((shape) => shape.kind);

  it.each([
    { name: "both ends in view", scrollTop: atTop, viewport: 1400, expected: ["band"] },
    { name: "only the old end in view", scrollTop: atTop, viewport: 400, expected: [] },
    {
      name: "the panes scrolled apart onto both ends",
      scrollTop: { deletions: 0, additions: 1100 },
      viewport: 400,
      expected: ["band"],
    },
  ])("draws a move within the file as one band with $name", ({ scrollTop, viewport, expected }) => {
    expect(shapes(scrollTop, viewport)).toEqual(expected);
  });

  it("draws a wedge on each side of a move to another file while that end is in view", () => {
    const other = parseDiffFromFile(fileOf(numbered(3)), fileOf([...numbered(3), ...block]));
    const diffMoves = sbsDiffMovesOf([
      { filePath: "a.txt", fileDiff: parseDiffFromFile(fileOf(before), fileOf(numbered(57))) },
      { filePath: "b.txt", fileDiff: other },
    ]);
    const otherDocument = buildSbsDocument(other);
    const incoming = sbsVisibleMoveShapes({
      layout: buildSbsLayout(otherDocument, FLAT),
      scrollTop: atTop,
      viewportHeight: 400,
      lineHeight: LINE_HEIGHT,
      moves: sbsMoveLayerOf(
        otherDocument,
        sbsMovesForFile(diffMoves, "b.txt", (path) => path),
      ),
    });
    expect(incoming.map((shape) => [shape.id, shape.kind])).toEqual([["additions:0", "wedge"]]);
  });
});
