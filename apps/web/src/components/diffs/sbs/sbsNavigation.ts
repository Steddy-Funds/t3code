import type { SbsLineRange } from "./sbsModel";

export type SbsNavigationDirection = "next" | "previous";

export interface SbsNavigationInput {
  /** The rows of every difference on the side that leads, in order. */
  readonly groupRows: ReadonlyArray<SbsLineRange>;
  /** The row a third of the way down the viewport: where a difference lands when stepped to. */
  readonly anchorRow: number;
  /** The difference last stepped to. A scroll by the user clears it. */
  readonly steppedGroup: number | null;
}

/**
 * The difference a step goes to, or null at the end of the file. After a step the next one
 * follows it in order; after the user scrolls, it is the first one past the anchor row
 * (JetBrains measures from the caret, which a web pane does not have).
 */
export function sbsStepTarget(
  input: SbsNavigationInput,
  direction: SbsNavigationDirection,
): number | null {
  const { groupRows, anchorRow, steppedGroup } = input;
  if (direction === "next") {
    const target =
      steppedGroup === null
        ? groupRows.findIndex((rows) => rows.start > anchorRow)
        : steppedGroup + 1;
    return target >= 0 && target < groupRows.length ? target : null;
  }
  const target =
    steppedGroup === null
      ? groupRows.findLastIndex((rows) => rows.start < anchorRow)
      : steppedGroup - 1;
  return target >= 0 ? target : null;
}

/** The difference the counter names: the one stepped to, else the one under the anchor row. */
export function sbsCurrentGroup(input: SbsNavigationInput): number | null {
  if (input.steppedGroup !== null) return input.steppedGroup;
  const index = input.groupRows.findIndex(
    (rows) => rows.start <= input.anchorRow && input.anchorRow < Math.max(rows.end, rows.start + 1),
  );
  return index >= 0 ? index : null;
}

/** "3 of 12" while on a difference, else "12 differences", as JetBrains words its status. */
export function sbsDifferenceLabel(current: number | null, count: number): string {
  if (count === 0) return "No differences";
  if (current !== null) return `${current + 1} of ${count}`;
  return count === 1 ? "1 difference" : `${count} differences`;
}
