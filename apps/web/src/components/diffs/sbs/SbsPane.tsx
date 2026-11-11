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
import {
  sbsLineNumber,
  type SbsChangeKind,
  type SbsDocument,
  type SbsLineRange,
  type SbsSide,
} from "./sbsModel";

/** An annotated range of this pane, in line indices. `end` is exclusive. */
export interface SbsPaneAnnotation {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

export interface SbsPaneFind {
  /** The matches of each line that has any. */
  readonly byLine: ReadonlyMap<number, ReadonlyArray<SbsFindMatch>>;
  readonly current: SbsFindMatch | null;
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
  readonly find: SbsPaneFind | null;
  readonly annotations: ReadonlyArray<SbsPaneAnnotation>;
  readonly openAnnotationId: string | null;
  readonly selectedLines: SbsLineRange | null;
  /** The other pane carries the one visible scrollbar. */
  readonly hideScrollbar: boolean;
  readonly scrollerRef: (element: HTMLDivElement | null) => void;
  readonly onScroll: (side: SbsSide) => void;
  readonly children?: ReactNode;
}

const tokenRowCache = new WeakMap<object, ReturnType<typeof sbsTokensFromHast>>();

function tokensOfRow(rows: ArrayLike<unknown> | null, line: number, text: string) {
  const row = rows?.[line];
  if (typeof row !== "object" || row === null) return null;
  const cached = tokenRowCache.get(row);
  if (cached !== undefined) return cached;
  const tokens = sbsTokensFromHast(row, text);
  tokenRowCache.set(row, tokens);
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

function LineText({
  text,
  tokens,
  marks,
}: {
  text: string;
  tokens: ReturnType<typeof sbsTokensFromHast>;
  marks: SbsLineMarks;
}) {
  if (text.length === 0) return <br />;
  if (tokens === null && marks === NO_LINE_MARKS) return text;
  return sbsTextPieces(text, tokens, marks).map((piece) => (
    <span
      key={piece.start}
      style={sbsTokenStyle(piece.style)}
      className={cn(
        piece.changed && "sbs-word",
        piece.match === 1 && "sbs-match",
        piece.match === 2 && "sbs-match sbs-match-current",
      )}
    >
      {piece.text}
    </span>
  ));
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

export function SbsPane(props: SbsPaneProps) {
  const { side, document, layout, lineHeight } = props;
  const rowCount = layout.rows[side].at(-1) ?? 0;
  const rows: ReactNode[] = [];

  for (let row = props.firstRow; row < props.lastRow; row += 1) {
    const target = sbsRowTarget(layout, side, row);
    if (target === null) break;
    const segment = layout.segments[target.segment]!;
    if (segment.kind === "fold") {
      const hidden = segment[side].end - segment[side].start;
      rows.push(
        <button
          key={`fold:${segment.fold}`}
          type="button"
          className="sbs-row sbs-fold"
          data-sbs-fold={segment.fold}
          aria-label={`Show ${hidden} unchanged lines`}
        />,
      );
      continue;
    }
    if (segment.kind === "omitted") {
      rows.push(
        <div key={`omitted:${target.segment}`} className="sbs-row sbs-omitted">
          <span className="sbs-omitted-label">
            {segment.lines === 1 ? "1 line not in the patch" : `${segment.lines} lines not in the patch`}
          </span>
        </div>,
      );
      continue;
    }

    const line = target.line!;
    const text = document.lines[side][line] ?? "";
    const change =
      segment.kind === "change"
        ? sbsLineChange(
            document,
            props.wordRanges,
            props.highlightMode,
            side,
            line,
            document.changes[segment.change]!,
          )
        : null;
    const annotation = props.annotations.find((item) => item.start <= line && line < item.end);
    const above =
      props.highlightMode === "none"
        ? null
        : insertionPointAbove(document, layout, side, target.segment, row);
    const below =
      props.highlightMode === "none"
        ? null
        : insertionPointBelowLastRow(document, layout, side, row);
    const selected =
      props.selectedLines !== null &&
      props.selectedLines.start <= line &&
      line < props.selectedLines.end;
    rows.push(
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
          data-annotation-open={annotation?.id === props.openAnnotationId ? "" : undefined}
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
            tokens={tokensOfRow(props.highlightedRows, line, text)}
            marks={lineMarks(
              change?.changed ?? [],
              props.find?.byLine.get(line),
              props.find?.current ?? null,
              line,
            )}
          />
        </span>
      </div>,
    );
  }

  return (
    <div className="relative min-w-0 flex-1" data-sbs-pane={side}>
      <div
        ref={props.scrollerRef}
        role="group"
        aria-label={props.label}
        // A pane takes keys (F7, find) only while it holds focus.
        tabIndex={0}
        data-focus-scope="diff"
        data-sbs-scroller={side}
        className={cn(
          "sbs-scroller absolute inset-0 overflow-auto outline-none",
          props.hideScrollbar && "[scrollbar-width:none]",
        )}
        onScroll={() => props.onScroll(side)}
      >
        <div
          className="sbs-sheet"
          style={
            {
              height: rowCount * lineHeight,
              "--sbs-gutter-digits": props.gutterDigits,
              "--sbs-content-columns": props.contentColumns,
            } as CSSProperties
          }
        >
          <div className="sbs-window" style={{ top: props.firstRow * lineHeight }}>
            {rows}
          </div>
        </div>
      </div>
      {props.children}
    </div>
  );
}
