import type { FileDiffMetadata } from "@pierre/diffs";
import type { ReviewItem } from "@t3tools/shared/reviewNote";

import { diffPathForWorkspaceFile } from "~/diffFileActions";

export type ReviewNoteAnchor =
  | { readonly kind: "exact" | "moved"; readonly startLine: number; readonly endLine: number }
  | { readonly kind: "unattached" };

/** A note on one file of the shown diff; `pending` while that file's patch loads. */
export interface PlacedReviewNote {
  readonly note: ReviewItem;
  readonly fileKey: string;
  readonly anchor: ReviewNoteAnchor | { readonly kind: "pending" };
}

export type AttachedReviewNote = PlacedReviewNote & {
  readonly anchor: Extract<ReviewNoteAnchor, { readonly kind: "exact" | "moved" }>;
};

export const isAttachedReviewNote = (placed: PlacedReviewNote): placed is AttachedReviewNote =>
  placed.anchor.kind === "exact" || placed.anchor.kind === "moved";

/** Git abbreviates object ids to 7 hex characters at the least. */
const MIN_OBJECT_ID_LENGTH = 7;
const UNATTACHED: ReviewNoteAnchor = { kind: "unattached" };

function isRevisionOf(objectId: string | undefined, contentRevision: string | null): boolean {
  if (contentRevision === null) return false;
  if (objectId === undefined || objectId.length < MIN_OBJECT_ID_LENGTH) return false;
  const id = objectId.toLowerCase();
  return /^[0-9a-f]+$/u.test(id) && contentRevision.toLowerCase().startsWith(id);
}

const lineText = (line: string | undefined) => (line ?? "").replace(/\r?\n$/u, "");

/** The viewer shows only lines inside hunks; a note sits only where every one of its lines shows. */
function showsLines(fileDiff: FileDiffMetadata, startLine: number, endLine: number): boolean {
  const shows = (line: number) =>
    fileDiff.hunks.some(
      (hunk) => line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
    );
  for (let line = startLine; line <= endLine; line += 1) {
    if (!shows(line)) return false;
  }
  return true;
}

/** Consecutive new-side lines, each run starting at its 1-based line number. */
function newSideRuns(fileDiff: FileDiffMetadata) {
  if (!fileDiff.isPartial) return [{ firstLine: 1, lines: fileDiff.additionLines }];
  return fileDiff.hunks.map((hunk) => ({
    firstLine: hunk.additionStart,
    lines: fileDiff.additionLines.slice(
      hunk.additionLineIndex,
      hunk.additionLineIndex + hunk.additionCount,
    ),
  }));
}

const excerptLines = (note: ReviewItem) => note.excerpt.split("\n");

/** Whether the new side reads the item's excerpt at its own lines. */
function excerptAtOwnLines(fileDiff: FileDiffMetadata, note: ReviewItem): boolean {
  const excerpt = excerptLines(note);
  return newSideRuns(fileDiff).some(
    (run) =>
      note.startLine >= run.firstLine &&
      note.startLine - run.firstLine + excerpt.length <= run.lines.length &&
      excerpt.every(
        (line, offset) => lineText(run.lines[note.startLine - run.firstLine + offset]) === line,
      ),
  );
}

/** Where the excerpt starts on the new side, stopping at a second occurrence. */
function findExcerpt(fileDiff: FileDiffMetadata, note: ReviewItem): number[] {
  const excerpt = excerptLines(note);
  // The server drops whole lines first, so only a one-line note's shortened excerpt is surely cut
  // inside its line; a longer note's may be its whole first line.
  const [only] = excerpt;
  const cutLine =
    note.excerptTruncated && note.startLine === note.endLine && excerpt.length === 1 && only
      ? only
      : null;
  const matches = (line: string, index: number) =>
    cutLine === null ? line === excerpt[index] : line.startsWith(cutLine);
  const starts: number[] = [];
  for (const run of newSideRuns(fileDiff)) {
    for (let start = 0; start + excerpt.length <= run.lines.length; start += 1) {
      if (excerpt.every((_, offset) => matches(lineText(run.lines[start + offset]), offset))) {
        starts.push(run.firstLine + start);
        if (starts.length > 1) return starts;
      }
    }
  }
  return starts;
}

/** How the viewer shows a file: its patch's hunks, or the whole file around them. */
export type ReviewNoteShownLines = "hunks" | "whole-file";

/**
 * Where `note` sits in `fileDiff`, the shown diff of its file. Exact when the new side is the file
 * the agent flagged; moved when the flagged lines occur exactly once on the new side. Anything
 * else stays unattached rather than sit on lines the note may not be about.
 */
