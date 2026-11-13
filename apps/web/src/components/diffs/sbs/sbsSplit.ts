import { sbsConnectorPath, sbsWedgePath, type SbsSpan } from "./sbsConnectors";
import {
  sbsLineIndex,
  sbsLineNumber,
  type SbsDocument,
  type SbsLineRange,
  type SbsSide,
} from "./sbsModel";
import type { SbsMoveLayer, SbsMoveMark } from "./sbsMoves";

/** One place a block's code went to, or came from. */
export interface SbsSplitPiece {
  readonly mark: SbsMoveMark;
  /** The piece's lines in the block, counted from the block's first line. */
  readonly rows: SbsLineRange;
}

/** A changed block with moved code in it, opened to show where each piece went. */
export interface SbsSplit {
  /** The side the block is on: the old side for code that left, the new for code that came. */
  readonly side: SbsSide;
  /** The block's line indices on that side. */
  readonly block: SbsLineRange;
  readonly pieces: ReadonlyArray<SbsSplitPiece>;
  /** Runs of the block that went nowhere, from its first line. Blank runs are left out. */
  readonly gaps: ReadonlyArray<SbsLineRange>;
}

/** The block a moved line sits in, with every piece of it that moved. */
export function sbsSplitOf(
  document: SbsDocument,
  moves: SbsMoveLayer,
  side: SbsSide,
  line: number,
): SbsSplit | null {
  const change = document.changes.find(
    (candidate) => candidate[side].start <= line && line < candidate[side].end,
  );
  if (!change) return null;
  const block = change[side];
  const pieces = moves.marks[side]
    .filter((mark) => mark.range.start < block.end && block.start < mark.range.end)
    .map((mark) => ({
      mark,
      rows: {
        start: Math.max(mark.range.start, block.start) - block.start,
        end: Math.min(mark.range.end, block.end) - block.start,
      },
    }))
    .sort((left, right) => left.rows.start - right.rows.start);
  if (pieces.length === 0) return null;

  const gaps: SbsLineRange[] = [];
  let next = 0;
  const addGap = (start: number, end: number) => {
    const lines = document.lines[side].slice(block.start + start, block.start + end);
    if (lines.some((text) => text.trim() !== "")) gaps.push({ start, end });
  };
  for (const piece of pieces) {
    if (piece.rows.start > next) addGap(next, piece.rows.start);
    next = Math.max(next, piece.rows.end);
  }
  if (next < block.end - block.start) addGap(next, block.end - block.start);
  return { side, block, pieces, gaps };
}

export interface SbsSplitCardLine {
  readonly text: string;
  readonly lineNumber: number;
  readonly moved: boolean;
}

/** The other end of a piece with the code around it, as its card shows it. */
export interface SbsSplitCard {
  /** Line indices of the card's side in its document: context, piece, context. */
  readonly range: SbsLineRange;
  readonly lines: ReadonlyArray<SbsSplitCardLine>;
  /** Context lines above the piece. */
  readonly before: number;
  readonly after: number;
}

/** How far a card looks up and down for the lines that enclose its piece. */
const MAX_CONTEXT_LINES = 8;
/** Context a card shows when nothing encloses its piece within reach. */
const FALLBACK_CONTEXT_LINES = 2;

function indentOf(text: string): number | null {
  if (text.trim() === "") return null;
  let columns = 0;
  for (const character of text) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns += 4;
    else break;
  }
  return columns;
}

/** The line indices the document holds around an index: its hunk in a patch, else the file. */
function heldRange(document: SbsDocument, side: SbsSide, index: number): SbsLineRange {
  let start = 0;
  let end = document.lines[side].length;
  for (const origin of document.origins) {
    if (origin[side] <= index) start = origin[side];
    else {
      end = origin[side];
      break;
    }
  }
  return { start, end };
}

/**
 * The piece at `startLine`-`endLine` of a side with the code around it: up to the first line
 * above that is indented less than the piece, which opens what holds it, and down to the first
 * such line below, which closes it. Without one in reach, a couple of lines each way.
 */
