import type { LineDiffRangeCache } from "@pierre/diffs";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "~/lib/utils";

import type { SbsFindMatch } from "./sbsFind";
import { sbsLineChange, type SbsHighlightMode } from "./sbsInline";
import { sbsRowTarget, type SbsLayout } from "./sbsLayout";
import {
  NO_LINE_MARKS,
  sbsTextPieces,
  sbsTokensFromHast,
  sbsTokenStyle,
  type SbsColumnRange,
  type SbsLineMarks,
} from "./sbsLineContent";
import { sbsLineNumber, type SbsChangeKind, type SbsDocument, type SbsSide } from "./sbsModel";

/** An annotated range of this pane, in line indices. `end` is exclusive. */
export interface SbsPaneAnnotation {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

export interface SbsPaneProps {
  readonly side: SbsSide;
  readonly label: string;
  readonly document: SbsDocument;
  readonly layout: SbsLayout;
  /** The rows to render. `lastRow` is exclusive. */
  readonly firstRow: number;
  readonly lastRow: number;
  readonly lineHeight: number;
  readonly gutterDigits: number;
  /** The widest line of either pane, in columns: both panes scroll sideways the same distance. */
  readonly contentColumns: number;
  readonly highlightMode: SbsHighlightMode;
  readonly wordRanges: LineDiffRangeCache;
  readonly highlightedRows: ArrayLike<unknown> | null;
  /** The find bar's matches under the line each is on; null while it is closed for this pane. */
  readonly findMatches: ReadonlyMap<number, ReadonlyArray<SbsFindMatch>> | null;
  readonly findCurrent: SbsFindMatch | null;
  readonly annotations: ReadonlyArray<SbsPaneAnnotation>;
  readonly openAnnotationId: string | null;
  /** The lines picked in the gutter, as line indices; `selectedEnd` is exclusive. */
  readonly selectedStart: number;
  readonly selectedEnd: number;
  /** Room below the last row to scroll into. */
  readonly tailHeight: number;
  /** The other pane carries the one visible scrollbar. */
  readonly hideScrollbar: boolean;
  readonly scrollerRef: (element: HTMLDivElement | null) => void;
  readonly onScroll: (side: SbsSide) => void;
}

type LineTokens = ReturnType<typeof sbsTokensFromHast>;

const tokenCache = new WeakMap<object, Map<number, LineTokens>>();

/**
 * A line's tokens, read once. The worker pool's rows decode a line on every access and hand
 * back a new object each time, so reading them in render would redo that work every frame
 * and give every row new tokens to draw.
 */
function tokensOfRow(rows: ArrayLike<unknown> | null, line: number, text: string): LineTokens {
  if (rows === null) return null;
  let lines = tokenCache.get(rows);
  if (!lines) tokenCache.set(rows, (lines = new Map()));
  const cached = lines.get(line);
  if (cached !== undefined) return cached;
  const tokens = sbsTokensFromHast(rows[line], text);
  lines.set(line, tokens);
  return tokens;
}

/**
 * The colour of the change that has no lines on this side and sits just above a row, so the
 * row can draw the line that marks where the other side's lines belong.
 */
function insertionPointAbove(
  document: SbsDocument,
  layout: SbsLayout,
  side: SbsSide,
  segmentIndex: number,
  row: number,
): SbsChangeKind | null {
  if (row !== layout.rows[side][segmentIndex]) return null;
  for (let index = segmentIndex - 1; index >= 0; index -= 1) {
    if (layout.rows[side][index] !== row) return null;
    const segment = layout.segments[index]!;
    if (segment.kind === "change") return document.changes[segment.change]?.kind ?? null;
  }
  return null;
}

function insertionPointBelowLastRow(
  document: SbsDocument,
  layout: SbsLayout,
  side: SbsSide,
  row: number,
): SbsChangeKind | null {
  const rowCount = layout.rows[side].at(-1) ?? 0;
  if (row !== rowCount - 1) return null;
  for (let index = layout.segments.length - 1; index >= 0; index -= 1) {
    if (layout.rows[side][index] !== rowCount) return null;
    const segment = layout.segments[index]!;
    if (segment.kind === "change") return document.changes[segment.change]?.kind ?? null;
  }
  return null;
}

function pieceClassName(piece: { changed: boolean; match: 0 | 1 | 2 }): string | undefined {
  const match =
    piece.match === 2 ? "sbs-match sbs-match-current" : piece.match === 1 ? "sbs-match" : "";
  if (!piece.changed) return match || undefined;
  return match ? `sbs-word ${match}` : "sbs-word";
}

function LineText({
  text,
  tokens,
  marks,
}: {
  text: string;
  tokens: LineTokens;
  marks: SbsLineMarks;
}) {
  if (text.length === 0) return <br />;
  if (tokens === null && marks === NO_LINE_MARKS) return text;
  return sbsTextPieces(text, tokens, marks).map((piece) => {
    const className = pieceClassName(piece);
    // Plain text needs no element of its own.
    if (piece.style === undefined && className === undefined) return piece.text;
    return (
      <span key={piece.start} style={sbsTokenStyle(piece.style)} className={className}>
        {piece.text}
      </span>
    );
  });
}

function lineMarks(
  changed: ReadonlyArray<SbsColumnRange>,
  matches: ReadonlyArray<SbsFindMatch> | undefined,
  current: SbsFindMatch | null,
  line: number,
): SbsLineMarks {
  if (changed.length === 0 && matches === undefined) return NO_LINE_MARKS;
  return {
    changed,
    matches: (matches ?? []).map((match) => [match.start, match.end] as const),
    currentMatch: current?.line === line ? [current.start, current.end] : null,
  };
}

/** Everything a row is drawn from besides its own position. */
type RowContext = Pick<
  SbsPaneProps,
  | "side"
  | "document"
  | "layout"
  | "highlightMode"
  | "wordRanges"
  | "highlightedRows"
  | "findMatches"
  | "findCurrent"
  | "annotations"
  | "openAnnotationId"
  | "selectedStart"
  | "selectedEnd"
>;

const ROW_CONTEXT_KEYS = [
  "side",
  "document",
  "layout",
  "highlightMode",
  "wordRanges",
  "highlightedRows",
  "findMatches",
  "findCurrent",
  "annotations",
  "openAnnotationId",
  "selectedStart",
  "selectedEnd",
] as const satisfies ReadonlyArray<keyof RowContext>;

const rowContexts = new WeakMap<SbsLayout, Partial<Record<SbsSide, RowContext>>>();

/** The one context object for these inputs, so a pane's rows can be kept under it. */
function rowContextOf(next: RowContext): RowContext {
  let bySide = rowContexts.get(next.layout);
  if (!bySide) rowContexts.set(next.layout, (bySide = {}));
  const last = bySide[next.side];
  if (last && ROW_CONTEXT_KEYS.every((key) => last[key] === next[key])) return last;
  bySide[next.side] = next;
  return next;
}

const keptRows = new WeakMap<RowContext, Map<number, ReactNode>>();
/** Rows kept beyond the window before the ones far from it are dropped. */
const MAX_KEPT_ROWS = 400;

/**
 * The window's rows. A row is rendered once and kept while nothing it is drawn from changes,
 * so a scroll that moves the window renders only the rows that entered it: React sees the
 * rest as the same elements and leaves them alone.
 */
function windowRows(context: RowContext, firstRow: number, lastRow: number): ReactNode[] {
  let kept = keptRows.get(context);
  if (!kept) keptRows.set(context, (kept = new Map()));
  if (kept.size > MAX_KEPT_ROWS) {
    for (const row of kept.keys()) {
      if (row < firstRow || row >= lastRow) kept.delete(row);
    }
  }
  const rows: ReactNode[] = [];
  for (let row = firstRow; row < lastRow; row += 1) {
    let element = kept.get(row);
    if (element === undefined) {
      element = renderRow(context, row);
      kept.set(row, element);
    }
    if (element === null) break;
    rows.push(element);
  }
  return rows;
}

/** One row, or null past the last one. */
function renderRow(context: RowContext, row: number): ReactNode {
  const { side, document, layout } = context;
  const target = sbsRowTarget(layout, side, row);
  if (target === null) return null;
  const segment = layout.segments[target.segment]!;
  if (segment.kind === "fold") {
    const hidden = segment[side].end - segment[side].start;
    return (
      <button
        key={`fold:${segment.fold}`}
        type="button"
        className="sbs-row sbs-fold"
        data-sbs-fold={segment.fold}
        aria-label={`Show ${hidden} unchanged lines`}
      />
    );
  }
  if (segment.kind === "omitted") {
    return (
      <div key={`omitted:${target.segment}`} className="sbs-row sbs-omitted">
        <span className="sbs-omitted-label">
          {segment.lines === 1
            ? "1 line not in the patch"
            : `${segment.lines} lines not in the patch`}
        </span>
      </div>
    );
  }

  const line = target.line!;
  const text = document.lines[side][line] ?? "";
  const change =
    segment.kind === "change"
      ? sbsLineChange(
          document,
          context.wordRanges,
          context.highlightMode,
          side,
          line,
          document.changes[segment.change]!,
        )
      : null;
  const annotation = context.annotations.find((item) => item.start <= line && line < item.end);
  const marksInsertions = context.highlightMode !== "none";
  const above = marksInsertions
    ? insertionPointAbove(document, layout, side, target.segment, row)
    : null;
  const below = marksInsertions ? insertionPointBelowLastRow(document, layout, side, row) : null;
  const selected = context.selectedStart <= line && line < context.selectedEnd;
  return (
    <div
      key={line}
      className="sbs-row"
      data-sbs-index={line}
      data-tint={change?.tint ?? undefined}
      data-selected={selected ? "" : undefined}
      data-insert-above={above ?? undefined}
      data-insert-below={below ?? undefined}
    >
      <span
        className="sbs-gutter"
        data-sbs-gutter=""
        data-annotated={annotation ? "" : undefined}
        data-annotation-open={annotation?.id === context.openAnnotationId ? "" : undefined}
      >
        {annotation && annotation.start === line ? (
          <button
            type="button"
            className="sbs-annotation-marker"
            data-sbs-annotation={annotation.id}
            aria-label="Open the note on these lines"
          />
        ) : null}
        {sbsLineNumber(document, side, line)}
      </span>
      <span className="sbs-code">
        <LineText
          text={text}
          tokens={tokensOfRow(context.highlightedRows, line, text)}
          marks={lineMarks(
            change?.changed ?? [],
            context.findMatches?.get(line),
            context.findCurrent,
            line,
          )}
        />
      </span>
    </div>
  );
}

/** One pane's rows in its scroller. */
export function SbsPane({
  side,
  label,
  document,
  layout,
  firstRow,
  lastRow,
  lineHeight,
  gutterDigits,
  contentColumns,
  highlightMode,
  wordRanges,
  highlightedRows,
  findMatches,
  findCurrent,
  annotations,
  openAnnotationId,
  selectedStart,
  selectedEnd,
  tailHeight,
  hideScrollbar,
  scrollerRef,
  onScroll,
}: SbsPaneProps) {
  const rowCount = layout.rows[side].at(-1) ?? 0;
  const rows = windowRows(
    rowContextOf({
      side,
      document,
      layout,
      highlightMode,
      wordRanges,
      highlightedRows,
      findMatches,
      findCurrent,
      annotations,
      openAnnotationId,
      selectedStart,
      selectedEnd,
    }),
    firstRow,
    lastRow,
  );

  return (
    <div
      ref={scrollerRef}
      role="group"
      aria-label={label}
      // Focusable, so a click puts the keyboard in the diff.
      tabIndex={0}
      data-sbs-scroller={side}
      className={cn(
        "sbs-scroller absolute inset-0 overflow-auto outline-none",
        hideScrollbar && "[scrollbar-width:none]",
      )}
      onScroll={() => onScroll(side)}
    >
      <div
        className="sbs-sheet"
        style={
          {
            height: rowCount * lineHeight + tailHeight,
            "--sbs-gutter-digits": gutterDigits,
            "--sbs-content-columns": contentColumns,
          } as CSSProperties
        }
      >
        <div className="sbs-window" style={{ top: firstRow * lineHeight }}>
          {rows}
        </div>
      </div>
    </div>
  );
}