export function anchorReviewNote(
  note: ReviewItem,
  fileDiff: FileDiffMetadata,
  diffPath = note.path,
  shownLines: ReviewNoteShownLines = "hunks",
): ReviewNoteAnchor {
  if (fileDiff.type === "deleted" || fileDiff.name !== diffPath) return UNATTACHED;
  if (isRevisionOf(fileDiff.newObjectId, note.contentRevision)) {
    // The flagged file is the new side, so its lines are all there to show whole.
    return shownLines === "whole-file" || showsLines(fileDiff, note.startLine, note.endLine)
      ? { kind: "exact", startLine: note.startLine, endLine: note.endLine }
      : UNATTACHED;
  }
  if (note.excerpt.length === 0) return UNATTACHED;
  // A comment has no revision to match; its quoted lines still where it left them stay put.
  if (
    note.contentRevision === null &&
    excerptAtOwnLines(fileDiff, note) &&
    showsLines(fileDiff, note.startLine, note.startLine + excerptLines(note).length - 1)
  ) {
    return {
      kind: "exact",
      startLine: note.startLine,
      endLine: note.startLine + excerptLines(note).length - 1,
    };
  }
  const starts = findExcerpt(fileDiff, note);
  const [startLine] = starts;
  if (startLine === undefined || starts.length > 1) return UNATTACHED;
  // Only the excerpt was matched; a shortened one covers fewer lines than the note did.
  const endLine = startLine + excerptLines(note).length - 1;
  return showsLines(fileDiff, startLine, endLine)
    ? { kind: "moved", startLine, endLine }
    : UNATTACHED;
}

// A moved note scans its whole file, and a shown file keeps its object across renders. Hydrating
// a partial diff mutates that object, so `isPartial` is part of the key.
const anchorCache = new WeakMap<FileDiffMetadata, Map<string, ReviewNoteAnchor>>();

export function cachedReviewNoteAnchor(
  note: ReviewItem,
  fileDiff: FileDiffMetadata,
  diffPath: string,
  shownLines: ReviewNoteShownLines = "hunks",
): ReviewNoteAnchor {
  let byNote = anchorCache.get(fileDiff);
  if (!byNote) {
    byNote = new Map();
    anchorCache.set(fileDiff, byNote);
  }
  const key = JSON.stringify([
    note.id,
    note.contentRevision,
    fileDiff.isPartial,
    diffPath,
    shownLines,
  ]);
  let anchor = byNote.get(key);
  if (!anchor) {
    anchor = anchorReviewNote(note, fileDiff, diffPath, shownLines);
    byNote.set(key, anchor);
  }
  return anchor;
}

const placedLine = ({ note, anchor }: PlacedReviewNote) =>
  anchor.kind === "exact" || anchor.kind === "moved" ? anchor.startLine : note.startLine;

/** The item's file as the diff names it, from the repository root. */
export function reviewItemDiffPath(
  note: ReviewItem,
  roots: {
    readonly workspaceRoot: string | undefined;
    readonly repositoryRoot: string | undefined;
  },
): string {
  return note.kind === "review_comment_thread" && note.pathBase === "diff"
    ? note.path
    : diffPathForWorkspaceFile({ filePath: note.path, ...roots });
}

/**
 * The notes on the shown files, in the order the viewer shows them. A note names its file from the
 * workspace root, as the agent did; the diff names it from the repository root.
 */
export function placeReviewNotes(
  notes: ReadonlyArray<ReviewItem>,
  files: ReadonlyArray<{
    readonly fileDiff: FileDiffMetadata;
    readonly fileKey: string;
    readonly pending: boolean;
  }>,
  roots: {
    readonly workspaceRoot: string | undefined;
    readonly repositoryRoot: string | undefined;
  },
  shownLines: ReviewNoteShownLines = "hunks",
): PlacedReviewNote[] {
  const placed: Array<{ readonly order: number; readonly placed: PlacedReviewNote }> = [];
  for (const note of notes) {
    const diffPath = reviewItemDiffPath(note, roots);
    const named = files.findIndex(({ fileDiff }) => fileDiff.name === diffPath);
    const order =
      named >= 0 ? named : files.findIndex(({ fileDiff }) => fileDiff.prevName === diffPath);
    const file = files[order];
    if (!file) continue;
    placed.push({
      order,
      placed: {
        note,
        fileKey: file.fileKey,
        anchor: file.pending
          ? { kind: "pending" }
          : cachedReviewNoteAnchor(note, file.fileDiff, diffPath, shownLines),
      },
    });
  }
  return placed
    .toSorted(
      (left, right) =>
        left.order - right.order || placedLine(left.placed) - placedLine(right.placed),
    )
    .map((entry) => entry.placed);
}

/**
 * The nearest note in `direction` from the current one that may sit on a line, wrapping. The
 * current note counts by its place in `notes`, so one that turned out unplaced is stepped past.
 */
export function stepReviewNote(
  notes: ReadonlyArray<PlacedReviewNote>,
  currentId: string | null,
  direction: 1 | -1,
): PlacedReviewNote | undefined {
  const isStep = ({ anchor }: PlacedReviewNote) => anchor.kind !== "unattached";
  const from = notes.findIndex(({ note }) => note.id === currentId);
  if (from < 0) return direction === 1 ? notes.find(isStep) : notes.findLast(isStep);
  for (let offset = 1; offset <= notes.length; offset += 1) {
    const candidate = notes[(from + direction * offset + notes.length * offset) % notes.length];
    if (candidate && isStep(candidate)) return candidate;
  }
  return undefined;
}
