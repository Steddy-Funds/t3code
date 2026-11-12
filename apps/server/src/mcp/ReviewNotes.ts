// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  OrchestratorMcpFailure,
  REVIEW_NOTE_MAX_LINES,
  REVIEW_NOTE_TURN_ITEM_PREFIX,
  TurnItemId,
  type OrchestratorMcpFlagForReviewInput,
  type OrchestratorMcpFlagForReviewResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const MAX_EXCERPT_LINES = 40;
const MAX_EXCERPT_CHARS = 4_000;
/** The wire passes a `dynamic_tool` input whole up to 16 KiB; a note stays well under it. */
export const REVIEW_NOTE_MAX_INPUT_BYTES = 12_288;

export const REVIEW_NOTES_OFF = "Review notes are off on this machine.";

export class ReviewNotes extends Context.Service<
  ReviewNotes,
  {
    readonly flag: (
      scope: McpInvocationContext.McpInvocationScope,
      input: OrchestratorMcpFlagForReviewInput,
    ) => Effect.Effect<OrchestratorMcpFlagForReviewResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ReviewNotes") {}

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/** Git's blob id, so a client can match it against the `index` line of a diff. */
const gitBlobId = (contents: string) => {
  const bytes = Buffer.from(contents, "utf8");
  return NodeCrypto.createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
};

/** The lines as they were, cut to whole lines; a single over-long line is cut inside. */
const excerptOf = (lines: ReadonlyArray<string>, fits: (excerpt: string) => boolean) => {
  let count = Math.min(lines.length, MAX_EXCERPT_LINES);
  const joined = (n: number) => lines.slice(0, n).join("\n");
  while (count > 1 && (joined(count).length > MAX_EXCERPT_CHARS || !fits(joined(count)))) {
    count -= 1;
  }
  let excerpt = joined(count);
  if (excerpt.length > MAX_EXCERPT_CHARS || !fits(excerpt)) {
    excerpt = Array.from(excerpt).slice(0, MAX_EXCERPT_CHARS).join("");
    while (excerpt.length > 0 && !fits(excerpt)) excerpt = excerpt.slice(0, -256);
  }
  return { excerpt, excerptTruncated: excerpt !== lines.join("\n") };
};

/** The same note on the same lines of a thread is one note, whichever turn sends it again. */
const noteIdFor = (
  threadId: string,
  relativePath: string,
  input: OrchestratorMcpFlagForReviewInput,
) =>
  TurnItemId.make(
    `${REVIEW_NOTE_TURN_ITEM_PREFIX}${encodeURIComponent(threadId)}:${NodeCrypto.createHash(
      "sha256",
    )
      .update(
        JSON.stringify([
          relativePath,
          input.startLine,
          input.endLine,
          input.note,
          input.question ?? null,
        ]),
      )
      .digest("hex")
      .slice(0, 32)}`,
  );

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;

  const flag: ReviewNotes["Service"]["flag"] = Effect.fn("ReviewNotes.flag")(
    function* (scope, input) {
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "flag_for_review");
      const enabled = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.agentReviewNotesEnabled),
        Effect.orElseSucceed(() => true),
      );
      if (!enabled) return yield* failure("capability_denied", REVIEW_NOTES_OFF);
      if (input.endLine < input.startLine) {
        return yield* failure("invalid_request", "endLine is before startLine.");
      }
      if (input.endLine - input.startLine + 1 > REVIEW_NOTE_MAX_LINES) {
        return yield* failure(
          "invalid_request",
          `A note covers at most ${REVIEW_NOTE_MAX_LINES} lines. Flag the lines that matter.`,
        );
      }
      const threadId = caller.thread.threadId;
      const unreadable = (error: { readonly message: string }) =>
        failure("orchestration_error", `Unable to read this thread: ${error.message}`);
      const parent = yield* threadManagement
        .getThreadRecords(threadId, ["runs"], { messageRoles: [] })
        .pipe(Effect.mapError(unreadable));
      const run = ThreadManagementService.latestActiveRun(parent);
      if (
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== caller.thread.providerInstanceId
      ) {
        return yield* failure(
          "parent_not_active",
          "Flagging for review needs an active run owned by this MCP provider session.",
        );
      }
      const workspaceRoot =
        parent.thread.worktreePath ??
        (yield* projects.getById(parent.thread.projectId).pipe(
          Effect.mapError(unreadable),
          Effect.map(Option.map((project) => project.workspaceRoot)),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(failure("invalid_request", "This thread has no workspace.")),
              onSome: Effect.succeed,
            }),
          ),
        ));
      const outside = failure(
        "invalid_request",
        `${input.path} is outside this thread's workspace. Pass a workspace-relative path.`,
      );
      // `readFile` reads any absolute host path; only a relative one is held inside the root.
      const relativePath = path.isAbsolute(input.path)
        ? path.relative(workspaceRoot, input.path)
        : input.path;
      if (
        relativePath.length === 0 ||
        relativePath.startsWith("~") ||
        path.isAbsolute(relativePath) ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`)
      ) {
        return yield* outside;
      }
      const file = yield* files.readFile({ cwd: workspaceRoot, relativePath }).pipe(
        Effect.catchTags({
          WorkspacePathOutsideRootError: () => Effect.fail(outside),
          WorkspaceFilePathEscapeError: () => Effect.fail(outside),
          WorkspaceBinaryFileError: () =>
            Effect.fail(failure("invalid_request", `${input.path} is a binary file.`)),
          WorkspacePathNotFileError: () =>
            Effect.fail(failure("invalid_request", `${input.path} is not a file.`)),
          WorkspaceFileSystemOperationError: (error) =>
            Effect.fail(
              (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
                ? failure("invalid_request", `There is no file at ${input.path}.`)
                : failure("orchestration_error", `Unable to read ${input.path}.`),
            ),
        }),
      );
      if (file.exists === false) {
        return yield* failure("invalid_request", `There is no file at ${input.path}.`);
      }
      if (file.truncated) {
        return yield* failure(
          "invalid_request",
          `${input.path} is too large to flag (over 1 MiB).`,
        );
      }
      const lines = file.contents.split("\n");
      if (lines.at(-1) === "") lines.pop();
      if (input.endLine > lines.length) {
        return yield* failure(
          "invalid_request",
          `${input.path} has ${lines.length} lines; lines ${input.startLine}-${input.endLine} are past its end.`,
        );
      }
      const fields = {
        path: file.relativePath,
        startLine: input.startLine,
        endLine: input.endLine,
        note: input.note,
        ...(input.question === undefined ? {} : { question: input.question }),
        contentRevision: gitBlobId(file.contents),
      };
      const { excerpt, excerptTruncated } = excerptOf(
        lines.slice(input.startLine - 1, input.endLine).map((line) => line.replace(/\r$/u, "")),
        (candidate) =>
          Buffer.byteLength(
            JSON.stringify({
              kind: "review_note",
              ...fields,
              excerpt: candidate,
              excerptTruncated: true,
              runId: run.id,
            }),
            "utf8",
          ) <= REVIEW_NOTE_MAX_INPUT_BYTES,
      );
      const noteId = noteIdFor(threadId, file.relativePath, input);
      yield* threadManagement
        .dispatch({
          type: "review_note.record",
          commandId: CommandId.make(`command:review-note:${noteId}`),
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          turnItemId: noteId,
          note: { ...fields, excerpt, excerptTruncated },
        })
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Could not record the note: ${error.message}`),
          ),
        );
      return { status: "recorded" as const, noteId };
    },
  );

  return ReviewNotes.of({ flag });
});

export const layer = Layer.effect(ReviewNotes, make);
