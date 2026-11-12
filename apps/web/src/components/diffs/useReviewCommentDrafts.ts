import type { SelectedLineRange } from "@pierre/diffs";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import type { ReviewCommentContext } from "~/reviewCommentContext";

import type { ReviewSendOutcome } from "../chat/composerSend.logic";

/** Sends one message holding these comments and nothing else. Settles with how it ended. */
export type SendReviewComments = (
  comments: ReadonlyArray<ReviewCommentContext>,
) => Promise<ReviewSendOutcome>;

export interface ReviewCommentBuildInput<TRange> {
  readonly id: string;
  readonly range: TRange;
  /** What the user typed. Empty while the box is only being opened. */
  readonly text: string;
  /** The words the user had selected when the box opened: quote them with `withQuotedSelection`. */
  readonly selectedText: string | undefined;
}

export type ReviewCommentAnnotation<TRange> =
  | {
      readonly kind: "draft";
      readonly id: string;
      readonly range: TRange;
      readonly rangeLabel: string;
      /** Shown above the box, because the comment will open with it quoted. */
      readonly selectedText: string | undefined;
      readonly text: string;
      /** On its way to the agent; the box closes when the send settles. */
      readonly sending: boolean;
    }
  | { readonly kind: "comment"; readonly id: string; readonly comment: ReviewCommentContext };

export interface ReviewCommentDrafts<TRange> {
  /** The comments this surface owns in the message draft, then the open box, if any. */
  readonly annotations: ReadonlyArray<ReviewCommentAnnotation<TRange>>;
  /** Opens the comment box on `range`. Does nothing where no comment can be built. */
  readonly beginComment: (range: TRange, selectedText?: string) => void;
  readonly setDraftText: (text: string) => void;
  /** The lines under the open box moved, as an edit above them does. */
  readonly moveDraft: (range: TRange) => void;
  /** Saves the open comment into the message draft and closes the box. */
  readonly addToMessage: (text: string) => void;
  /**
   * Sends the open comment as its own message; unless that was dispatched or queued, the
   * comment is kept as `addToMessage` keeps it. Null where there is no thread to send to.
   */
  readonly sendNow: ((text: string) => Promise<ReviewSendOutcome>) | null;
  /** Closes the open box and drops its text. */
  readonly cancel: () => void;
  /** Takes a saved comment out of the message draft. */
  readonly removeComment: (commentId: string) => void;
}

const EMPTY_REVIEW_COMMENTS: ReadonlyArray<ReviewCommentContext> = [];

/**
 * The comments a review send carries. Pull request context stays behind: a reference belongs
 * to the message being written, and a remark on a pull request travels with its reference.
 */
export function sendableReviewComments(
  comments: ReadonlyArray<ReviewCommentContext>,
): ReviewCommentContext[] {
  return comments.filter(
    (comment) =>
      comment.pullRequest === undefined && !comment.sectionId.startsWith("pull-request:"),
  );
}
const QUOTED_SELECTION_MAX_CHARS = 400;

let commentSequence = 0;

