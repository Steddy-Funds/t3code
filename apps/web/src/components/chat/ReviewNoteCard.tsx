import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ReviewNote, reviewNoteSectionId } from "@t3tools/shared/reviewNote";
import { FileDiffIcon, ReplyIcon } from "lucide-react";
import { type ReactNode, use } from "react";

import type { DraftId } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import {
  buildReviewNoteReply,
  reviewNoteRangeLabel,
  useReviewNoteRevealStore,
  useThreadReviewNotes,
} from "~/reviewNotes";

import { ReviewCommentBox } from "../diffs/ReviewCommentBox";
import {
  type SendReviewComments,
  useReviewCommentDrafts,
  withQuotedSelection,
} from "../diffs/useReviewCommentDrafts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TimelineRowCtx } from "./timelineRowContext";

/** The agent's note and question, always as plain text: an agent's markup is never rendered. */
export function ReviewNoteText({ note, className }: { note: ReviewNote; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-1 text-sm", className)}>
      <p className="whitespace-pre-wrap break-words">{note.note}</p>
      {note.question ? (
        <p className="whitespace-pre-wrap break-words font-medium">{note.question}</p>
      ) : null}
    </div>
  );
}

const EXCERPT_LINES = 6;

/** The lines the agent flagged as it saw them, so a note reads without its diff. */
export function ReviewNoteExcerpt({ note, className }: { note: ReviewNote; className?: string }) {
  if (note.excerpt.trim().length === 0) return null;
  const lines = note.excerpt.split(/\r?\n/u);
  const clipped = lines.length > EXCERPT_LINES || note.excerptTruncated;
  return (
    <pre
      className={cn(
        "min-w-0 whitespace-pre-wrap break-words border-border border-s-2 ps-2 font-mono text-muted-foreground text-xs leading-relaxed",
        className,
      )}
    >
      {lines.slice(0, EXCERPT_LINES).join("\n")}
      {clipped ? "\n…" : null}
    </pre>
  );
}

function IconAction({
  label,
  wideLabel,
  onClick,
  children,
}: {
  label: string;
  wideLabel?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
        {wideLabel ? <span className="hidden @[28rem]/review-note:inline">{label}</span> : null}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function ReviewNoteFrame({
  note,
  actions,
  children,
}: {
  note: ReviewNote;
  actions: ReactNode;
  children?: ReactNode;
}) {
  const ctx = use(TimelineRowCtx);
  const { answeredIds } = useThreadReviewNotes(ctx.threadRef);
  const showInDiff = ctx.onOpenTurnDiff;
  const threadRef = ctx.threadRef;
  return (
    <div
      className="@container/review-note min-w-0 rounded-lg bg-secondary dark:bg-input/20"
      data-review-note-id={note.id}
    >
      <div className="flex items-center justify-between gap-2 px-3 pt-2">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Tooltip>
            <TooltipTrigger render={<span className="truncate font-mono text-foreground" />}>
              {note.path}
            </TooltipTrigger>
            <TooltipPopup side="top">{note.path}</TooltipPopup>
          </Tooltip>
          <span className="shrink-0 text-muted-foreground">{reviewNoteRangeLabel(note)}</span>
          {answeredIds.has(note.id) ? (
            <Badge variant="success" size="sm" className="shrink-0">
              Answered
            </Badge>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {showInDiff && threadRef ? (
            <IconAction
              label="Show in diff"
              wideLabel
              onClick={() => {
                showInDiff(note.runId, note.path);
                useReviewNoteRevealStore.getState().request(threadRef, note.id);
              }}
            >
              <FileDiffIcon className="size-3" />
            </IconAction>
          ) : null}
          {actions}
        </div>
      </div>
      <ReviewNoteExcerpt note={note} className="mx-3 mt-1.5" />
      <ReviewNoteText note={note} className="px-3 pt-1.5 pb-3" />
      {children}
    </div>
  );
}

function RepliableReviewNote({
  note,
  threadRef,
  draftTarget,
  onSend,
}: {
  note: ReviewNote;
  threadRef: ScopedThreadRef | null;
  draftTarget: ScopedThreadRef | DraftId;
  onSend: SendReviewComments | undefined;
}) {
  const sectionId = reviewNoteSectionId(note.id);
  const replies = useReviewCommentDrafts<ReviewNote>({
    composerDraftTarget: draftTarget,
    onSend,
    buildComment: ({ id, range, text, selectedText }) =>
      withQuotedSelection(buildReviewNoteReply({ id, note: range, text }), selectedText),
    ownsComment: (comment) => comment.sectionId === sectionId,
  });
  const replying = replies.annotations.some((annotation) => annotation.kind === "draft");
  return (
    <ReviewNoteFrame
      note={note}
      actions={
        replying ? null : (
          <IconAction label="Reply" onClick={() => replies.beginComment(note)}>
            <ReplyIcon className="size-3" />
          </IconAction>
        )
      }
    >
      {replies.annotations.length > 0 ? (
        <div className="divide-y divide-border/30 border-t border-border/30">
          {replies.annotations.map((annotation) => (
            <ReviewCommentBox
              key={annotation.id}
              environmentId={threadRef?.environmentId}
              ownerKey={JSON.stringify([draftTarget, "review-note", note.id, annotation.id])}
              annotation={annotation}
              drafts={replies}
            />
          ))}
        </div>
      ) : null}
    </ReviewNoteFrame>
  );
}

/** A note an agent left on lines it changed, with a reply that goes back as a review comment. */
export function ReviewNoteCard({ note }: { note: ReviewNote }) {
  const ctx = use(TimelineRowCtx);
  const replies = ctx.reviewNoteReplies;
  return (
    <div className="min-w-0 px-1">
      {replies ? (
        <RepliableReviewNote
          note={note}
          threadRef={ctx.threadRef}
          draftTarget={replies.draftTarget}
          onSend={replies.onSend}
        />
      ) : (
        <ReviewNoteFrame note={note} actions={null} />
      )}
    </div>
  );
}
