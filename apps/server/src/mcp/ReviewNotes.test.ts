import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2TurnItem,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  REVIEW_NOTE_TOOL_NAME,
  REVIEW_NOTE_TURN_ITEM_PREFIX,
  REVIEW_REPLY_TOOL_NAME,
  REVIEW_REPLY_TURN_ITEM_PREFIX,
  ComposerContextId,
  type ReviewCommentContextRecord,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { McpSchema, McpServer } from "effect/ai";
import {
  reviewNoteFromToolItem,
  reviewNoteSectionId,
  reviewReplyFromToolItem,
} from "@t3tools/shared/reviewNote";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { projectTurnItemForWire } from "../orchestration-v2/WireProjection.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ReviewNotes from "./ReviewNotes.ts";

// The agent's flag_for_review call, through the real orchestrator toolkit,
// orchestrator, projections and workspace reads, on a real directory.

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const threadId = ThreadId.make("thread:review-notes");
const projectId = ProjectId.make("project:review-notes");
const runId = RunId.make("run:review-notes");
const rootNode = NodeId.make("node:review-notes:root");
const FILE = "src/billing.ts";
const FILE_TEXT = "one\ntwo\nthree\nfour\nfive\n";
/** `git hash-object` of FILE_TEXT. */
const FILE_BLOB = "b2f931a67315c95c5daab3aac6de62e534808476";
/** `git hash-object` of "one\n" after a UTF-8 byte order mark. */
const BOM_FILE_BLOB = "6a26b6375b2a756aff344c99b4dac1b52a6a2599";

const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "review-notes", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "review-notes", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const caller: McpInvocationContext.McpThreadCaller = {
  threadId,
  providerSessionId: "provider-session:review-notes",
  providerInstanceId: instanceId,
};
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:review-notes"),
  requestNamespace: "provider-session:review-notes",
  thread: caller,
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

type Note = Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>;

