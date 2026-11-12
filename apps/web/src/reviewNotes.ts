import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, TurnItemId } from "@t3tools/contracts";
import {
  answeredReviewNoteIds,
  buildReviewThreads,
  type ReviewCommentThread,
  type ReviewItem,
  type ReviewNote,
  reviewNoteFromToolItem,
  reviewNoteRangeLabel,
  reviewNoteSectionId,
  reviewReplyFromToolItem,
  type ReviewThreads,
  type ReviewTimelineEntry,
} from "@t3tools/shared/reviewNote";
import { create } from "zustand";

import { inferReviewCommentFenceLanguage, type ReviewCommentContext } from "./reviewCommentContext";
import { useQuietThreadVisibleTurnItems } from "./state/entities";

export interface ThreadReviewNotes extends ReviewThreads {
  readonly notes: ReadonlyArray<ReviewNote>;
  readonly answeredIds: ReadonlySet<TurnItemId>;
}

/**
 * The review notes among the thread's loaded turn items, which of them the user answered, and
 * the threads the user's sent comments and the agent's replies make. Reads the quiet items, so
 * a streaming reply does not recompute it.
 */
export function useThreadReviewNotes(ref: ScopedThreadRef | null): ThreadReviewNotes {
  const rows = useQuietThreadVisibleTurnItems(ref);
  let built = reviewNotesByRows.get(rows);
  if (built === undefined) {
    built = buildThreadReviewNotes(rows);
    reviewNotesByRows.set(rows, built);
  }
  return built;
}

type VisibleRows = ReturnType<typeof useQuietThreadVisibleTurnItems>;

// Every card and view of a thread asks for these; they are built once per loaded timeline.
const reviewNotesByRows = new WeakMap<VisibleRows, ThreadReviewNotes>();

function buildThreadReviewNotes(rows: VisibleRows): ThreadReviewNotes {
  const notes: ReviewNote[] = [];
  const timeline: ReviewTimelineEntry[] = [];
  for (const { item } of rows) {
    if (item.type === "user_message") {
      for (const record of item.context?.records ?? []) {
        // A newer client's kind arrives as an unknown record, without the comment's fields.
        if (record.kind === "review-comment" && "sectionId" in record) {
          timeline.push({ kind: "comment", contextId: record.contextId, record });
        }
      }
      continue;
    }
    const note = reviewNoteFromToolItem(item);
    if (note) {
      notes.push(note);
      continue;
    }
    const reply = reviewReplyFromToolItem(item);
    if (reply) timeline.push({ kind: "reply", reply });
  }
  const answeredIds = answeredReviewNoteIds(
    notes,
    rows.flatMap(({ item }) =>
      item.type === "user_message" ? [{ role: "user", context: item.context }] : [],
    ),
  );
  return { notes, answeredIds, ...buildReviewThreads(notes, timeline) };
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

/** A follow-up in `thread`: a review comment in its section that quotes its lines. */
export function buildReviewThreadReply(input: {
  readonly id: string;
  readonly thread: ReviewCommentThread;
  readonly text: string;
}): ReviewCommentContext {
  const { thread } = input;
  return {
    id: input.id,
    sectionId: thread.sectionId,
    sectionTitle: "Review thread",
    filePath: thread.path,
    startIndex: thread.startLine - 1,
    endIndex: Math.max(thread.startLine, thread.endLine) - 1,
    rangeLabel: thread.rangeLabel,
    text: input.text.trim(),
    diff: thread.excerpt,
    fenceLanguage: inferReviewCommentFenceLanguage(thread.path),
  };
}

/** A reply under a note or in a thread the user opened. */
export const buildReviewItemReply = (input: {
  readonly id: string;
  readonly item: ReviewItem;
  readonly text: string;
}): ReviewCommentContext =>
  input.item.kind === "review_note"
    ? buildReviewNoteReply({ id: input.id, note: input.item, text: input.text })
    : buildReviewThreadReply({ id: input.id, thread: input.item, text: input.text });

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
