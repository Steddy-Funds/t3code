import type { FileDiffMetadata } from "@pierre/diffs";

import type { ReviewCommentContext } from "~/reviewCommentContext";

import { SBS_SIDES, sbsDocumentOf, sbsLineIndex, type SbsSide } from "../sbsModel";
import type { SbsAnnotation } from "../SideBySideDiffView";

/** Lines of one pane, 1-based and inclusive. */
export interface SbsReviewLines {
  readonly side: SbsSide;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * One thing drawn on a pane's lines: the picked lines waiting for a comment, the open comment
 * box, a comment in the message draft, or an agent's review note.
 */
export interface SbsReviewEntry extends SbsReviewLines {
  readonly kind: "note" | "comment" | "draft" | "selection";
  readonly id: string;
}

/** What one gutter marker opens. */
export interface SbsReviewGroup {
  readonly entries: ReadonlyArray<SbsReviewEntry>;
}

export type SbsReviewAnnotation = SbsAnnotation<SbsReviewGroup>;

const KIND_ORDER: Record<SbsReviewEntry["kind"], number> = {
  note: 0,
  comment: 1,
  draft: 2,
  selection: 3,
};

/**
 * Entries whose lines overlap on a side share one annotation, so one marker and one card: the
 * view marks a line for one annotation only. The card lists notes, then comments, then the box.
 * An annotation takes the id of its first entry.
 */
export function groupSbsReviewEntries(
  entries: ReadonlyArray<SbsReviewEntry>,
): SbsReviewAnnotation[] {
  const annotations: SbsReviewAnnotation[] = [];
  for (const side of SBS_SIDES) {
    const onSide = entries
      .filter((entry) => entry.side === side)
      .toSorted((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
    let group: SbsReviewEntry[] = [];
    let endLine = 0;
    const close = () => {
      if (group.length === 0) return;
      const ordered = group.toSorted(
        (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.startLine - b.startLine,
      );
      annotations.push({
        id: ordered[0]!.id,
        side,
        startLine: group[0]!.startLine,
        endLine,
        data: { entries: ordered },
      });
    };
    for (const entry of onSide) {
      if (group.length > 0 && entry.startLine <= endLine) {
        group.push(entry);
        endLine = Math.max(endLine, entry.endLine);
        continue;
      }
      close();
      group = [entry];
      endLine = entry.endLine;
    }
    close();
  }
  return annotations;
}

const lastAnnotations = new WeakMap<
  FileDiffMetadata,
  { readonly key: string; readonly annotations: ReadonlyArray<SbsReviewAnnotation> }
>();

/**
 * `groupSbsReviewEntries` for the view of `fileDiff`, keeping the last list while the entries
 * keep their lines: the view redraws every row when its annotations change, and typing in a
 * box or opening a card must not.
 */
export function sbsReviewAnnotationsOf(
  fileDiff: FileDiffMetadata,
  entries: ReadonlyArray<SbsReviewEntry>,
): ReadonlyArray<SbsReviewAnnotation> {
  const key = JSON.stringify(
    entries.map((entry) => [entry.kind, entry.id, entry.side, entry.startLine, entry.endLine]),
  );
  const last = lastAnnotations.get(fileDiff);
  if (last?.key === key) return last.annotations;
  const annotations = groupSbsReviewEntries(entries);
  lastAnnotations.set(fileDiff, { key, annotations });
  return annotations;
}

const HUNK_HEADER = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/u;

/**
 * Where a comment from the message draft sits in this layout. A range across both sides, as
 * stacked makes one, goes on the side it ends on, over the lines of that side it covers.
 */
export function sbsCommentLines(comment: ReviewCommentContext): SbsReviewLines | null {
  const selection = comment.selection;
  if (selection && selection.side === selection.endSide) {
    return {
      side: selection.side,
      startLine: Math.min(selection.start, selection.end),
      endLine: Math.max(selection.start, selection.end),
    };
  }
  const header = HUNK_HEADER.exec(comment.diff);
  if (!header) return null;
  const ranges: Record<SbsSide, { readonly start: number; readonly count: number }> = {
    deletions: { start: Number(header[1]), count: Number(header[2]) },
    additions: { start: Number(header[3]), count: Number(header[4]) },
  };
  const preferred: SbsSide = selection?.endSide ?? "additions";
  const side: SbsSide =
    ranges[preferred].count > 0 ? preferred : preferred === "additions" ? "deletions" : "additions";
  const range = ranges[side];
  if (range.count <= 0) return null;
  return { side, startLine: range.start, endLine: range.start + range.count - 1 };
}

/** Whether both ends of `lines` are lines the view of `fileDiff` has. */
export function sbsShowsLines(fileDiff: FileDiffMetadata, lines: SbsReviewLines): boolean {
  const document = sbsDocumentOf(fileDiff);
  return (
    sbsLineIndex(document, lines.side, lines.startLine) >= 0 &&
    sbsLineIndex(document, lines.side, lines.endLine) >= 0
  );
}
