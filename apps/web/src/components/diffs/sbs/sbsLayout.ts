import type { SbsDocument, SbsLineRange, SbsSide } from "./sbsModel";

/** Unchanged lines kept beside a change when the rest of the run is folded. JetBrains' default. */
export const SBS_FOLD_CONTEXT_LINES = 4;
/** A fold that would hide fewer lines than this is not made. */
const MIN_FOLDED_LINES = 2;

/**
 * A run of rows that both panes lay out together. Every row is one line high, so a row index
 * times the line height is its position: a fold and a patch gap each take one row on each side.
 */
export type SbsSegment =
  | {
      readonly kind: "lines";
      readonly deletions: SbsLineRange;
      readonly additions: SbsLineRange;
    }
  | {
      readonly kind: "change";
      readonly change: number;
      readonly deletions: SbsLineRange;
      readonly additions: SbsLineRange;
    }
  | {
      /** Unchanged lines hidden behind one row. `fold` names the run it belongs to. */
      readonly kind: "fold";
      readonly fold: number;
      readonly deletions: SbsLineRange;
      readonly additions: SbsLineRange;
    }
  | {
      /** Lines a patch does not carry: one row, nothing to expand. Its ranges are empty. */
      readonly kind: "omitted";
      readonly lines: number;
      readonly deletions: SbsLineRange;
      readonly additions: SbsLineRange;
    };

export interface SbsLayout {
  readonly segments: ReadonlyArray<SbsSegment>;
  /** The first row of each segment per side, then the side's row count. */
  readonly rows: Readonly<Record<SbsSide, ReadonlyArray<number>>>;
  /** The segment of each change, by change index. */
  readonly changeSegments: ReadonlyArray<number>;
}

export interface SbsLayoutOptions {
  readonly collapseUnchanged: boolean;
  readonly expandedFolds: ReadonlySet<number>;
  readonly contextLines?: number;
}

function segmentRowCount(segment: SbsSegment, side: SbsSide): number {
  return segment.kind === "fold" || segment.kind === "omitted"
    ? 1
    : segment[side].end - segment[side].start;
}

export function buildSbsLayout(document: SbsDocument, options: SbsLayoutOptions): SbsLayout {
  const context = options.contextLines ?? SBS_FOLD_CONTEXT_LINES;
  const segments: SbsSegment[] = [];
  const changeSegments: number[] = [];
  const lineCounts = {
    deletions: document.lines.deletions.length,
    additions: document.lines.additions.length,
  };
  // With nothing changed there is nothing to keep context around, so nothing folds.
  const canFold = options.collapseUnchanged && document.changes.length > 0;
  let deletions = 0;
  let additions = 0;
  let fold = 0;
  let omittedIndex = 0;

  /** `count` unchanged lines from the cursor: shown, or folded down to the context kept at each end. */
  const pushUnchanged = (count: number, keepStart: number, keepEnd: number) => {
    const run = fold;
    fold += 1;
    if (count === 0) return;
    const hidden = count - keepStart - keepEnd;
    const pushLines = (lines: number) => {
      if (lines === 0) return;
      segments.push({
        kind: "lines",
        deletions: { start: deletions, end: deletions + lines },
        additions: { start: additions, end: additions + lines },
      });
      deletions += lines;
      additions += lines;
    };
    if (!canFold || hidden < MIN_FOLDED_LINES || options.expandedFolds.has(run)) {
      pushLines(count);
      return;
    }
    pushLines(keepStart);
    segments.push({
      kind: "fold",
      fold: run,
      deletions: { start: deletions, end: deletions + hidden },
      additions: { start: additions, end: additions + hidden },
    });
    deletions += hidden;
    additions += hidden;
    pushLines(keepEnd);
  };

  /** Unchanged lines up to a position, split where a patch left lines out. */
  const pushUnchangedUntil = (
    until: Record<SbsSide, number>,
    afterChange: boolean,
    beforeChange: boolean,
  ) => {
    let touchesChangeBefore = afterChange;
    for (;;) {
      const gap = document.omitted[omittedIndex];
      // Both sides: an insertion that ends a hunk shares its old-side index with the next gap.
      const gapHere =
        gap !== undefined && gap.deletions <= until.deletions && gap.additions <= until.additions;
      const end = gapHere ? gap.deletions : until.deletions;
      pushUnchanged(
        end - deletions,
        touchesChangeBefore ? context : 0,
        !gapHere && beforeChange ? context : 0,
      );
      if (!gapHere) return;
      segments.push({
        kind: "omitted",
        lines: gap.lines,
        deletions: { start: deletions, end: deletions },
        additions: { start: additions, end: additions },
      });
      omittedIndex += 1;
      touchesChangeBefore = false;
    }
  };

  document.changes.forEach((change, index) => {
    pushUnchangedUntil(
      { deletions: change.deletions.start, additions: change.additions.start },
      index > 0,
      true,
    );
    changeSegments.push(segments.length);
    segments.push({
      kind: "change",
      change: index,
      deletions: change.deletions,
      additions: change.additions,
    });
    deletions = change.deletions.end;
    additions = change.additions.end;
  });
  pushUnchangedUntil(lineCounts, document.changes.length > 0, false);
  // A side can end with lines the other does not have only inside a change, so this is a guard.
  if (additions < lineCounts.additions) {
    segments.push({
      kind: "lines",
      deletions: { start: deletions, end: deletions },
      additions: { start: additions, end: lineCounts.additions },
    });
  }

  const rows: Record<SbsSide, number[]> = { deletions: [0], additions: [0] };
  for (const segment of segments) {
    rows.deletions.push(rows.deletions.at(-1)! + segmentRowCount(segment, "deletions"));
    rows.additions.push(rows.additions.at(-1)! + segmentRowCount(segment, "additions"));
  }
  return { segments, rows, changeSegments };
}

