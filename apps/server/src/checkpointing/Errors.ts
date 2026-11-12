import {
  NonNegativeInt,
  ThreadId,
  TurnDiffFileContentsUnavailableReason,
  type VcsError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";

export const CheckpointDiffOperation = Schema.Literals([
  "CheckpointDiffQuery.getTurnDiff",
  "CheckpointDiffQuery.getFullThreadDiff",
  "CheckpointDiffQuery.getTurnDiffFileContents",
]);
export type CheckpointDiffOperation = typeof CheckpointDiffOperation.Type;

const CHECKPOINT_DIFF_RESULT_LABELS: Record<CheckpointDiffOperation, string> = {
  "CheckpointDiffQuery.getTurnDiff": "turn diff",
  "CheckpointDiffQuery.getFullThreadDiff": "full thread diff",
  "CheckpointDiffQuery.getTurnDiffFileContents": "turn diff file contents",
};

export class CheckpointDiffResultInvalidError extends Schema.TaggedError<CheckpointDiffResultInvalidError>()(
  "CheckpointDiffResultInvalidError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    const result = CHECKPOINT_DIFF_RESULT_LABELS[this.operation];
    return `Checkpoint invariant violation in ${this.operation}: Computed ${result} result does not satisfy contract schema.`;
  }
}

export class CheckpointThreadNotFoundError extends Schema.TaggedError<CheckpointThreadNotFoundError>()(
  "CheckpointThreadNotFoundError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Checkpoint invariant violation in ${this.operation}: Thread '${this.threadId}' not found.`;
  }
}

export class CheckpointWorkspacePathMissingError extends Schema.TaggedError<CheckpointWorkspacePathMissingError>()(
  "CheckpointWorkspacePathMissingError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    const diff = CHECKPOINT_DIFF_RESULT_LABELS[this.operation];
    return `Checkpoint invariant violation in ${this.operation}: Workspace path missing for thread '${this.threadId}' when computing ${diff}.`;
  }
}

export class CheckpointTurnRangeUnavailableError extends Schema.TaggedError<CheckpointTurnRangeUnavailableError>()(
  "CheckpointTurnRangeUnavailableError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    requestedTurnCount: NonNegativeInt,
    availableTurnCount: NonNegativeInt,
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.requestedTurnCount}: Turn diff range exceeds current turn count: requested ${this.requestedTurnCount}, current ${this.availableTurnCount}.`;
  }
}

export class CheckpointRefUnavailableError extends Schema.TaggedError<CheckpointRefUnavailableError>()(
  "CheckpointRefUnavailableError",
  {
    operation: CheckpointDiffOperation,
    threadId: ThreadId,
    turnCount: NonNegativeInt,
    checkpoint: Schema.Literals(["from", "to"]),
  },
) {
  override get message(): string {
    return `Checkpoint unavailable for thread ${this.threadId} turn ${this.turnCount}: Checkpoint ref is unavailable for turn ${this.turnCount}.`;
  }
}

const TURN_DIFF_FILE_UNAVAILABLE_DETAILS: Record<TurnDiffFileContentsUnavailableReason, string> = {
  not_in_diff: "is not part of this turn's diff",
  too_large: "is larger than the 1 MB limit",
  binary: "is a binary file",
  unavailable: "is not a regular file",
};

/** The file cannot be shown whole. The path is the client's own input, so it is safe to echo. */
export class CheckpointFileContentsUnavailableError extends Schema.TaggedError<CheckpointFileContentsUnavailableError>()(
  "CheckpointFileContentsUnavailableError",
  {
    threadId: ThreadId,
    path: Schema.String,
    reason: TurnDiffFileContentsUnavailableReason,
  },
) {
  override get message(): string {
    return `'${this.path}' ${TURN_DIFF_FILE_UNAVAILABLE_DETAILS[this.reason]}.`;
  }
}

export type CheckpointStoreError = VcsError;

export type CheckpointServiceError =
  | CheckpointStoreError
  | ProjectionRepositoryError
  | CheckpointDiffResultInvalidError
  | CheckpointThreadNotFoundError
  | CheckpointWorkspacePathMissingError
  | CheckpointTurnRangeUnavailableError
  | CheckpointRefUnavailableError;
