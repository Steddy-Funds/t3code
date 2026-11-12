import type { FileDiffMetadata } from "@pierre/diffs";
import { findDiffMoves, type DiffMove, type DiffMoveFile } from "@t3tools/shared/diffMoves";

import { sbsLineIndex, type SbsDocument, type SbsLineRange, type SbsSide } from "./sbsModel";

/** Lines of the file shown that a move took away (old side) or brought (new side). */
export interface SbsMove {
  readonly side: SbsSide;
  /** File line numbers, 1-based and inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  /** Where the lines went, or came from. */
  readonly counterpart: {
    readonly filePath: string;
    readonly sameFile: boolean;
    readonly startLine: number;
    readonly endLine: number;
  };
  /** The chip's text: `→ L40`, `← from parsers/dates.py:9`. */
  readonly label: string;
  readonly description: string;
}

export interface SbsMoveSource {
  readonly filePath: string;
  readonly fileDiff: FileDiffMetadata;
}

/** A file's removed and added runs from its patch. A patch still loading has none. */
function moveFileOf({ filePath, fileDiff }: SbsMoveSource): DiffMoveFile {
  const removed: DiffMoveFile["removed"][number][] = [];
  const added: DiffMoveFile["added"][number][] = [];
  let block = 0;
  for (const hunk of fileDiff.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type !== "change") continue;
      if (content.deletions > 0) {
        removed.push({
          startLine: hunk.deletionStart + (content.deletionLineIndex - hunk.deletionLineIndex),
          lines: fileDiff.deletionLines.slice(
            content.deletionLineIndex,
            content.deletionLineIndex + content.deletions,
          ),
          block,
        });
      }
      if (content.additions > 0) {
        added.push({
          startLine: hunk.additionStart + (content.additionLineIndex - hunk.additionLineIndex),
          lines: fileDiff.additionLines.slice(
            content.additionLineIndex,
            content.additionLineIndex + content.additions,
          ),
          block,
        });
      }
      block += 1;
    }
  }
  return { path: filePath, removed, added };
}

/** A few diffs at once: the thread's diff and a pull request's Code tab can both be mounted. */
const RECENT_DIFFS = 4;
const recentDiffs: Array<{
  readonly sources: ReadonlyArray<SbsMoveSource>;
  readonly moves: ReadonlyArray<DiffMove>;
}> = [];

function sameSources(left: ReadonlyArray<SbsMoveSource>, right: ReadonlyArray<SbsMoveSource>) {
  return (
    left.length === right.length &&
    left.every(
      (source, index) =>
        source.fileDiff === right[index]!.fileDiff && source.filePath === right[index]!.filePath,
    )
  );
}

/** The moves across every file of a diff, kept while the same patches come back. */
export function sbsDiffMovesOf(sources: ReadonlyArray<SbsMoveSource>): ReadonlyArray<DiffMove> {
  const index = recentDiffs.findIndex((recent) => sameSources(recent.sources, sources));
  const entry =
    index >= 0
      ? recentDiffs.splice(index, 1)[0]!
      : { sources, moves: findDiffMoves(sources.map(moveFileOf)) };
  recentDiffs.unshift(entry);
  recentDiffs.length = Math.min(recentDiffs.length, RECENT_DIFFS);
  return entry.moves;
}

function lineSpan(startLine: number, endLine: number): string {
  return startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
}

const filesMoves = new WeakMap<ReadonlyArray<DiffMove>, Map<string, ReadonlyArray<SbsMove>>>();

/** One file's ends of the diff's moves, with the other file's path as `shownPath` gives it. */
export function sbsMovesForFile(
  moves: ReadonlyArray<DiffMove>,
  filePath: string,
  shownPath: (path: string) => string,
): ReadonlyArray<SbsMove> {
  let byFile = filesMoves.get(moves);
  if (!byFile) filesMoves.set(moves, (byFile = new Map()));
  const cached = byFile.get(filePath);
  if (cached) return cached;
  const result: SbsMove[] = [];
  for (const { from, to } of moves) {
    const sameFile = from.path === to.path;
    const lines = from.endLine - from.startLine + 1;
    const size = lines === 1 ? "1 line" : `${lines} lines`;
    if (from.path === filePath) {
      const target = sameFile ? `L${to.startLine}` : `${shownPath(to.path)}:${to.startLine}`;
      result.push({
        side: "deletions",
        startLine: from.startLine,
        endLine: from.endLine,
        counterpart: { filePath: to.path, sameFile, ...lineEnds(to) },
        label: `→ ${target}`,
        description: sameFile
          ? `${size} moved to ${lineSpan(to.startLine, to.endLine)}, unchanged apart from indentation`
          : `${size} moved to ${shownPath(to.path)} ${lineSpan(to.startLine, to.endLine)}, unchanged apart from indentation`,
      });
    }
    if (to.path === filePath) {
      const source = sameFile ? `L${from.startLine}` : `${shownPath(from.path)}:${from.startLine}`;
      result.push({
        side: "additions",
        startLine: to.startLine,
        endLine: to.endLine,
        counterpart: { filePath: from.path, sameFile, ...lineEnds(from) },
        label: `← from ${source}`,
        description: sameFile
          ? `${size} moved here from ${lineSpan(from.startLine, from.endLine)}, unchanged apart from indentation`
          : `${size} moved here from ${shownPath(from.path)} ${lineSpan(from.startLine, from.endLine)}, unchanged apart from indentation`,
      });
    }
  }
  byFile.set(filePath, result);
  return result;
}

