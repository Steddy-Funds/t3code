import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Struct from "effect/Struct";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue({
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

/** Git paths are bounded by the platform, not by Git; this is far above any real one. */
const TurnDiffFilePath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));

export const OrchestrationGetTurnDiffFileContentsInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    /** Repository-relative, as the turn diff names the file. */
    path: TurnDiffFilePath,
    /** The path before a rename, as the turn diff names it. */
    previousPath: Schema.optionalKey(TurnDiffFilePath),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffFileContentsInput =
  typeof OrchestrationGetTurnDiffFileContentsInput.Type;

/** A side the file does not exist on (added or deleted in the range) is the empty string. */
export const OrchestrationGetTurnDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type OrchestrationGetTurnDiffFileContentsResult =
  typeof OrchestrationGetTurnDiffFileContentsResult.Type;

export const TurnDiffFileContentsUnavailableReason = Schema.Literals([
  "not_in_diff",
  "too_large",
  "binary",
  "unavailable",
]);
export type TurnDiffFileContentsUnavailableReason =
  typeof TurnDiffFileContentsUnavailableReason.Type;

export class OrchestrationGetTurnDiffFileContentsError extends Schema.TaggedError<OrchestrationGetTurnDiffFileContentsError>()(
  "OrchestrationGetTurnDiffFileContentsError",
  {
    message: TrimmedNonEmptyString,
    reason: TurnDiffFileContentsUnavailableReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetTurnDiffError extends Schema.TaggedError<OrchestrationGetTurnDiffError>()(
  "OrchestrationGetTurnDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export class OrchestrationGetFullThreadDiffError extends Schema.TaggedError<OrchestrationGetFullThreadDiffError>()(
  "OrchestrationGetFullThreadDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
