import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, TurnItemId } from "@t3tools/contracts";
import {
  answeredReviewNoteIds,
  type ReviewNote,
  reviewNoteFromToolItem,
  reviewNoteRangeLabel,
  reviewNoteSectionId,
} from "@t3tools/shared/reviewNote";
import { create } from "zustand";

import { inferReviewCommentFenceLanguage, type ReviewCommentContext } from "./reviewCommentContext";
import { useQuietThreadVisibleTurnItems } from "./state/entities";

export interface ThreadReviewNotes {
  readonly notes: ReadonlyArray<ReviewNote>;
  readonly answeredIds: ReadonlySet<TurnItemId>;
}

/**
 * The review notes among the thread's loaded turn items, and which of them the user answered.
 * Reads the quiet items, so a streaming reply does not recompute it.
 */
export function useThreadReviewNotes(ref: ScopedThreadRef | null): ThreadReviewNotes {
  const rows = useQuietThreadVisibleTurnItems(ref);
  const notes: ReviewNote[] = [];
  for (const row of rows) {
    const note = reviewNoteFromToolItem(row.item);
    if (note) notes.push(note);
  }
  const answeredIds = answeredReviewNoteIds(
    notes,
    rows.flatMap(({ item }) =>
      item.type === "user_message" ? [{ role: "user", context: item.context }] : [],
    ),
  );
  return { notes, answeredIds };
}

export { reviewNoteRangeLabel };

/** A reply to `note`: a review comment in the note's section that quotes the noted lines. */
export function buildReviewNoteReply(input: {
  readonly id: string;
  readonly note: ReviewNote;
  readonly text: string;
}): ReviewCommentContext {
  const { note } = input;
  return {
    id: input.id,
    sectionId: reviewNoteSectionId(note.id),
    sectionTitle: "Review note",
    filePath: note.path,
    startIndex: note.startLine - 1,
    endIndex: note.endLine - 1,
    rangeLabel: reviewNoteRangeLabel(note),
    text: input.text.trim(),
    diff: note.excerpt,
    fenceLanguage: inferReviewCommentFenceLanguage(note.path),
  };
}

/** "Show in diff" asks the diff panel to bring this note into view once it shows the file. */
export const useReviewNoteRevealStore = create<{
  readonly byThreadKey: Readonly<Record<string, { noteId: string; requestId: number }>>;
  readonly request: (ref: ScopedThreadRef, noteId: string) => void;
}>()((set) => ({
  byThreadKey: {},
  request: (ref, noteId) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [key]: { noteId, requestId: (state.byThreadKey[key]?.requestId ?? 0) + 1 },
        },
      };
    }),
}));
