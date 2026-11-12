import { sbsChangeRows, sbsRangeRows, type SbsLayout } from "./sbsLayout";
import type { SbsChangeKind, SbsDocument, SbsLineRange, SbsSide } from "./sbsModel";
import type { SbsMoveLayer } from "./sbsMoves";

/** JetBrains' `diff.divider.width`. */
export const SBS_DIVIDER_WIDTH = 24;
/** How far along the divider each curve's control point sits (`DiffDrawUtil.CTRL_PROXIMITY_X`). */
const CONTROL_POINT_PROXIMITY = 0.3;

export interface SbsSpan {
  readonly top: number;
  readonly bottom: number;
}

/**
 * The height a range of rows takes, in the pane's own coordinates. A side with no lines
 * narrows to one pixel on the boundary its lines would sit at: the bottom of the row before,
 * or the first pixel of the file.
 */
export function sbsRowsSpan(rows: SbsLineRange, lineHeight: number): SbsSpan {
  if (rows.end > rows.start) {
    return { top: rows.start * lineHeight, bottom: rows.end * lineHeight };
  }
  const top = rows.start === 0 ? 0 : rows.start * lineHeight - 1;
  return { top, bottom: top + 1 };
}

function coordinate(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** A band from the left span to the right span, both edges cubic curves (`drawCurveTrapezium`). */
export function sbsConnectorPath(left: SbsSpan, right: SbsSpan, width: number): string {
  const near = coordinate(width * CONTROL_POINT_PROXIMITY);
  const far = coordinate(width * (1 - CONTROL_POINT_PROXIMITY));
  const end = coordinate(width);
  const [leftTop, leftBottom, rightTop, rightBottom] = [
    left.top,
    left.bottom,
    right.top,
    right.bottom,
  ].map(coordinate);
  return (
    `M0,${leftTop}C${near},${leftTop} ${far},${rightTop} ${end},${rightTop}` +
    `L${end},${rightBottom}C${far},${rightBottom} ${near},${leftBottom} 0,${leftBottom}Z`
  );
}

export interface SbsConnector {
  readonly change: number;
  readonly kind: SbsChangeKind;
  readonly path: string;
}

export interface SbsConnectorInput {
  readonly document: SbsDocument;
  readonly layout: SbsLayout;
  readonly scrollTop: Readonly<Record<SbsSide, number>>;
  readonly viewportHeight: number;
  readonly lineHeight: number;
  readonly width?: number;
  /** Changes a move's own shape stands for. */
  readonly movedChanges?: ReadonlySet<number>;
}

/** The connectors that cross the viewport, in the divider's coordinates. */
export function sbsVisibleConnectors(input: SbsConnectorInput): ReadonlyArray<SbsConnector> {
  const { document, layout, scrollTop, viewportHeight, lineHeight } = input;
  const width = input.width ?? SBS_DIVIDER_WIDTH;
  const connectors: SbsConnector[] = [];
  document.changes.forEach((change, index) => {
    if (input.movedChanges?.has(index)) return;
    const span = (side: SbsSide): SbsSpan => {
      const rows = sbsRowsSpan(sbsChangeRows(layout, index, side), lineHeight);
      return { top: rows.top - scrollTop[side], bottom: rows.bottom - scrollTop[side] };
    };
    const left = span("deletions");
    const right = span("additions");
    // A band whose two ends are off opposite edges still crosses the viewport.
    if (Math.max(left.bottom, right.bottom) <= 0) return;
    if (Math.min(left.top, right.top) >= viewportHeight) return;
    connectors.push({
      change: index,
      kind: change.kind,
      path: sbsConnectorPath(left, right, width),
    });
  });
  return connectors;
}

export interface SbsFoldLink {
  readonly fold: number;
  /** The vertical centre of the fold's row on each side, in the divider's coordinates. */
  readonly left: number;
  readonly right: number;
}

/** Where each collapsed fold's wave crosses the divider. */
export function sbsVisibleFoldLinks(
  input: Omit<SbsConnectorInput, "document">,
): ReadonlyArray<SbsFoldLink> {
  const { layout, scrollTop, viewportHeight, lineHeight } = input;
  const links: SbsFoldLink[] = [];
  layout.segments.forEach((segment, index) => {
    if (segment.kind !== "fold") return;
    const left = (layout.rows.deletions[index]! + 0.5) * lineHeight - scrollTop.deletions;
    const right = (layout.rows.additions[index]! + 0.5) * lineHeight - scrollTop.additions;
    if (Math.max(left, right) < 0 || Math.min(left, right) > viewportHeight) return;
    links.push({ fold: segment.fold, left, right });
  });
  return links;
}

export interface SbsMoveShape {
  readonly id: string;
  /** A band between both ends of a move in this file, or a wedge for one that leaves it. */
  readonly kind: "band" | "wedge";
  readonly path: string;
}

/** A wedge from a span at one edge to a point a little short of the other. */
function wedgePath(span: SbsSpan, fromLeft: boolean, width: number): string {
  const middle = coordinate((span.top + span.bottom) / 2);
  const [top, bottom] = [span.top, span.bottom].map(coordinate);
  const edge = fromLeft ? "0" : coordinate(width);
  const near = coordinate(fromLeft ? width * 0.35 : width * 0.65);
  const tip = coordinate(fromLeft ? width * 0.7 : width * 0.3);
  return `M${edge},${top}C${near},${top} ${near},${middle} ${tip},${middle}C${near},${middle} ${near},${bottom} ${edge},${bottom}Z`;
}

/**
 * The moves that cross the viewport. A band is drawn only while both its ends are in view: with
 * one off screen it would be a near-vertical streak, and the chip already points the way.
 */
export function sbsVisibleMoveShapes(
  input: Omit<SbsConnectorInput, "document"> & { readonly moves: SbsMoveLayer },
): ReadonlyArray<SbsMoveShape> {
  const { layout, scrollTop, viewportHeight, lineHeight, moves } = input;
  const width = input.width ?? SBS_DIVIDER_WIDTH;
  const span = (side: SbsSide, range: SbsLineRange): SbsSpan => {
    const rows = sbsRowsSpan(sbsRangeRows(layout, side, range), lineHeight);
    return { top: rows.top - scrollTop[side], bottom: rows.bottom - scrollTop[side] };
  };
  const inView = (value: SbsSpan) => value.bottom > 0 && value.top < viewportHeight;
  const shapes: SbsMoveShape[] = [];
  for (const side of ["deletions", "additions"] as const) {
    moves.marks[side].forEach((mark, index) => {
      const id = `${side}:${index}`;
      const own = span(side, mark.range);
      if (!mark.move.counterpart.sameFile) {
        if (inView(own))
          shapes.push({ id, kind: "wedge", path: wedgePath(own, side === "deletions", width) });
        return;
      }
      // One band per move: the old side's mark draws it.
      if (side !== "deletions" || mark.counterpartRange === null) return;
      const other = span("additions", mark.counterpartRange);
      if (inView(own) && inView(other)) {
        shapes.push({ id, kind: "band", path: sbsConnectorPath(own, other, width) });
      }
    });
  }
  return shapes;
}
