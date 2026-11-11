import { sbsChangeRows, sbsRowCount, type SbsLayout } from "./sbsLayout";
import type { SbsLineRange, SbsSide } from "./sbsModel";

/**
 * Synchronized scrolling as JetBrains' side-by-side viewer does it. The functions follow
 * `SyncScrollSupport` and `BaseSyncScrollable` in intellij-community (platform/diff-impl,
 * com/intellij/diff/tools/util), with rows in place of its visual lines.
 */

/** A row on each side that shows the same place: the file ends and both ends of every change. */
export type SbsScrollAnchor = Readonly<Record<SbsSide, number>>;

export function sbsScrollAnchors(layout: SbsLayout): ReadonlyArray<SbsScrollAnchor> {
  const anchors: SbsScrollAnchor[] = [{ deletions: 0, additions: 0 }];
  layout.changeSegments.forEach((_, change) => {
    const deletions = sbsChangeRows(layout, change, "deletions");
    const additions = sbsChangeRows(layout, change, "additions");
    anchors.push({ deletions: deletions.start, additions: additions.start });
    anchors.push({ deletions: deletions.end, additions: additions.end });
  });
  anchors.push({
    deletions: sbsRowCount(layout, "deletions"),
    additions: sbsRowCount(layout, "additions"),
  });
  return anchors;
}

function otherSide(side: SbsSide): SbsSide {
  return side === "deletions" ? "additions" : "deletions";
}

/**
 * The other side's row for a row of `master` (`BaseSyncScrollable.getRange` and `transferLine`).
 * Between two anchors the rows run one to one until the other side's range ends, where they
 * wait; a row past the last anchor keeps its distance from it.
 */
export function transferRow(
  anchors: ReadonlyArray<SbsScrollAnchor>,
  master: SbsSide,
  row: number,
): number {
  const slave = otherSide(master);
  let start: SbsScrollAnchor = { deletions: 0, additions: 0 };
  let end = start;
  for (const anchor of anchors) {
    start = end;
    end = anchor;
    if (row <= anchor[master]) break;
  }
  if (start[master] === row) return start[slave];
  if (end[master] === row) return end[slave];
  if (end[master] < row) return row - end[master] + end[slave];
  return Math.min(start[slave] + (row - start[master]), end[slave]);
}

export interface SyncedScrollInput {
  readonly anchors: ReadonlyArray<SbsScrollAnchor>;
  /** The side the user is scrolling. */
  readonly master: SbsSide;
  readonly masterScrollTop: number;
  readonly slaveScrollTop: number;
  readonly viewportHeight: number;
  readonly lineHeight: number;
}

/**
 * Where the other pane scrolls to (`ScrollHelper.syncVerticalScroll`): the row a third of the
 * way down the master's viewport is mapped across and put at the same height, keeping the
 * master's offset inside that row so the motion stays continuous.
 */
export function syncedScrollTop(input: SyncedScrollInput): number {
  const { anchors, master, lineHeight, slaveScrollTop } = input;
  const middle = Math.floor(input.viewportHeight / 3);
  const masterOffset = input.masterScrollTop + middle;
  const masterRow = Math.floor(masterOffset / lineHeight);
  const slaveRow = transferRow(anchors, master, masterRow);
  const correction = masterOffset - masterRow * lineHeight;
  const offset = slaveRow * lineHeight - middle + correction;

  // Several master rows map to one slave row where the slave's range is the shorter one. The
  // offset inside the row would then rock the slave back and forth by under a line; hold it.
  const holdBackward =
    correction < lineHeight / 2 &&
    masterRow > 0 &&
    slaveRow === transferRow(anchors, master, masterRow - 1);
  const holdForward =
    correction > lineHeight / 2 && slaveRow === transferRow(anchors, master, masterRow + 1);
  if (
    ((holdForward && offset > slaveScrollTop) || (holdBackward && offset < slaveScrollTop)) &&
    Math.abs(offset - slaveScrollTop) < lineHeight
  ) {
    return slaveScrollTop;
  }
  return Math.max(0, offset);
}

export interface ChangeScrollTargetInput {
  /** The rows of the change on each side; an empty side has `start === end`. */
  readonly rows: Readonly<Record<SbsSide, SbsLineRange>>;
  readonly viewportHeight: number;
  readonly lineHeight: number;
  readonly maxScrollTop: Readonly<Record<SbsSide, number>>;
}

/**
 * Scroll positions that show a change on both sides (`SyncScrollSupport.getTargetOffsets`): its
 * top a third of the way down, or higher when it is too tall for that, with two lines above it;
 * near the end of a file, as much of it as fits, the top always in view.
 */
export function changeScrollTargets(input: ChangeScrollTargetInput): Record<SbsSide, number> {
  const { rows, viewportHeight, lineHeight, maxScrollTop } = input;
  const sides = ["deletions", "additions"] as const;
  const gap = 2 * lineHeight;
  const top = { deletions: 0, additions: 0 };
  const height = { deletions: 0, additions: 0 };
  let topShift = Infinity;
  for (const side of sides) {
    top[side] = rows[side].start * lineHeight;
    // One line past the range, as JetBrains measures it.
    height[side] = (rows[side].end - rows[side].start + 1) * lineHeight;
    const fits = 2 * gap + height[side] <= viewportHeight;
    const shift = fits
      ? Math.min(viewportHeight - gap - height[side], Math.floor(viewportHeight / 3))
      : gap;
    topShift = Math.min(topShift, shift);
  }
  // At the top of a file there is less room above the change than the shift wants.
  topShift = Math.min(topShift, top.deletions, top.additions);

  const targets = { deletions: top.deletions - topShift, additions: top.additions - topShift };
  if (sides.every((side) => maxScrollTop[side] > targets[side])) return targets;

  // A range near the end of its file cannot go that high, so align on what can be reached.
  const endShift = Math.max(
    0,
    top.deletions - maxScrollTop.deletions,
    top.additions - maxScrollTop.additions,
  );
  for (const side of sides) {
    const showMore = Math.max(endShift + height[side] + gap - viewportHeight, 0);
    targets[side] = Math.max(0, Math.min(top[side] - endShift + showMore, top[side] - gap));
  }
  return targets;
}
