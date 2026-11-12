import {
  type ReviewItem,
  reviewNoteRangeLabel,
  type ReviewThreadEntry,
} from "@t3tools/shared/reviewNote";
import { BotMessageSquareIcon, EyeOffIcon, ReplyIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { ReviewNoteText } from "../chat/ReviewNoteCard";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ReviewNoteIconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** The note's words, or the user's comment that opened the thread. Plain text, never markup. */
export function ReviewItemText({
  item,
  className,
}: {
  item: ReviewItem;
  className?: string | undefined;
}) {
  if (item.kind === "review_note") return <ReviewNoteText note={item} className={className} />;
  return (
    <div className={cn("min-w-0 text-sm", className)}>
      <p className="whitespace-pre-wrap break-words">{item.comment}</p>
    </div>
  );
}

/** What was said under a note or comment: the user's follow-ups, and the agent's replies marked. */
function ReviewConversation({ entries }: { entries: ReadonlyArray<ReviewThreadEntry> }) {
  if (entries.length === 0) return null;
  return (
    <ol className="divide-y divide-border/30 border-t border-border/30">
      {entries.map((entry) => (
        <li
          key={entry.id}
          data-review-entry={entry.kind}
          className={cn(
            "flex min-w-0 items-start gap-2 px-3 py-2 text-sm",
            entry.kind === "reply" && "border-s-2 border-primary/60 bg-primary/5",
          )}
        >
          {entry.kind === "reply" ? (
            <BotMessageSquareIcon
              aria-label="Agent"
              className="mt-0.5 size-3.5 shrink-0 text-primary"
            />
          ) : (
            <span className="mt-px shrink-0 font-medium text-muted-foreground text-xs">You</span>
          )}
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{entry.text}</p>
        </li>
      ))}
    </ol>
  );
}

/**
 * A review item at its lines: an agent's note, or a comment the user sent, with the conversation
 * under it and then any reply being written.
 */
export function ReviewNoteAnnotation({
  note,
  conversation,
  moved,
  answered,
  replying,
  replies,
  onReply,
  onDismiss,
}: {
  note: ReviewItem;
  conversation: ReadonlyArray<ReviewThreadEntry>;
  moved: boolean;
  answered: boolean;
  /** A reply box is open under the note. */
  replying: boolean;
  replies: ReactNode;
  onReply: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-review-note-id={note.id}
      className="font-sans text-foreground selection:bg-primary selection:text-primary-foreground"
      contentEditable={false}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex min-w-0 items-start gap-2 border-s-2 border-muted-foreground/40 bg-muted/50 px-3 py-2">
        {note.kind === "review_comment_thread" ? (
          <span className="mt-1 shrink-0 font-medium text-muted-foreground text-xs">You</span>
        ) : null}
        <ReviewItemText item={note} className="flex-1 py-0.5" />
        <div className="-my-0.5 -me-1 flex shrink-0 items-center gap-1">
          {moved ? (
            <Tooltip>
              <TooltipTrigger render={<Badge variant="outline" size="sm" />}>Moved</TooltipTrigger>
              <TooltipPopup side="top">
                {`${note.kind === "review_note" ? "Flagged" : "Commented"} at ${reviewNoteRangeLabel(note)} of an earlier version of this file`}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {answered ? (
            <Badge variant="success" size="sm">
              Answered
            </Badge>
          ) : null}
          {replying ? null : (
            <>
              <ReviewNoteIconAction label="Reply" onClick={onReply}>
                <ReplyIcon className="size-3" />
              </ReviewNoteIconAction>
              <ReviewNoteIconAction label="Dismiss" onClick={onDismiss}>
                <EyeOffIcon className="size-3" />
              </ReviewNoteIconAction>
            </>
          )}
        </div>
      </div>
      <ReviewConversation entries={conversation} />
      {replies}
    </div>
  );
}