function nextReviewCommentId(): string {
  commentSequence += 1;
  return `review-comment-${Date.now()}-${commentSequence}`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * The lines a comment covers, without the hunk header and change markers of a diff. A range on
 * one side also gives that side's lines alone: a pane of a split or side-by-side view holds
 * only those, so text selected there skips the other side's rows of a change.
 */
function reviewCommentCode(comment: ReviewCommentContext): string[] {
  if ((comment.fenceLanguage ?? "diff") !== "diff") return [comment.diff];
  const lines = comment.diff.split("\n").slice(1);
  const code = (kept: ReadonlyArray<string>) => kept.map((line) => line.slice(1)).join("\n");
  const side = comment.selection?.side;
  if (!side || comment.selection?.endSide !== side) return [code(lines)];
  const otherMarker = side === "additions" ? "-" : "+";
  return [code(lines), code(lines.filter((line) => !line.startsWith(otherMarker)))];
}

/**
 * `comment` with the words the user selected quoted above its text, so the agent sees exactly
 * what the comment is about. A selection that is not from the commented lines is left out.
 */
export function withQuotedSelection(
  comment: ReviewCommentContext,
  selectedText: string | undefined,
): ReviewCommentContext {
  const selected = selectedText?.replaceAll("\r", "").trim() ?? "";
  if (
    selected === "" ||
    !reviewCommentCode(comment).some((code) =>
      collapseWhitespace(code).includes(collapseWhitespace(selected)),
    )
  ) {
    return comment;
  }
  let quoted = selected;
  if (selected.length > QUOTED_SELECTION_MAX_CHARS) {
    const cut = selected.slice(0, QUOTED_SELECTION_MAX_CHARS);
    // Never end on half of a surrogate pair.
    quoted = `${/[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut}…`;
  }
  const quote = quoted
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
  return { ...comment, text: comment.text === "" ? quote : `${quote}\n\n${comment.text}` };
}

interface OpenComment<TRange> {
  readonly id: string;
  readonly range: TRange;
  readonly rangeLabel: string;
  readonly selectedText: string | undefined;
  readonly text: string;
  readonly sending: boolean;
}

/**
 * Review comments on one surface: the open comment box, and this surface's comments that wait
 * in the message draft. The surface says how a comment is built and which stored ones are its
 * own. Every surface reads the same draft, so a comment sent or removed leaves all of them.
 */
export function useReviewCommentDrafts<TRange = SelectedLineRange>({
  composerDraftTarget,
  buildComment,
  ownsComment,
  onSend,
}: {
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  /** Null when the range no longer names lines this surface has. */
  readonly buildComment: (input: ReviewCommentBuildInput<TRange>) => ReviewCommentContext | null;
  readonly ownsComment: (comment: ReviewCommentContext) => boolean;
  /** Absent where there is no thread to send to, or this connection cannot send. */
  readonly onSend?: SendReviewComments | undefined;
}): ReviewCommentDrafts<TRange> {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const reviewComments = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.reviewComments ?? EMPTY_REVIEW_COMMENTS,
  );
  const [open, setOpen] = useState<OpenComment<TRange> | null>(null);

  const annotations: ReviewCommentAnnotation<TRange>[] = reviewComments
    .filter(ownsComment)
    .map((comment) => ({ kind: "comment", id: comment.id, comment }));
  if (open) annotations.push({ kind: "draft", ...open });

  const buildOpenComment = (text: string) =>
    open
      ? buildComment({ id: open.id, range: open.range, text, selectedText: open.selectedText })
      : null;
  const closeBox = (id: string) => setOpen((current) => (current?.id === id ? null : current));

  return {
    annotations,
    beginComment: (range, selectedText) => {
      const id = nextReviewCommentId();
      const comment = buildComment({ id, range, text: "", selectedText });
      if (!comment) return;
      setOpen({
        id,
        range,
        rangeLabel: comment.rangeLabel,
        // A comment built from no words has text only when the surface quoted the selection.
        selectedText: comment.text === "" ? undefined : selectedText,
        text: "",
        sending: false,
      });
    },
    setDraftText: (text) => setOpen((current) => (current ? { ...current, text } : current)),
    moveDraft: (range) => {
      if (!open) return;
      const comment = buildComment({ id: open.id, range, text: "", selectedText: undefined });
      if (!comment) return;
      setOpen((current) =>
        current?.id === open.id ? { ...current, range, rangeLabel: comment.rangeLabel } : current,
      );
    },
    addToMessage: (text) => {
      // A range that no longer resolves keeps the box, and the words in it.
      const comment = buildOpenComment(text);
      if (!comment) return;
      addReviewComment(composerDraftTarget, comment);
      closeBox(comment.id);
    },
    sendNow: onSend
      ? async (text) => {
          const comment = buildOpenComment(text);
          if (!comment) {
            // The box stays open with its words; a surface that can reach this says why.
            return { status: "refused", reason: "These lines are no longer in view." };
          }
          setOpen((current) =>
            current?.id === comment.id ? { ...current, sending: true } : current,
          );
          const outcome = await onSend([comment]).catch((): ReviewSendOutcome => ({
            status: "failed",
            reason: "The message could not be sent.",
          }));
          // Runs even after the surface unmounted: an unsent comment must reach the draft.
          if (outcome.status !== "dispatched" && outcome.status !== "queued") {
            addReviewComment(composerDraftTarget, comment);
          }
          closeBox(comment.id);
          return outcome;
        }
      : null,
    cancel: () => setOpen(null),
    removeComment: (commentId) => removeReviewComment(composerDraftTarget, commentId),
  };
}
