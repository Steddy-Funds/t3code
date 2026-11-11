import { sbsChangeRows, type SbsLayout } from "./sbsLayout";
import type { SbsChangeKind, SbsDocument, SbsLineRange, SbsSide } from "./sbsModel";

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
}

/** The connectors that cross the viewport, in the divider's coordinates. */
export function sbsVisibleConnectors(input: SbsConnectorInput): ReadonlyArray<SbsConnector> {
  const { document, layout, scrollTop, viewportHeight, lineHeight } = input;
  const width = input.width ?? SBS_DIVIDER_WIDTH;
  const connectors: SbsConnector[] = [];
  document.changes.forEach((change, index) => {
    const span = (side: SbsSide): SbsSpan => {
      const rows = sbsRowsSpan(sbsChangeRows(layout, index, side), lineHeight);
      return { top: rows.top - scrollTop[side], bottom: rows.bottom - scrollTop[side] };
    };
    const left = span("deletions");
    const right = span("additions");
    // A band whose two ends are off opposite edges still crosses the viewport.
    if (Math.max(left.bottom, right.bottom) <= 0) return;
    if (Math.min(left.top, right.top) >= viewportHeight) return;
    connectors.push({ change: index, kind: change.kind, path: sbsConnectorPath(left, right, width) });
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
