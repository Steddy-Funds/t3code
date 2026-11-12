import { describe, expect, it } from "vite-plus/test";

import {
  sbsCurrentGroup,
  sbsDifferenceLabel,
  sbsStepTarget,
  type SbsNavigationInput,
} from "./sbsNavigation";

const groupRows = [
  { start: 5, end: 7 },
  { start: 20, end: 20 },
  { start: 40, end: 45 },
];

const input = (anchorRow: number, steppedGroup: number | null): SbsNavigationInput => ({
  groupRows,
  anchorRow,
  steppedGroup,
});

describe("sbsStepTarget", () => {
  it.each([
    { steppedGroup: 0, direction: "next", expected: 1 },
    { steppedGroup: 1, direction: "next", expected: 2 },
    { steppedGroup: 2, direction: "next", expected: null },
    { steppedGroup: 2, direction: "previous", expected: 1 },
    { steppedGroup: 1, direction: "previous", expected: 0 },
    { steppedGroup: 0, direction: "previous", expected: null },
  ] as const)(
    "after a step to $steppedGroup, $direction is $expected whatever the anchor row",
    ({ steppedGroup, direction, expected }) => {
      expect(sbsStepTarget(input(0, steppedGroup), direction)).toBe(expected);
      expect(sbsStepTarget(input(1000, steppedGroup), direction)).toBe(expected);
    },
  );

  it.each([
    { anchorRow: 0, direction: "next", expected: 0 },
    { anchorRow: 4, direction: "next", expected: 0 },
    { anchorRow: 5, direction: "next", expected: 1 },
    { anchorRow: 6, direction: "next", expected: 1 },
    { anchorRow: 20, direction: "next", expected: 2 },
    { anchorRow: 40, direction: "next", expected: null },
    { anchorRow: 1000, direction: "next", expected: null },
    { anchorRow: 1000, direction: "previous", expected: 2 },
    { anchorRow: 41, direction: "previous", expected: 2 },
    { anchorRow: 40, direction: "previous", expected: 1 },
    { anchorRow: 21, direction: "previous", expected: 1 },
    { anchorRow: 6, direction: "previous", expected: 0 },
    { anchorRow: 5, direction: "previous", expected: null },
    { anchorRow: 0, direction: "previous", expected: null },
  ] as const)(
    "after a scroll to anchor row $anchorRow, $direction is $expected",
    ({ anchorRow, direction, expected }) => {
      expect(sbsStepTarget(input(anchorRow, null), direction)).toBe(expected);
    },
  );

  it("has no target in a file without differences", () => {
    const none = { groupRows: [], anchorRow: 3, steppedGroup: null };
    expect(sbsStepTarget(none, "next")).toBeNull();
    expect(sbsStepTarget(none, "previous")).toBeNull();
  });
});

describe("sbsCurrentGroup", () => {
  it.each([
    { name: "the one stepped to", anchorRow: 1000, steppedGroup: 1, expected: 1 },
    { name: "none before the first", anchorRow: 4, steppedGroup: null, expected: null },
    { name: "the one at its first row", anchorRow: 5, steppedGroup: null, expected: 0 },
    { name: "the one at its last row", anchorRow: 6, steppedGroup: null, expected: 0 },
    { name: "none just past its end", anchorRow: 7, steppedGroup: null, expected: null },
    { name: "an empty one, at its row", anchorRow: 20, steppedGroup: null, expected: 1 },
    { name: "an empty one, not past it", anchorRow: 21, steppedGroup: null, expected: null },
  ])("names $name", ({ anchorRow, steppedGroup, expected }) => {
    expect(sbsCurrentGroup(input(anchorRow, steppedGroup))).toBe(expected);
  });
});

describe("sbsDifferenceLabel", () => {
  it.each([
    { current: 2, count: 12, label: "3 of 12" },
    { current: 0, count: 12, label: "1 of 12" },
    { current: 0, count: 1, label: "1 of 1" },
    { current: null, count: 12, label: "12 differences" },
    { current: null, count: 2, label: "2 differences" },
    { current: null, count: 1, label: "1 difference" },
    { current: null, count: 0, label: "No differences" },
    { current: 0, count: 0, label: "No differences" },
  ])("reads $label", ({ current, count, label }) => {
    expect(sbsDifferenceLabel(current, count)).toBe(label);
  });
});