export function sbsRowCount(layout: SbsLayout, side: SbsSide): number {
  return layout.rows[side].at(-1) ?? 0;
}

/** The segment a row belongs to. A row past the end gives the last segment. */
export function sbsSegmentAtRow(layout: SbsLayout, side: SbsSide, row: number): number {
  const starts = layout.rows[side];
  let low = 0;
  let high = layout.segments.length - 1;
  // The last segment that starts at or before the row; a segment with no rows on this side
  // shares its start with the next one and is passed over.
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (starts[middle]! <= row) low = middle;
    else high = middle - 1;
  }
  return low;
}

export interface SbsRowTarget {
  readonly segment: number;
  /** The line this row shows, or null for a fold or a patch gap. */
  readonly line: number | null;
}

export function sbsRowTarget(layout: SbsLayout, side: SbsSide, row: number): SbsRowTarget | null {
  if (row < 0 || row >= sbsRowCount(layout, side)) return null;
  const index = sbsSegmentAtRow(layout, side, row);
  const segment = layout.segments[index]!;
  if (segment.kind === "fold" || segment.kind === "omitted") return { segment: index, line: null };
  return { segment: index, line: segment[side].start + (row - layout.rows[side][index]!) };
}

export interface SbsLineRow {
  readonly segment: number;
  readonly row: number;
  /** True when the line sits inside a fold; `row` is then the fold's row. */
  readonly folded: boolean;
}

/** The row that shows a line. A line index equal to the line count gives the row after the last. */
export function sbsLineRow(layout: SbsLayout, side: SbsSide, line: number): SbsLineRow {
  const { segments } = layout;
  let low = 0;
  let high = segments.length;
  // The first segment whose lines on this side end after the line.
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle]![side].end > line) high = middle;
    else low = middle + 1;
  }
  const segment = segments[low];
  if (segment === undefined) {
    return { segment: Math.max(0, segments.length - 1), row: sbsRowCount(layout, side), folded: false };
  }
  const firstRow = layout.rows[side][low]!;
  if (segment.kind === "fold") return { segment: low, row: firstRow, folded: true };
  return { segment: low, row: firstRow + Math.max(0, line - segment[side].start), folded: false };
}

/** The rows of a line range. An empty range gives the same row twice: the boundary it sits on. */
export function sbsRangeRows(layout: SbsLayout, side: SbsSide, range: SbsLineRange): SbsLineRange {
  const start = sbsLineRow(layout, side, range.start).row;
  if (range.end <= range.start) return { start, end: start };
  const last = sbsLineRow(layout, side, range.end - 1);
  return { start, end: last.row + 1 };
}

/** The rows of a change on one side. */
export function sbsChangeRows(layout: SbsLayout, change: number, side: SbsSide): SbsLineRange {
  const index = layout.changeSegments[change];
  if (index === undefined) return { start: 0, end: 0 };
  return { start: layout.rows[side][index]!, end: layout.rows[side][index + 1]! };
}

/** The folds that hide any line of the range, so a caller can open them. */
export function sbsFoldsCovering(
  layout: SbsLayout,
  side: SbsSide,
  range: SbsLineRange,
): ReadonlyArray<number> {
  const folds: number[] = [];
  for (const segment of layout.segments) {
    if (segment.kind !== "fold") continue;
    if (segment[side].start < Math.max(range.end, range.start + 1) && segment[side].end > range.start) {
      folds.push(segment.fold);
    }
  }
  return folds;
}