export function sbsSplitCardOf(
  document: SbsDocument,
  side: SbsSide,
  startLine: number,
  endLine: number,
): SbsSplitCard | null {
  const start = sbsLineIndex(document, side, startLine);
  const last = sbsLineIndex(document, side, endLine);
  if (start < 0 || last < start) return null;
  const end = last + 1;
  const lines = document.lines[side];
  const held = heldRange(document, side, start);
  const indents = lines
    .slice(start, end)
    .map(indentOf)
    .filter((indent) => indent !== null);
  const base = indents.length > 0 ? Math.min(...indents) : 0;
  const encloses = (index: number) => {
    const indent = indentOf(lines[index]!);
    return indent !== null && indent < base;
  };

  let top = Math.max(held.start, start - FALLBACK_CONTEXT_LINES);
  for (
    let index = start - 1;
    index >= Math.max(held.start, start - MAX_CONTEXT_LINES);
    index -= 1
  ) {
    if (encloses(index)) {
      top = index;
      break;
    }
  }
  let bottom = Math.min(held.end, end + FALLBACK_CONTEXT_LINES);
  for (let index = end; index < Math.min(held.end, end + MAX_CONTEXT_LINES); index += 1) {
    if (encloses(index)) {
      bottom = index + 1;
      break;
    }
  }
  const card: SbsSplitCardLine[] = [];
  for (let index = top; index < bottom; index += 1) {
    card.push({
      text: lines[index]!,
      lineNumber: sbsLineNumber(document, side, index),
      moved: start <= index && index < end,
    });
  }
  return {
    range: { start: top, end: bottom },
    lines: card,
    before: start - top,
    after: bottom - end,
  };
}

export interface SbsSplitGeometryPiece {
  readonly rows: SbsLineRange;
  /** Its card's context rows above and below the piece; no card shows the header alone. */
  readonly before: number;
  readonly after: number;
  /** A card of another file sits level with its piece; one of this file stacks under the last. */
  readonly level: boolean;
}

export interface SbsSplitGeometryInput {
  readonly blockRows: number;
  readonly pieces: ReadonlyArray<SbsSplitGeometryPiece>;
  readonly gaps: ReadonlyArray<SbsLineRange>;
  readonly lineHeight: number;
  /** The block's side: its column is on the left for code that left. */
  readonly side: SbsSide;
  readonly dividerWidth: number;
}

export interface SbsSplitGeometry {
  /** Where the block's first row sits. */
  readonly blockTop: number;
  readonly cards: ReadonlyArray<{ readonly top: number; readonly height: number }>;
  readonly height: number;
  readonly bands: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<string>;
}

/** Room between two cards. */
export const SBS_SPLIT_CARD_GAP = 8;

/** Where the block, the cards and the shapes between them go. A card's header takes one row. */
export function sbsSplitGeometry(input: SbsSplitGeometryInput): SbsSplitGeometry {
  const { pieces, lineHeight } = input;
  const pieceOffset = (piece: SbsSplitGeometryPiece) => (1 + piece.before) * lineHeight;
  // The block moves down until a level card's header fits above its piece.
  const blockTop = Math.max(
    0,
    ...pieces
      .filter((piece) => piece.level)
      .map((piece) => pieceOffset(piece) - piece.rows.start * lineHeight),
  );
  const cards: { top: number; height: number }[] = [];
  let below = 0;
  for (const piece of pieces) {
    const wanted = piece.level ? blockTop + piece.rows.start * lineHeight - pieceOffset(piece) : 0;
    const top = Math.max(wanted, below);
    const height =
      (1 + piece.before + (piece.rows.end - piece.rows.start) + piece.after) * lineHeight;
    cards.push({ top, height });
    below = top + height + SBS_SPLIT_CARD_GAP;
  }

  const blockSpan = (rows: SbsLineRange): SbsSpan => ({
    top: blockTop + rows.start * lineHeight,
    bottom: blockTop + rows.end * lineHeight,
  });
  const blockOnLeft = input.side === "deletions";
  const bands = pieces.map((piece, index) => {
    const block = blockSpan(piece.rows);
    const top = cards[index]!.top + pieceOffset(piece);
    const card = { top, bottom: top + (block.bottom - block.top) };
    return blockOnLeft
      ? sbsConnectorPath(block, card, input.dividerWidth)
      : sbsConnectorPath(card, block, input.dividerWidth);
  });
  const gaps = input.gaps.map((rows) =>
    sbsWedgePath(blockSpan(rows), blockOnLeft, input.dividerWidth),
  );
  const last = cards.at(-1);
  return {
    blockTop,
    cards,
    height: Math.max(blockTop + input.blockRows * lineHeight, last ? last.top + last.height : 0),
    bands,
    gaps,
  };
}
