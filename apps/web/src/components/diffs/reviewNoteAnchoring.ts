import type { FileDiffMetadata } from "@pierre/diffs";
import type { ReviewNote } from "@t3tools/shared/reviewNote";

import { diffPathForWorkspaceFile } from "~/diffFileActions";

export type ReviewNoteAnchor =
  | { readonly kind: "exact" | "moved"; readonly startLine: number; readonly endLine: number }
  | { readonly kind: "unattached" };

/** A note on one file of the shown diff; `pending` while that file's patch loads. */
export interface PlacedReviewNote {
  readonly note: ReviewNote;
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

function isRevisionOf(objectId: string | undefined, contentRevision: string): boolean {
  if (objectId === undefined || objectId.length < MIN_OBJECT_ID_LENGTH) return false;
  const id = objectId.toLowerCase();
  return /^[0-9a-f]+$/u.test(id) && contentRevision.toLowerCase().startsWith(id);
}

const lineText = (line: string | undefined) => (line ?? "").replace(/\r?\n$/u, "");

/** The viewer shows only lines inside hunks; a note anywhere else has nowhere to sit. */
function showsLines(fileDiff: FileDiffMetadata, startLine: number, endLine: number): boolean {
  const shows = (line: number) =>
    fileDiff.hunks.some(
      (hunk) => line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount,
    );
  return shows(startLine) && shows(endLine);
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

/** Where the excerpt starts on the new side, stopping at a second occurrence. */
function findExcerpt(fileDiff: FileDiffMetadata, note: ReviewNote): number[] {
  const excerpt = note.excerpt.split("\n");
  const lastIndex = excerpt.length - 1;
  // A truncated excerpt can end partway through its last line.
  const matches = (line: string, index: number) =>
    note.excerptTruncated && index === lastIndex
      ? line.startsWith(excerpt[index] ?? "")
      : line === excerpt[index];
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

/**
 * Where `note` sits in `fileDiff`, the shown diff of its file. Exact when the new side is the file
 * the agent flagged; moved when the flagged lines occur exactly once on the new side. Anything
 * else stays unattached rather than sit on lines the note may not be about.
 */
export function anchorReviewNote(
  note: ReviewNote,
  fileDiff: FileDiffMetadata,
  diffPath = note.path,
): ReviewNoteAnchor {
  if (fileDiff.type === "deleted" || fileDiff.name !== diffPath) return UNATTACHED;
  if (isRevisionOf(fileDiff.newObjectId, note.contentRevision)) {
    return showsLines(fileDiff, note.startLine, note.endLine)
      ? { kind: "exact", startLine: note.startLine, endLine: note.endLine }
      : UNATTACHED;
  }
  const starts = findExcerpt(fileDiff, note);
  const [startLine] = starts;
  if (startLine === undefined || starts.length > 1) return UNATTACHED;
  const endLine = startLine + note.endLine - note.startLine;
  return showsLines(fileDiff, startLine, endLine)
    ? { kind: "moved", startLine, endLine }
    : UNATTACHED;
}

// A moved note scans its whole file, and a shown file keeps its object across renders. Hydrating
// a partial diff mutates that object, so `isPartial` is part of the key.
const anchorCache = new WeakMap<FileDiffMetadata, Map<string, ReviewNoteAnchor>>();

export function cachedReviewNoteAnchor(
  note: ReviewNote,
  fileDiff: FileDiffMetadata,
  diffPath: string,
): ReviewNoteAnchor {
  let byNote = anchorCache.get(fileDiff);
  if (!byNote) {
    byNote = new Map();
    anchorCache.set(fileDiff, byNote);
  }
  const key = JSON.stringify([note.id, note.contentRevision, fileDiff.isPartial, diffPath]);
  let anchor = byNote.get(key);
  if (!anchor) {
    anchor = anchorReviewNote(note, fileDiff, diffPath);
    byNote.set(key, anchor);
  }
  return anchor;
}

const placedLine = ({ note, anchor }: PlacedReviewNote) =>
  anchor.kind === "exact" || anchor.kind === "moved" ? anchor.startLine : note.startLine;

/**
 * The notes on the shown files, in the order the viewer shows them. A note names its file from the
 * workspace root, as the agent did; the diff names it from the repository root.
 */
export function placeReviewNotes(
  notes: ReadonlyArray<ReviewNote>,
  files: ReadonlyArray<{
    readonly fileDiff: FileDiffMetadata;
    readonly fileKey: string;
    readonly pending: boolean;
  }>,
  roots: {
    readonly workspaceRoot: string | undefined;
    readonly repositoryRoot: string | undefined;
  },
): PlacedReviewNote[] {
  const placed: Array<{ readonly order: number; readonly placed: PlacedReviewNote }> = [];
  for (const note of notes) {
    const diffPath = diffPathForWorkspaceFile({ filePath: note.path, ...roots });
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
          : cachedReviewNoteAnchor(note, file.fileDiff, diffPath),
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
