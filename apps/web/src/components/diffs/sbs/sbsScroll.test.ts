import { parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { buildSbsLayout } from "./sbsLayout";
import { buildSbsDocument, type SbsSide } from "./sbsModel";
import {
  changeScrollTargets,
  sbsScrollAnchors,
  syncedScrollTop,
  transferRow,
  type SbsScrollAnchor,
} from "./sbsScroll";

const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line${index + 1}`);
const fileOf = (lines: ReadonlyArray<string>) => ({
  name: "file.txt",
  contents: lines.map((line) => `${line}\n`).join(""),
});

/** Anchors of 60 lines in which `removed` lines at `at` become `added` new ones. */
function anchorsOf(at: number, removed: number, added: number) {
  const before = numbered(60);
  const after = [
    ...before.slice(0, at),
    ...numbered(added).map((l) => `new${l}`),
    ...before.slice(at + removed),
  ];
  const document = buildSbsDocument(parseDiffFromFile(fileOf(before), fileOf(after)));
  return sbsScrollAnchors(
    buildSbsLayout(document, { collapseUnchanged: false, expandedFolds: new Set() }),
  );
}

describe("sbsScrollAnchors", () => {
  it("holds the file ends and both ends of every change", () => {
    expect(anchorsOf(10, 2, 5)).toEqual([
      { deletions: 0, additions: 0 },
      { deletions: 10, additions: 10 },
      { deletions: 12, additions: 15 },
      { deletions: 60, additions: 63 },
    ]);
  });
});

describe("transferRow", () => {
  const insertion = anchorsOf(10, 0, 5);
  const deletion = anchorsOf(10, 5, 0);
  const modified = anchorsOf(10, 2, 5);

  it.each([
    // The side without the block jumps over it in one row.
    { name: "insertion", anchors: insertion, master: "deletions", row: 9, expected: 9 },
    { name: "insertion", anchors: insertion, master: "deletions", row: 10, expected: 10 },
    { name: "insertion", anchors: insertion, master: "deletions", row: 11, expected: 16 },
    { name: "insertion", anchors: insertion, master: "deletions", row: 12, expected: 17 },
    { name: "deletion", anchors: deletion, master: "additions", row: 9, expected: 9 },
    { name: "deletion", anchors: deletion, master: "additions", row: 10, expected: 10 },
    { name: "deletion", anchors: deletion, master: "additions", row: 11, expected: 16 },
    // The side with the block holds the other until the block ends, then lines up again.
    { name: "insertion", anchors: insertion, master: "additions", row: 9, expected: 9 },
    { name: "insertion", anchors: insertion, master: "additions", row: 10, expected: 10 },
    { name: "insertion", anchors: insertion, master: "additions", row: 11, expected: 10 },
    { name: "insertion", anchors: insertion, master: "additions", row: 14, expected: 10 },
    { name: "insertion", anchors: insertion, master: "additions", row: 15, expected: 10 },
    { name: "insertion", anchors: insertion, master: "additions", row: 16, expected: 11 },
    { name: "insertion", anchors: insertion, master: "additions", row: 17, expected: 12 },
    { name: "deletion", anchors: deletion, master: "deletions", row: 10, expected: 10 },
    { name: "deletion", anchors: deletion, master: "deletions", row: 11, expected: 10 },
    { name: "deletion", anchors: deletion, master: "deletions", row: 14, expected: 10 },
    { name: "deletion", anchors: deletion, master: "deletions", row: 15, expected: 10 },
    { name: "deletion", anchors: deletion, master: "deletions", row: 16, expected: 11 },
    // A modified block runs one to one until the shorter side ends.
    { name: "2 to 5", anchors: modified, master: "deletions", row: 10, expected: 10 },
    { name: "2 to 5", anchors: modified, master: "deletions", row: 11, expected: 11 },
    { name: "2 to 5", anchors: modified, master: "deletions", row: 12, expected: 15 },
    { name: "2 to 5", anchors: modified, master: "deletions", row: 13, expected: 16 },
    { name: "2 to 5", anchors: modified, master: "additions", row: 11, expected: 11 },
    { name: "2 to 5", anchors: modified, master: "additions", row: 12, expected: 12 },
    { name: "2 to 5", anchors: modified, master: "additions", row: 13, expected: 12 },
    { name: "2 to 5", anchors: modified, master: "additions", row: 15, expected: 12 },
    { name: "2 to 5", anchors: modified, master: "additions", row: 16, expected: 13 },
    // The ends of the file.
    { name: "2 to 5", anchors: modified, master: "deletions", row: 0, expected: 0 },
    { name: "2 to 5", anchors: modified, master: "deletions", row: 60, expected: 63 },
    { name: "2 to 5", anchors: modified, master: "deletions", row: 70, expected: 73 },
    { name: "2 to 5", anchors: modified, master: "additions", row: 70, expected: 67 },
  ] satisfies ReadonlyArray<{
    name: string;
    anchors: ReadonlyArray<SbsScrollAnchor>;
    master: SbsSide;
    row: number;
    expected: number;
  }>)(
    "maps $master row $row of a $name file to $expected",
    ({ anchors, master, row, expected }) => {
      expect(transferRow(anchors, master, row)).toBe(expected);
    },
  );
});

describe("syncedScrollTop", () => {
  const frame = { viewportHeight: 300, lineHeight: 20 } as const;

  it.each([
    {
      name: "no change above the anchor row",
      anchors: anchorsOf(10, 2, 5),
      master: "deletions",
      expected: 0,
    },
    {
      name: "no change above the anchor row, from the other side",
      anchors: anchorsOf(10, 2, 5),
      master: "additions",
      expected: 0,
    },
    {
      name: "an insertion above the anchor row",
      anchors: anchorsOf(2, 0, 5),
      master: "deletions",
      expected: 100,
    },
    {
      name: "a result above the top of the other pane",
      anchors: anchorsOf(2, 0, 5),
      master: "additions",
      expected: 0,
    },
  ] satisfies ReadonlyArray<{
    name: string;
    anchors: ReadonlyArray<SbsScrollAnchor>;
    master: SbsSide;
    expected: number;
  }>)("maps scrollTop 0 to $expected with $name", ({ anchors, master, expected }) => {
    expect(
      syncedScrollTop({ ...frame, anchors, master, masterScrollTop: 0, slaveScrollTop: 0 }),
    ).toBe(expected);
  });

  it("keeps a row past the last anchor at its distance", () => {
    const anchors = anchorsOf(10, 2, 5);
    expect(
      syncedScrollTop({
        ...frame,
        anchors,
        master: "deletions",
        masterScrollTop: 1200,
        slaveScrollTop: 0,
      }),
    ).toBe(1200 + 3 * 20);
  });

  describe("inside one row", () => {
    it.each([
      { master: "deletions", base: 1000, expected: 1100 },
      { master: "additions", base: 1100, expected: 1000 },
    ] satisfies ReadonlyArray<{ master: SbsSide; base: number; expected: number }>)(
      "moves $master by k pixels and the other pane by k pixels",
      ({ master, base, expected }) => {
        const anchors = anchorsOf(10, 0, 5);
        for (const k of [0, 1, 7, 10, 19]) {
          expect(
            syncedScrollTop({
              ...frame,
              anchors,
              master,
              masterScrollTop: base + k,
              slaveScrollTop: expected,
            }),
          ).toBe(expected + k);
        }
      },
    );
  });

  describe("where the other pane waits", () => {
    // Additions rows 10..14 are the insertion: all of them show deletions row 10. Scrolling
    // additions to row 12 plus `offset` px puts the unheld position at 100 + offset.
    const anchors = anchorsOf(10, 0, 5);
    const slaveTopFor = (masterScrollTop: number, slaveScrollTop: number) =>
      syncedScrollTop({
        ...frame,
        anchors,
        master: "additions",
        masterScrollTop,
        slaveScrollTop,
      });

    it.each([
      { offset: 2, slave: 105, expected: 105 },
      { offset: 2, slave: 119, expected: 119 },
      { offset: 2, slave: 122, expected: 102 },
      { offset: 2, slave: 95, expected: 102 },
      { offset: 15, slave: 110, expected: 110 },
      { offset: 15, slave: 100, expected: 100 },
      { offset: 15, slave: 95, expected: 115 },
      { offset: 15, slave: 125, expected: 115 },
      { offset: 10, slave: 105, expected: 110 },
      { offset: 10, slave: 115, expected: 110 },
    ])(
      "$offset px into the row with the other pane at $slave gives $expected",
      ({ offset, slave, expected }) => {
        expect(slaveTopFor(140 + offset, slave)).toBe(expected);
      },
    );

    it.each([
      { direction: "down", tops: Array.from({ length: 80 }, (_, index) => 120 + index) },
      { direction: "up", tops: Array.from({ length: 80 }, (_, index) => 199 - index) },
    ])("holds still while additions scrolls $direction through the block", ({ tops }) => {
      let slave = 110;
      for (const top of tops) {
        slave = slaveTopFor(top, slave);
        expect(slave).toBe(110);
      }
    });
  });
});

describe("changeScrollTargets", () => {
  const frame = {
    viewportHeight: 300,
    lineHeight: 20,
    maxScrollTop: { deletions: 1000, additions: 1000 },
  };

  it.each([
    {
      name: "a change that fits goes a third of the way down",
      rows: { deletions: { start: 10, end: 12 }, additions: { start: 10, end: 12 } },
      expected: { deletions: 100, additions: 100 },
    },
    {
      name: "a change at the top of the file stays at the top",
      rows: { deletions: { start: 0, end: 2 }, additions: { start: 0, end: 2 } },
      expected: { deletions: 0, additions: 0 },
    },
    {
      name: "a change too tall for that keeps two lines above it",
      rows: { deletions: { start: 10, end: 31 }, additions: { start: 10, end: 31 } },
      expected: { deletions: 160, additions: 160 },
    },
    {
      name: "an insertion lines up its empty side at the same height",
      rows: { deletions: { start: 10, end: 10 }, additions: { start: 10, end: 15 } },
      expected: { deletions: 100, additions: 100 },
    },
  ])("$name", ({ rows, expected }) => {
    expect(changeScrollTargets({ ...frame, rows })).toEqual(expected);
  });

  it("limits the shift by the taller side in a short viewport", () => {
    expect(
      changeScrollTargets({
        ...frame,
        viewportHeight: 200,
        rows: { deletions: { start: 10, end: 10 }, additions: { start: 10, end: 15 } },
      }),
    ).toEqual({ deletions: 160, additions: 160 });
  });

  it("aligns on what can be reached near the end of the files", () => {
    expect(
      changeScrollTargets({
        ...frame,
        maxScrollTop: { deletions: 80, additions: 80 },
        rows: { deletions: { start: 10, end: 12 }, additions: { start: 10, end: 12 } },
      }),
    ).toEqual({ deletions: 80, additions: 80 });
  });
});
