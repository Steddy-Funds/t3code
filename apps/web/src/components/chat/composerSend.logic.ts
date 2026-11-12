import type {
  EnvironmentId,
  PreviewAnnotationPayload,
  ThreadContextRecord,
} from "@t3tools/contracts";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import {
  collectInlineContextIds,
  ensureInlineContextReferences,
} from "../../lib/composerContextReferences";
import { reviewCommentContextReference } from "../../lib/composerContextRecords";
import type { ReviewCommentContext } from "../../reviewCommentContext";

/** A send started outside the composer. */
export type DirectComposerSend =
  /** The draft as it is, plus an annotation written to it in the same tick. */
  | {
      readonly kind: "preview-annotation";
      readonly annotation: PreviewAnnotationPayload;
      readonly image: ComposerImageAttachment | null;
    }
  /** One message holding these comments and nothing the composer holds. */
  | { readonly kind: "review-comments"; readonly comments: ReadonlyArray<ReviewCommentContext> };

/**
 * How a review send ended. The comments left the draft only when it was `dispatched` (started
 * a turn or went into the running one) or `queued` (waits behind the running turn).
 */
export type ReviewSendOutcome =
  | { readonly status: "dispatched" }
  | { readonly status: "queued" }
  /** The thread could not take a message; nothing was sent. */
  | { readonly status: "refused"; readonly reason: string }
  /** The message was sent and the server did not accept it. */
  | { readonly status: "failed"; readonly reason: string };

/** What a review send carries in place of the composer's draft. */
export function reviewSendContent(comments: ReadonlyArray<ReviewCommentContext>) {
  return {
    prompt: ensureInlineContextReferences("", comments.map(reviewCommentContextReference)),
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: comments,
    threadContexts: [],
    environmentContexts: [],
  };
}

/** Attached threads the prompt still links to; replacing linked text leaves stale records. */
export function referencedThreadContexts(draft: {
  readonly prompt: string;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
}): ReadonlyArray<ThreadContextRecord> {
  if (draft.threadContexts.length === 0) return [];
  const referenced = new Set(collectInlineContextIds(draft.prompt));
  return draft.threadContexts.filter((record) => referenced.has(record.contextId));
}

/** Why a send waits for the user to pick a machine when no machine was chosen automatically. */
export function loadBalancingSendWarning(input: {
  readonly pending: boolean;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly candidateEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) {
  if (input.pending) {
    return {
      title: "Checking machine resources",
      description: "Resource checks are still running. You can choose a machine in the composer.",
    };
  }
  const noMachineReadsEveryThread =
    input.threadContexts.length > 0 &&
    !input.candidateEnvironmentIds.some((environmentId) =>
      input.threadContexts.every((record) => record.environmentId === environmentId),
    );
  return {
    title: "Choose a machine to continue",
    description: noMachineReadsEveryThread
      ? "No machine can read every attached thread. Choose a machine in the composer or remove the threads."
      : "No eligible machine has available resources. Choose a machine in the composer to override.",
  };
}

/**
 * Why a multiple-model send cannot start: the server predates worktree bootstrap, or the
 * draft is not a new thread on a Git branch with at least one model.
 */
export function multipleModelSendBlock(input: {
  readonly selectionCount: number;
  readonly serverSupportsWorktreeBootstrap: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly branch: string | null;
}): "server-outdated" | "needs-new-git-thread" | null {
  if (!input.serverSupportsWorktreeBootstrap) return "server-outdated";
  if (
    !input.isLocalDraftThread ||
    !input.isGitRepo ||
    !input.branch ||
    input.selectionCount === 0
  ) {
    return "needs-new-git-thread";
  }
  return null;
}

/** Why a message sent over pending approvals did not go out, or null to stop quietly. */
export function approvalRedirectNotice(input: {
  readonly draftChanged: boolean;
  readonly declined: boolean;
  readonly approvalResponding: boolean;
  readonly approvalArrived: boolean;
}): string | null {
  if (input.draftChanged) {
    return input.declined
      ? "Approval declined. Your message changed, so it wasn't sent."
      : "Your message changed, so it wasn't sent.";
  }
  if (input.approvalResponding) {
    return "An approval is already being answered, so your message wasn't sent.";
  }
  if (input.declined && input.approvalArrived) {
    return "Another approval arrived, so your message wasn't sent.";
  }
  return null;
}
