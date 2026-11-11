import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";

/** A merged turn stays within what `t3_thread_send` accepts for one message. */
const MERGED_TURN_MAX_CHARS = 120_000;

export function isAutomaticCompletionRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

export function queuedRunsInDeliveryOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): ReadonlyArray<OrchestrationV2Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => {
      const deliveryPriority =
        Number(automaticCompletionMessageIds.has(right.userMessageId)) -
        Number(automaticCompletionMessageIds.has(left.userMessageId));
      return (
        deliveryPriority ||
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal
      );
    });
}

/** Plain text an agent sent, with nothing else depending on its run starting by itself. */
function isMergeableQueuedRun(
  run: OrchestrationV2Run,
  message: OrchestrationV2ConversationMessage,
): boolean {
  return (
    run.queueHeld !== true &&
    run.freshContext !== true &&
    run.delegatedTaskId === undefined &&
    run.delegatedCompletion === undefined &&
    run.sourcePlanRef === undefined &&
    run.restartContinuationOfRunId === undefined &&
    run.usageLimitContinuationOfRunId === undefined &&
    run.restartCancelledBackgroundWork === undefined &&
    run.workspacePreparation === undefined &&
    message.runId === run.id &&
    message.createdBy === "agent" &&
    message.creationSource === "mcp" &&
    message.attachments.length === 0 &&
    message.notification === undefined &&
    message.delegatedCompletion === undefined &&
    message.scheduledTaskId === undefined &&
    message.idleCompaction === undefined &&
    message.workflowScript !== true &&
    message.text.trim() !== "" &&
    !message.text.trimStart().startsWith("/")
  );
}

/**
 * The queued agent messages that start in `head`'s turn: the ones directly behind it in delivery
 * order. A person's message, a command or an automatic delivery ends the batch, so merging never
 * moves a message ahead of one queued before it.
 */
export function queuedRunsMergedInto(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages" | "turnItems">,
  head: OrchestrationV2Run,
): ReadonlyArray<{
  readonly run: OrchestrationV2Run;
  readonly message: OrchestrationV2ConversationMessage;
}> {
  const messages = new Map(projection.messages.map((message) => [message.id, message]));
  // Older versions gave a queued message its transcript row, and position, when it was queued.
  const positioned = new Set(
    projection.turnItems.flatMap((item) => (item.type === "user_message" ? [item.messageId] : [])),
  );
  const mergeable = (run: OrchestrationV2Run) => {
    const message = messages.get(run.userMessageId);
    return message !== undefined &&
      !positioned.has(message.id) &&
      isMergeableQueuedRun(run, message)
      ? message
      : undefined;
  };
  const headMessage = mergeable(head);
  const queue = queuedRunsInDeliveryOrder(projection);
  const headIndex = queue.findIndex((run) => run.id === head.id);
  if (headMessage === undefined || headIndex === -1) return [];
  const merged: Array<{ run: OrchestrationV2Run; message: OrchestrationV2ConversationMessage }> =
    [];
  let chars = headMessage.text.length;
  for (const run of queue.slice(headIndex + 1)) {
    const message = mergeable(run);
    if (message === undefined || !modelSelectionsEqual(run.modelSelection, head.modelSelection)) {
      break;
    }
    chars += message.text.length;
    if (chars > MERGED_TURN_MAX_CHARS) break;
    merged.push({ run, message });
  }
  return merged;
}

/** The prompt for a turn that delivers several queued messages at once. */
export function mergedTurnText(texts: ReadonlyArray<string>): string {
  if (texts.length <= 1) return texts[0] ?? "";
  return [
    `${texts.length} messages were waiting for you. Read them all before you act; they are in the order they were sent.`,
    ...texts.map((text, index) => `[Message ${index + 1} of ${texts.length}]\n${text}`),
  ].join("\n\n");
}