const makeHarness = (settings: Parameters<typeof ServerSettings.layerTest>[0] = {}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-review-notes-" });
    const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-review-outside-" });
    const write = (root: string, relativePath: string, contents: string) =>
      fileSystem
        .makeDirectory(path.dirname(path.join(root, relativePath)), { recursive: true })
        .pipe(
          Effect.andThen(fileSystem.writeFileString(path.join(root, relativePath), contents)),
          Effect.orDie,
        );
    yield* write(workspace, FILE, FILE_TEXT);

    const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
    const layerDatabase = Layer.succeedContext(database);
    const layerOrchestrator = Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "review-notes" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ).pipe(
      Layer.provide(
        Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
          offer: () => Effect.void,
          take: Effect.never,
        }),
      ),
    );
    const layerThreads = ThreadManagement.layer.pipe(
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
      Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest(settings))),
    );
    const project = { id: projectId, workspaceRoot: workspace } as Project;
    const layerHere = McpHttpServer.layerOrchestratorToolkit.pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provide(ReviewNotes.layer),
      Layer.provide(
        WorkspaceFileSystem.layer.pipe(
          Layer.provide(
            Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: () => Effect.void }),
          ),
          Layer.provide(Layer.mock(WorkspaceEntries.WorkspaceEntries)({})),
          Layer.provide(WorkspacePaths.layer),
        ),
      ),
      Layer.provide(
        Layer.merge(
          Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
          Layer.mock(PeerForwarding.PeerForwarding)({}),
        ),
      ),
      Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
      Layer.provide(NodeCrypto.layer),
      Layer.provideMerge(layerThreads),
      Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
        }),
      ),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-notes-config-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provide(NodeServices.layer),
      Layer.fresh,
    );
    const here = yield* Layer.build(layerHere);
    const server = Context.get(here, McpServer.McpServer);
    const orchestrator = Context.get(here, Orchestrator.OrchestratorV2);
    const sink = Context.get(here, EventSink.EventSinkV2);

    // A run on a thread: mid-turn when its agent calls, or completed so a fork can start from it.
    const now = yield* DateTime.now;
    const seedRun = (
      on: { readonly threadId: ThreadId; readonly runId: RunId; readonly rootNode: NodeId },
      status: "running" | "completed",
      ordinal = 1,
    ) =>
      Effect.gen(function* () {
        const providerThreadId = ProviderThreadId.make(`provider-thread:${on.threadId}`);
        const completedAt = status === "completed" ? now : null;
        yield* sink.write({
          commandId: CommandId.make(`command:seed:${on.runId}:${status}`),
          events: [
            {
              id: EventId.make(`event:seed-node:${on.runId}:${status}`),
              type: "node.updated",
              threadId: on.threadId,
              runId: on.runId,
              nodeId: on.rootNode,
              driver,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: on.rootNode,
                threadId: on.threadId,
                runId: on.runId,
                parentNodeId: null,
                rootNodeId: on.rootNode,
                kind: "root_turn",
                status,
                countsForRun: true,
                providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt,
              },
            },
            {
              id: EventId.make(`event:seed-run:${on.runId}:${status}`),
              type: "run.updated",
              threadId: on.threadId,
              runId: on.runId,
              nodeId: on.rootNode,
              providerInstanceId: instanceId,
              occurredAt: now,
              payload: {
                id: on.runId,
                threadId: on.threadId,
                ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId,
                userMessageId: MessageId.make(`message:seed-user:${on.runId}`),
                rootNodeId: on.rootNode,
                activeAttemptId: null,
                status,
                requestedAt: now,
                startedAt: now,
                completedAt,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
          ],
        });
      });
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:create:review-notes"),
      threadId,
      projectId,
      title: "Review notes",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* seedRun({ threadId, runId, rootNode }, "running");

    const notesOf = (of: ThreadId) =>
      orchestrator
        .getThreadProjection(of)
        .pipe(
          Effect.map((projection) =>
            projection.turnItems.filter(
              (item): item is Note =>
                item.type === "dynamic_tool" && item.toolName === REVIEW_NOTE_TOOL_NAME,
            ),
          ),
        );
    const callAs =
      (name: string) =>
      (caller: McpInvocationContext.McpInvocationScope) =>
      (args: Record<string, unknown>) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
            Effect.provideService(McpSchema.McpServerClient, mcpClient),
          );
    const flagAs = callAs(REVIEW_NOTE_TOOL_NAME);
    // The user's message on the run, carrying review comments as the composer sends them.
    const sendComments = (
      records: ReadonlyArray<ReviewCommentContextRecord>,
      on: { readonly runId: RunId; readonly rootNode: NodeId } = { runId, rootNode },
    ) =>
      sink.write({
        commandId: CommandId.make(`command:seed:comments:${on.runId}:${records.length}`),
        events: [
          {
            id: EventId.make(`event:seed-comments:${on.runId}:${records.length}`),
            type: "message.updated",
            threadId,
            runId: on.runId,
            occurredAt: now,
            payload: {
              id: MessageId.make(`message:seed-user:${on.runId}`),
              threadId,
              runId: on.runId,
              nodeId: on.rootNode,
              role: "user",
              text: "Review comments",
              context: { version: 1, records },
              attachments: [],
              streaming: false,
              createdBy: "user",
              creationSource: "web",
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
    const replies = orchestrator
      .getThreadProjection(threadId)
      .pipe(
        Effect.map((projection) =>
          projection.turnItems.flatMap((item) => reviewReplyFromToolItem(item) ?? []),
        ),
      );
    return {
      workspace,
      outside,
      path,
      orchestrator,
      notes: notesOf(threadId),
      notesOf,
      seedRun,
      flagAs,
      sendComments,
      replies,
      replyAs: callAs(REVIEW_REPLY_TOOL_NAME),
      reply: callAs(REVIEW_REPLY_TOOL_NAME)(scope),
      write,
      symlink: (target: string, link: string) =>
        fileSystem.symlink(target, link).pipe(Effect.orDie),
      flag: flagAs(scope),
    };
  });

const errorOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const noteIdOf = (result: McpSchema.CallToolResult) => {
  expect(errorOf(result)).toBeUndefined();
  return (result.structuredContent as { readonly noteId: TurnItemId }).noteId;
};

describe("flag_for_review", () => {
  it.effect("records one note on the thread, with its excerpt and the file's blob id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* makeHarness();
        const args = {
          path: FILE,
          startLine: 2,
          endLine: 3,
          note: "Charges now retry.",
          question: "Retry charges too?",
        };
        const noteId = noteIdOf(yield* a.flag(args));
        expect(noteId.startsWith(REVIEW_NOTE_TURN_ITEM_PREFIX)).toBe(true);
        expect(yield* a.notes).toEqual([
          expect.objectContaining({
            id: noteId,
            runId,
            nodeId: rootNode,
            nativeItemRef: null,
            status: "completed",
            input: {
              kind: "review_note",
              path: FILE,
              startLine: 2,
              endLine: 3,
              note: args.note,
              question: args.question,
              excerpt: "two\nthree",
              excerptTruncated: false,
              contentRevision: FILE_BLOB,
              runId,
            },
          }),
        ]);

        // A retry, by absolute path, is the same note; so is a second record of it.
        const absolute = { ...args, path: a.path.join(a.workspace, FILE) };
        expect(noteIdOf(yield* a.flag(absolute))).toBe(noteId);
        yield* a.orchestrator.dispatch({
          type: "review_note.record",
          commandId: CommandId.make("command:review-note:again"),
          threadId,
          runId,
          nodeId: rootNode,
          turnItemId: noteId,
          note: {
            path: FILE,
            startLine: 2,
            endLine: 3,
            note: "Something else.",
            excerpt: "",
            excerptTruncated: false,
            contentRevision: FILE_BLOB,
          },
        });
        expect((yield* a.notes).map((note) => note.input)).toEqual([
          expect.objectContaining({ note: args.note }),
        ]);

        // A note stored before the thread joined the hash, under the id it got then, is the same
        // note when the agent sends it again.
        const before = { path: FILE, startLine: 4, endLine: 4, note: "Refunds retry too." };
        const beforeId = TurnItemId.make(
          `${REVIEW_NOTE_TURN_ITEM_PREFIX}${encodeURIComponent(threadId)}:ffef5a3fa384e56f44a29f109188b61e`,
        );
        yield* a.orchestrator.dispatch({
          type: "review_note.record",
          commandId: CommandId.make("command:review-note:before"),
          threadId,
          runId,
          nodeId: rootNode,
          turnItemId: beforeId,
          note: {
            ...before,
            excerpt: "four",
            excerptTruncated: false,
            contentRevision: FILE_BLOB,
          },
        });
        expect(noteIdOf(yield* a.flag(before))).toBe(beforeId);
        expect((yield* a.notes).map((note) => note.id)).toEqual([noteId, beforeId]);

        // The blob id is of the file's bytes, a byte order mark included.
        yield* a.write(a.workspace, "src/bom.ts", "\uFEFFone\n");
        const bom = { ...args, path: "src/bom.ts", startLine: 1, endLine: 1 };
        const bomNoteId = noteIdOf(yield* a.flag(bom));
        expect((yield* a.notes).find((note) => note.id === bomNoteId)?.input).toMatchObject({
          excerpt: "one",
          contentRevision: BOM_FILE_BLOB,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the largest note whole on the wire", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* makeHarness();
        // Characters JSON escapes or UTF-8 widens, at every limit the tool takes.
        const line = '"é✓\\'.repeat(25);
        yield* a.write(a.workspace, "src/wide.ts", `${Array(60).fill(line).join("\n")}\n`);
        noteIdOf(
          yield* a.flag({
            path: "src/wide.ts",
            startLine: 1,
            endLine: 60,
            note: '"'.repeat(600),
            question: "\u0001".repeat(300),
          }),
        );
        const [note] = yield* a.notes;
        const input = note!.input as { readonly excerpt: string; readonly excerptTruncated: true };
        expect(input.excerptTruncated).toBe(true);
        expect(input.excerpt.split("\n").length).toBeLessThanOrEqual(40);
        expect(input.excerpt.length).toBeLessThanOrEqual(4_000);
        expect(`${Array(60).fill(line).join("\n")}`.startsWith(`${input.excerpt}`)).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeLessThanOrEqual(
          ReviewNotes.REVIEW_NOTE_MAX_INPUT_BYTES,
        );
        expect(projectTurnItemForWire(note!)).toMatchObject({ input });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses lines it cannot read from this workspace, and records nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* makeHarness();
        yield* a.write(a.outside, "secret.ts", "token\n");
        yield* a.write(a.workspace, "src/logo.bin", "GIF\u0000\n");
        yield* a.symlink(a.path.join(a.outside, "secret.ts"), a.path.join(a.workspace, "link.ts"));
        const outside = /outside this thread's workspace/;
        const secret = a.path.join(a.outside, "secret.ts");
        const refusals: ReadonlyArray<readonly [Record<string, unknown>, RegExp]> = [
          [{ path: secret }, outside],
          // The reader trims a path, and reads an absolute one anywhere on the host.
          [{ path: ` ${secret}` }, outside],
          [{ path: `${a.path.join(a.workspace, " ")}${secret}` }, outside],
          [{ path: " ~/secret.ts" }, outside],
          [{ path: "../secret.ts" }, outside],
          [{ path: "~/secret.ts" }, outside],
          [{ path: "link.ts" }, outside],
          [{ path: "src/missing.ts" }, /There is no file at src\/missing.ts/],
          [{ path: "src" }, /src is not a file/],
          [{ path: "src/logo.bin" }, /src\/logo.bin is a binary file/],
          [{ startLine: 4, endLine: 9 }, /has 5 lines; lines 4-9 are past its end/],
          [{ startLine: 1, endLine: 201 }, /at most 200 lines/],
          [{ startLine: 3, endLine: 2 }, /endLine is before startLine/],
        ];
        for (const [override, message] of refusals) {
          const refused = yield* a.flag({
            path: FILE,
            startLine: 1,
            endLine: 1,
            note: "A note.",
            ...override,
          });
          expect(errorOf(refused), JSON.stringify(override)).toMatchObject({
            code: "invalid_request",
            message: expect.stringMatching(message),
          });
        }
        expect(yield* a.notes).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("gives a fork's note its own id and reply section, beside its source's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* makeHarness();
        const args = { path: FILE, startLine: 2, endLine: 3, note: "Charges now retry." };
        const sourceNoteId = noteIdOf(yield* a.flag(args));

        // The fork copies no rows: it starts from the source's completed run. (`latest_stable`
        // needs a checkpoint the seeded run has none of.)
        const forkId = ThreadId.make("thread:review-notes:fork");
        const fork = {
          threadId: forkId,
          runId: RunId.make("run:fork"),
          rootNode: NodeId.make("node:fork"),
        };
        yield* a.seedRun({ threadId, runId, rootNode }, "completed");
        yield* a.orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("command:fork:review-notes"),
          sourceThreadId: threadId,
          targetThreadId: forkId,
          sourcePoint: { type: "run", runId },
          createdBy: "user",
          creationSource: "web",
        });
        yield* a.seedRun(fork, "running");

        const visibleNotes = (of: ThreadId) =>
          a.orchestrator.getThreadProjection(of).pipe(
            Effect.map((projection) =>
              projection.visibleTurnItems.flatMap((row) => {
                const note = reviewNoteFromToolItem(row.item);
                return note === undefined ? [] : [{ note, row }];
              }),
            ),
          );
        expect(yield* visibleNotes(forkId)).toEqual([
          expect.objectContaining({
            row: expect.objectContaining({
              visibility: "inherited",
              sourceThreadId: threadId,
              sourceItemId: sourceNoteId,
            }),
          }),
        ]);

        // The fork's agent flags the same note on the same lines.
        const forkNoteId = noteIdOf(
          yield* a.flagAs({ ...scope, thread: { ...caller, threadId: forkId } })(args),
        );
        expect(forkNoteId).not.toBe(sourceNoteId);
        expect(
          forkNoteId.startsWith(`${REVIEW_NOTE_TURN_ITEM_PREFIX}${encodeURIComponent(forkId)}:`),
        ).toBe(true);
        expect(reviewNoteSectionId(forkNoteId)).not.toBe(reviewNoteSectionId(sourceNoteId));

        expect((yield* visibleNotes(forkId)).map(({ note }) => note.id)).toEqual([
          sourceNoteId,
          forkNoteId,
        ]);

        // The source gains nothing from the fork.
        expect((yield* a.notesOf(threadId)).map((note) => note.id)).toEqual([sourceNoteId]);
        expect((yield* a.notesOf(forkId)).map((note) => note.id)).toEqual([forkNoteId]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses while review notes are off on this machine", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* makeHarness({ agentReviewNotesEnabled: false });
        const refused = yield* a.flag({ path: FILE, startLine: 1, endLine: 1, note: "A note." });
        expect(errorOf(refused)).toMatchObject({
          code: "capability_denied",
          message: ReviewNotes.REVIEW_NOTES_OFF,
        });
        expect(yield* a.notes).toEqual([]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("reply_to_review_comment", () => {
  const record = (
    contextId: string,
    overrides: Partial<ReviewCommentContextRecord> = {},
  ): ReviewCommentContextRecord => ({
    version: 1,
    contextId: ComposerContextId.make(contextId),
    kind: "review-comment",
    label: "Comment",
    sectionId: "turn:1",
    sectionTitle: "Turn 1",
    filePath: FILE,
    startIndex: 1,
    endIndex: 2,
    rangeLabel: "L2 to L3",
    text: "Why retry here?",
    diff: "@@ -2,2 +2,2 @@\n two\n+three",
    ...overrides,
  });
  const replyIdOf = (result: McpSchema.CallToolResult) => {
    expect(errorOf(result)).toBeUndefined();
    return (result.structuredContent as { readonly replyId: TurnItemId }).replyId;
  };

  it.effect("records the reply with its own copy of the comment it answers, once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* makeHarness();
        yield* a.sendComments([record("ctx_1"), record("ctx_2", { text: "And here?" })]);
        const args = { commentId: "ctx_2", reply: "Kept it: the sandbox flakes." };
        const replyId = replyIdOf(yield* a.reply(args));
        expect(replyId.startsWith(REVIEW_REPLY_TURN_ITEM_PREFIX)).toBe(true);
        expect(replyIdOf(yield* a.reply(args))).toBe(replyId);
        expect(yield* a.replies).toEqual([
          {
            id: replyId,
            kind: "review_reply",
            commentId: "ctx_2",
            reply: args.reply,
            comment: {
              sectionId: "turn:1",
              filePath: FILE,
              rangeLabel: "L2 to L3",
              startIndex: 1,
              endIndex: 2,
              text: "And here?",
              diff: "@@ -2,2 +2,2 @@\n two\n+three",
            },
            runId,
          },
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("cuts a long comment's copy to whole lines that fit the wire", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* makeHarness();
        const diff = ["@@ -1,60 +1,60 @@", ...Array(60).fill(`+${'"é'.repeat(100)}`)].join("\n");
        // Long enough that the comment as sent would not fit beside any of its code.
        yield* a.sendComments([record("ctx_long", { text: "x".repeat(12_000), diff })]);
        replyIdOf(yield* a.reply({ commentId: "ctx_long", reply: '"'.repeat(2_000) }));
        const [reply] = yield* a.replies;
        expect(reply!.comment.text.length).toBeLessThanOrEqual(600);
        // Fewer lines than the excerpt cap: the bytes cut it, not the line count.
        const kept = reply!.comment.diff.split("\n").length;
        expect(kept).toBeGreaterThan(1);
        expect(kept).toBeLessThan(40);
        expect(diff.startsWith(reply!.comment.diff)).toBe(true);
        expect(diff.split("\n")).toContain(reply!.comment.diff.split("\n").at(-1));
        const { id: _id, ...input } = reply!;
        expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeLessThanOrEqual(
          ReviewNotes.REVIEW_NOTE_MAX_INPUT_BYTES,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("finds the active run's comment when 20 later runs exist", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const a = yield* makeHarness();
        yield* a.sendComments([record("ctx_1")]);
        for (let ordinal = 2; ordinal <= 21; ordinal++) {
          yield* a.seedRun(
            {
              threadId,
              runId: RunId.make(`run:later:${ordinal}`),
              rootNode: NodeId.make(`node:later:${ordinal}`),
            },
            "completed",
            ordinal,
          );
        }
        replyIdOf(yield* a.reply({ commentId: "ctx_1", reply: "Done." }));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "refuses a comment it cannot find, an inactive caller, and while review notes are off",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const a = yield* makeHarness();
          yield* a.sendComments([record("ctx_1")]);
          expect(errorOf(yield* a.reply({ commentId: "ctx_9", reply: "Done." }))).toMatchObject({
            code: "invalid_request",
            message: expect.stringMatching(/No review comment ctx_9/),
          });
          expect(yield* a.replies).toEqual([]);

          // Escaped, this reply and path pass the wire's bound with no code at all.
          yield* a.sendComments([
            record("ctx_1"),
            record("ctx_wide", { filePath: "é".repeat(2_000) }),
          ]);
          expect(
            errorOf(yield* a.reply({ commentId: "ctx_wide", reply: "\u0001".repeat(2_000) })),
          ).toMatchObject({ code: "invalid_request", message: expect.stringMatching(/too long/) });
          expect(yield* a.replies).toEqual([]);

          const otherAgent = {
            ...scope,
            thread: { ...caller, providerInstanceId: ProviderInstanceId.make("claude") },
          };
          expect(
            errorOf(yield* a.replyAs(otherAgent)({ commentId: "ctx_1", reply: "Done." })),
          ).toMatchObject({ code: "parent_not_active" });
          yield* a.seedRun({ threadId, runId, rootNode }, "completed");
          expect(errorOf(yield* a.reply({ commentId: "ctx_1", reply: "Done." }))).toMatchObject({
            code: "parent_not_active",
          });
          expect(yield* a.replies).toEqual([]);

          const off = yield* makeHarness({ agentReviewNotesEnabled: false });
          yield* off.sendComments([record("ctx_1")]);
          expect(errorOf(yield* off.reply({ commentId: "ctx_1", reply: "Done." }))).toMatchObject({
            code: "capability_denied",
            message: ReviewNotes.REVIEW_NOTES_OFF,
          });
          expect(yield* off.replies).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
