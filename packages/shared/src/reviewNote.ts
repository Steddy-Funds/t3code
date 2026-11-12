import {
  OrchestrationV2ReviewNote,
  REVIEW_NOTE_TOOL_NAME,
  REVIEW_NOTE_TURN_ITEM_PREFIX,
  type OrchestrationMessageContext,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type ReviewNote = OrchestrationV2ReviewNote & { readonly id: TurnItemId };

const decodeReviewNote = Schema.decodeUnknownOption(OrchestrationV2ReviewNote);

/**
 * The note the server recorded for a `flag_for_review` call. Only the server writes a
 * review-note id, so the provider's own row for the call, or any lookalike, stays a tool row.
 */
export function reviewNoteFromToolItem(item: {
  readonly id: TurnItemId;
  readonly type: string;
  readonly toolName?: string | null | undefined;
  readonly nativeItemRef?: unknown;
  readonly input?: unknown;
}): ReviewNote | undefined {
  if (
    item.type !== "dynamic_tool" ||
    item.toolName !== REVIEW_NOTE_TOOL_NAME ||
    !item.id.startsWith(REVIEW_NOTE_TURN_ITEM_PREFIX) ||
    (item.nativeItemRef !== null && item.nativeItemRef !== undefined)
  ) {
    return undefined;
  }
  return Option.getOrUndefined(
    Option.map(decodeReviewNote(item.input), (note) => ({ ...note, id: item.id })),
  );
}

/** `L7`, or `L7 to L9`. */
export const reviewNoteRangeLabel = (note: Pick<ReviewNote, "startLine" | "endLine">) =>
  note.startLine === note.endLine ? `L${note.startLine}` : `L${note.startLine} to L${note.endLine}`;

const SECTION_PREFIX = "review-note:";

/**
 * The review-comment section a reply to the note carries. Keyed by the id's hash alone: a
 * section id holds 255 characters and the thread id inside a note id has no limit.
 */
export const reviewNoteSectionId = (noteId: TurnItemId) =>
  `${SECTION_PREFIX}${noteId.slice(noteId.lastIndexOf(":") + 1)}`;

/** The notes the user replied to: a reply is a review comment in the note's section. */
export function answeredReviewNoteIds(
  notes: ReadonlyArray<ReviewNote>,
  messages: Iterable<{
    readonly role: string;
    readonly context?: OrchestrationMessageContext | undefined;
  }>,
): ReadonlySet<TurnItemId> {
  const sections = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const record of message.context?.records ?? []) {
      if (
        typeof record === "object" &&
        record !== null &&
        "kind" in record &&
        record.kind === "review-comment" &&
        "sectionId" in record &&
        typeof record.sectionId === "string" &&
        record.sectionId.startsWith(SECTION_PREFIX)
      ) {
        sections.add(record.sectionId);
      }
    }
  }
  return new Set(
    notes.flatMap((note) => (sections.has(reviewNoteSectionId(note.id)) ? [note.id] : [])),
  );
}