function lineEnds(end: { startLine: number; endLine: number }) {
  return { startLine: end.startLine, endLine: end.endLine };
}

export const SBS_MOVE_NONE = 0;
export const SBS_MOVED = 1;
/** Old lines that went to another file: there is nothing left to review on this side. */
export const SBS_MOVED_OUT = 2;

export interface SbsMoveMark {
  readonly move: SbsMove;
  /** Line indices of this side. */
  readonly range: SbsLineRange;
  /** A move within the file: the other end's line indices, on the other side. */
  readonly counterpartRange: SbsLineRange | null;
}

export interface SbsMoveLayer {
  /** Per line index: `SBS_MOVE_NONE`, `SBS_MOVED` or `SBS_MOVED_OUT`. Only changed lines. */
  readonly tints: Readonly<Record<SbsSide, Uint8Array>>;
  readonly marks: Readonly<Record<SbsSide, ReadonlyArray<SbsMoveMark>>>;
  /** Changes whose every line moved: the move's own shape replaces their connector. */
  readonly movedChanges: ReadonlySet<number>;
}

function otherSide(side: SbsSide): SbsSide {
  return side === "deletions" ? "additions" : "deletions";
}

function indexRange(
  document: SbsDocument,
  side: SbsSide,
  startLine: number,
  endLine: number,
): SbsLineRange | null {
  const start = sbsLineIndex(document, side, startLine);
  const end = sbsLineIndex(document, side, endLine);
  return start < 0 || end < start ? null : { start, end: end + 1 };
}

const layers = new WeakMap<ReadonlyArray<SbsMove>, WeakMap<SbsDocument, SbsMoveLayer>>();

/** Where the file's moves land in the document the view shows. */
export function sbsMoveLayerOf(document: SbsDocument, moves: ReadonlyArray<SbsMove>): SbsMoveLayer {
  let byDocument = layers.get(moves);
  if (!byDocument) layers.set(moves, (byDocument = new WeakMap()));
  const cached = byDocument.get(document);
  if (cached) return cached;

  const changeOf = {
    deletions: new Int32Array(document.lines.deletions.length).fill(-1),
    additions: new Int32Array(document.lines.additions.length).fill(-1),
  };
  document.changes.forEach((change, index) => {
    for (const side of ["deletions", "additions"] as const) {
      changeOf[side].fill(index, change[side].start, change[side].end);
    }
  });
  const tints = {
    deletions: new Uint8Array(document.lines.deletions.length),
    additions: new Uint8Array(document.lines.additions.length),
  };
  const marks: Record<SbsSide, SbsMoveMark[]> = { deletions: [], additions: [] };
  for (const move of moves) {
    const range = indexRange(document, move.side, move.startLine, move.endLine);
    if (range === null) continue;
    const tint =
      move.side === "deletions" && !move.counterpart.sameFile ? SBS_MOVED_OUT : SBS_MOVED;
    let tinted = false;
    for (let line = range.start; line < range.end; line += 1) {
      // A line the view shows unchanged (whitespace ignored, say) keeps its plain look.
      if (changeOf[move.side][line]! < 0) continue;
      tints[move.side][line] = tint;
      tinted = true;
    }
    if (!tinted) continue;
    marks[move.side].push({
      move,
      range,
      counterpartRange: move.counterpart.sameFile
        ? indexRange(
            document,
            otherSide(move.side),
            move.counterpart.startLine,
            move.counterpart.endLine,
          )
        : null,
    });
  }
  const movedChanges = new Set<number>();
  document.changes.forEach((change, index) => {
    const moved = (["deletions", "additions"] as const).every((side) => {
      for (let line = change[side].start; line < change[side].end; line += 1) {
        // A move leaves out blank lines at its edges; they don't keep a change from moving whole.
        if (tints[side][line] === SBS_MOVE_NONE && document.lines[side][line]!.trim() !== "") {
          return false;
        }
      }
      return true;
    });
    if (moved) movedChanges.add(index);
  });
  const layer = { tints, marks, movedChanges };
  byDocument.set(document, layer);
  return layer;
}
