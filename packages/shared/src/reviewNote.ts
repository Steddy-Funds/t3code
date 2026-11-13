import {
  OrchestrationV2ReviewNote,
  OrchestrationV2ReviewReply,
  REVIEW_NOTE_TOOL_NAME,
  REVIEW_NOTE_TURN_ITEM_PREFIX,
  REVIEW_REPLY_TOOL_NAME,
  REVIEW_REPLY_TURN_ITEM_PREFIX,
  type OrchestrationMessageContext,
  type ReviewCommentContextRecord,
  RunId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type ReviewNote = OrchestrationV2ReviewNote & { readonly id: TurnItemId };

export type ReviewReply = OrchestrationV2ReviewReply & { readonly id: TurnItemId };

const decodeReviewNote = Schema.decodeUnknownOption(OrchestrationV2ReviewNote);
const decodeReviewReply = Schema.decodeUnknownOption(OrchestrationV2ReviewReply);

interface ToolItem {
  readonly id: TurnItemId;
  readonly type: string;
  readonly toolName?: string | null | undefined;
  readonly nativeItemRef?: unknown;
  readonly input?: unknown;
}

/** Only the server writes these ids, so a provider's own row for the call stays a tool row. */
const isServerRecord = (item: ToolItem, toolName: string, prefix: string) =>
  item.type === "dynamic_tool" &&
  item.toolName === toolName &&
  item.id.startsWith(prefix) &&
  (item.nativeItemRef === null || item.nativeItemRef === undefined);

/** The note the server recorded for a `flag_for_review` call. */
export function reviewNoteFromToolItem(item: ToolItem): ReviewNote | undefined {
  if (!isServerRecord(item, REVIEW_NOTE_TOOL_NAME, REVIEW_NOTE_TURN_ITEM_PREFIX)) return undefined;
  return Option.getOrUndefined(
    Option.map(decodeReviewNote(item.input), (note) => ({ ...note, id: item.id })),
  );
}

/** The reply the server recorded for a `reply_to_review_comment` call. */
export function reviewReplyFromToolItem(item: ToolItem): ReviewReply | undefined {
  if (!isServerRecord(item, REVIEW_REPLY_TOOL_NAME, REVIEW_REPLY_TURN_ITEM_PREFIX)) {
    return undefined;
  }
  return Option.getOrUndefined(
    Option.map(decodeReviewReply(item.input), (reply) => ({ ...reply, id: item.id })),
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

const THREAD_SECTION_PREFIX = "review-thread:";
// A thread whose path is from the workspace root, so a follow-up read alone keeps it.
const FILE_THREAD_SECTION_PREFIX = "review-file-thread:";

/** The section a follow-up to a review thread carries, naming the comment that opened it. */
export const reviewThreadSectionId = (
  rootCommentId: string,
  pathBase: "diff" | "workspace" = "diff",
) =>
  `${pathBase === "workspace" ? FILE_THREAD_SECTION_PREFIX : THREAD_SECTION_PREFIX}${rootCommentId}`;

const threadRootOf = (sectionId: string) =>
  sectionId.startsWith(THREAD_SECTION_PREFIX)
    ? sectionId.slice(THREAD_SECTION_PREFIX.length)
    : sectionId.startsWith(FILE_THREAD_SECTION_PREFIX)
      ? sectionId.slice(FILE_THREAD_SECTION_PREFIX.length)
      : undefined;

/**
 * A review comment the user sent, as a thread: where it sits, for the views that place it.
 * A comment from a diff names its file from the repository root; one from the file viewer
 * (or a reply to a note) from the workspace root.
 */
export interface ReviewCommentThread {
  readonly kind: "review_comment_thread";
  /** The opening comment's context id. */
  readonly id: string;
  readonly sectionId: string;
  readonly path: string;
  readonly pathBase: "diff" | "workspace";
  readonly startLine: number;
  readonly endLine: number;
  /** The lines the comment was on, new side only; empty when it was on removed lines alone. */
  readonly excerpt: string;
  readonly excerptTruncated: false;
  readonly contentRevision: null;
  readonly comment: string;
  readonly rangeLabel: string;
  /** The turn whose diff the comment was written on, when it was on one. */
  readonly runId: RunId | null;
}

/** What a diff places on lines: an agent's note, or a thread the user's comment opened. */
export type ReviewItem = ReviewNote | ReviewCommentThread;

/** The section a reply under the item carries. */
export const reviewItemSectionId = (item: ReviewItem) =>
  item.kind === "review_note" ? reviewNoteSectionId(item.id) : item.sectionId;

export type ReviewThreadEntry =
  | { readonly kind: "comment"; readonly id: string; readonly text: string }
  | { readonly kind: "reply"; readonly id: TurnItemId; readonly text: string };

/** A sent comment, as its message or a reply's copy of it carries it. */
type SentComment = Pick<
  ReviewCommentContextRecord,
  "sectionId" | "filePath" | "rangeLabel" | "startIndex" | "endIndex" | "text" | "diff"
> & { readonly fenceLanguage?: string | undefined };

const TURN_SECTION_PREFIX = "turn:";
const PULL_REQUEST_SECTION_PREFIX = "pull-request:";

const DIFF_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u;

/** Where a sent comment sits: the new side of a diff hunk it quoted, or the file lines it quoted. */
function commentLines(comment: SentComment) {
  const [header, ...body] = comment.diff.split("\n");
  const match =
    (comment.fenceLanguage ?? "diff") === "diff" ? DIFF_HEADER.exec(header ?? "") : null;
  if (match) {
    const lines = body
      .filter((line) => !line.startsWith("-"))
      .map((line) => line.slice(1).replace(/\r$/u, ""));
    const startLine = Number(match[1]);
    return {
      pathBase: "diff" as const,
      startLine: Math.max(1, startLine),
      endLine: Math.max(1, startLine + lines.length - 1),
      excerpt: lines.join("\n"),
    };
  }
  return {
    pathBase:
      comment.sectionId.startsWith("file:") ||
      comment.sectionId.startsWith(SECTION_PREFIX) ||
      comment.sectionId.startsWith(FILE_THREAD_SECTION_PREFIX)
        ? ("workspace" as const)
        : ("diff" as const),
    startLine: comment.startIndex + 1,
    endLine: comment.endIndex + 1,
    // The views compare against lines without their CRLF ending.
    excerpt: comment.diff.replace(/(?:\r?\n)+$/u, "").replace(/\r$/gmu, ""),
  };
}

function threadOf(id: string, comment: SentComment): ReviewCommentThread {
  const lines = commentLines(comment);
  return {
    kind: "review_comment_thread",
    id,
    sectionId: reviewThreadSectionId(id, lines.pathBase),
    path: comment.filePath,
    ...lines,
    excerptTruncated: false,
    contentRevision: null,
    comment: comment.text,
    rangeLabel: comment.rangeLabel,
    runId: comment.sectionId.startsWith(TURN_SECTION_PREFIX)
      ? RunId.make(comment.sectionId.slice(TURN_SECTION_PREFIX.length))
      : null,
  };
}

export interface ReviewThreads {
  /** The threads the user's comments opened, in the order they were sent. */
  readonly threads: ReadonlyArray<ReviewCommentThread>;
  /** By note id or thread id: what was said under it after it opened, oldest first. */
  readonly conversations: ReadonlyMap<string, ReadonlyArray<ReviewThreadEntry>>;
  /** Comments sent to the agent, per file as each comment named it. */
  readonly sentComments: ReadonlyArray<{
    readonly path: string;
    readonly pathBase: "diff" | "workspace";
  }>;
}

export type ReviewTimelineEntry =
  | { readonly kind: "comment"; readonly contextId: string; readonly record: SentComment }
  | { readonly kind: "reply"; readonly reply: ReviewReply };

/**
 * The review threads of a thread's timeline, read in order. A comment opens a thread unless it
 * answers a note or follows up a thread; an agent's reply joins the thread of the comment it
 * answers, and opens it from its own copy when that comment's message is not loaded.
 */
export function buildReviewThreads(
  notes: ReadonlyArray<ReviewNote>,
  timeline: Iterable<ReviewTimelineEntry>,
): ReviewThreads {
  const noteBySection = new Map(notes.map((note) => [reviewNoteSectionId(note.id), note.id]));
  const threads: ReviewCommentThread[] = [];
  const threadById = new Map<string, ReviewCommentThread>();
  const conversations = new Map<string, ReviewThreadEntry[]>();
  // Each comment's thread or note, so a reply to a follow-up joins the follow-up's thread.
  const threadOfComment = new Map<string, string>();
  const sentComments: Array<{ path: string; pathBase: "diff" | "workspace" }> = [];
  const say = (threadId: string, entry: ReviewThreadEntry) =>
    conversations.set(threadId, [...(conversations.get(threadId) ?? []), entry]);
  const open = (id: string, comment: SentComment) => {
    const thread = threadOf(id, comment);
    threads.push(thread);
    threadById.set(id, thread);
    return thread;
  };

  // The note or known thread a comment's section answers, if any.
  const answered = (sectionId: string) => {
    const noteId = noteBySection.get(sectionId);
    if (noteId !== undefined) return { id: noteId, thread: undefined };
    const root = threadRootOf(sectionId);
    if (root === undefined) return undefined;
    const thread = threadById.get(threadOfComment.get(root) ?? root);
    return thread ? { id: thread.id, thread } : undefined;
  };
  const send = (contextId: string, comment: SentComment) => {
    const target = answered(comment.sectionId);
    if (target === undefined) {
      const thread = open(contextId, comment);
      threadOfComment.set(contextId, thread.id);
      sentComments.push({ path: thread.path, pathBase: thread.pathBase });
      return thread.id;
    }
    threadOfComment.set(contextId, target.id);
    say(target.id, { kind: "comment", id: contextId, text: comment.text });
    sentComments.push({
      path: target.thread?.path ?? comment.filePath,
      pathBase: target.thread?.pathBase ?? "workspace",
    });
    return target.id;
  };

  for (const entry of timeline) {
    // A pull request's Code tab keeps its own comments; they are not local review threads.
    const comment = entry.kind === "comment" ? entry.record : entry.reply.comment;
    if (comment.sectionId.startsWith(PULL_REQUEST_SECTION_PREFIX)) continue;
    if (entry.kind === "comment") {
      if (!threadOfComment.has(entry.contextId)) send(entry.contextId, entry.record);
      continue;
    }
    const { reply } = entry;
    const threadId = threadOfComment.get(reply.commentId) ?? send(reply.commentId, reply.comment);
    say(threadId, { kind: "reply", id: reply.id, text: reply.reply });
  }
  return { threads, conversations, sentComments };
}
