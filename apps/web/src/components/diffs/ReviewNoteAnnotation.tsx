import { type ReviewNote, reviewNoteRangeLabel } from "@t3tools/shared/reviewNote";
import { EyeOffIcon, ReplyIcon } from "lucide-react";
import type { ReactNode } from "react";

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

/** An agent's review note at the lines it flagged, with its replies below it. */
export function ReviewNoteAnnotation({
  note,
  moved,
  answered,
  replying,
  replies,
  onReply,
  onDismiss,
}: {
  note: ReviewNote;
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
        <ReviewNoteText note={note} className="flex-1 py-0.5" />
        <div className="-my-0.5 -me-1 flex shrink-0 items-center gap-1">
          {moved ? (
            <Tooltip>
              <TooltipTrigger render={<Badge variant="outline" size="sm" />}>Moved</TooltipTrigger>
              <TooltipPopup side="top">
                {`Flagged at ${reviewNoteRangeLabel(note)} of an earlier version of this file`}
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
      {replies}
    </div>
  );
}
