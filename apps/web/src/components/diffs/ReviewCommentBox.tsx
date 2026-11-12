import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { DiffCommentAnnotation } from "./DiffCommentAnnotation";
import type { ReviewCommentAnnotation, ReviewCommentDrafts } from "./useReviewCommentDrafts";

/**
 * One annotation of `useReviewCommentDrafts`: the open box with Send and Add to message, or a
 * saved comment that can be removed. Review surfaces share it so they act the same.
 */
export function ReviewCommentBox<TRange>({
  environmentId,
  projectId,
  ownerKey,
  annotation,
  drafts,
  onDismiss,
}: {
  /** With an environment, the draft can be dictated; its project supplies vocabulary. */
  environmentId?: EnvironmentId | undefined;
  projectId?: ProjectId | null | undefined;
  ownerKey: string;
  annotation: ReviewCommentAnnotation<TRange>;
  drafts: Pick<
    ReviewCommentDrafts<TRange>,
    "setDraftText" | "addToMessage" | "sendNow" | "cancel" | "removeComment"
  >;
  /** The box closed or the comment went: drop what the surface kept for it, like a selection. */
  onDismiss?: () => void;
}) {
  if (annotation.kind === "comment") {
    const remove = () => {
      onDismiss?.();
      drafts.removeComment(annotation.id);
    };
    return (
      <DiffCommentAnnotation
        kind="comment"
        rangeLabel={annotation.comment.rangeLabel}
        text={annotation.comment.text}
        onCancel={remove}
        onComment={() => {}}
        onDelete={remove}
      />
    );
  }

  const addToMessage = (text: string) => {
    onDismiss?.();
    drafts.addToMessage(text);
  };
  const sendNow = drafts.sendNow;
  return (
    <DiffCommentAnnotation
      environmentId={environmentId}
      projectId={projectId}
      ownerKey={ownerKey}
      kind="draft"
      rangeLabel={annotation.rangeLabel}
      text={annotation.text}
      quote={annotation.selectedText}
      pending={annotation.sending}
      onTextChange={drafts.setDraftText}
      onCancel={() => {
        onDismiss?.();
        drafts.cancel();
      }}
      {...(sendNow
        ? {
            submitLabel: "Send",
            onComment: (text: string) => {
              onDismiss?.();
              void sendNow(text);
            },
            secondaryAction: { label: "Add to message", shiftEnter: true, onAction: addToMessage },
          }
        : { onComment: addToMessage })}
    />
  );
}
