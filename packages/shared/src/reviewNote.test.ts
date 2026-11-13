import {
  ComposerContextId,
  REVIEW_NOTE_TOOL_NAME,
  REVIEW_REPLY_TOOL_NAME,
  RunId,
  TurnItemId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  answeredReviewNoteIds,
  buildReviewThreads,
  type ReviewNote,
  reviewNoteFromToolItem,
  reviewNoteSectionId,
  reviewReplyFromToolItem,
  reviewThreadSectionId,
  type ReviewTimelineEntry,
} from "./reviewNote.ts";

type AnsweringMessage =
  Parameters<typeof answeredReviewNoteIds>[1] extends Iterable<infer M> ? M : never;

const noteId = TurnItemId.make("turn-item:review-note:thread-1:5f2c0a9e");
const input = {
  kind: "review_note",
  path: "server/src/orders/repository.ts",
  startLine: 7,
  endLine: 8,
  note: "Export and refunds now skip soft-deleted items.",
  excerpt: "  const items = await sql`\n    SELECT * FROM order_items WHERE deleted_at IS NULL`;",
  excerptTruncated: false,
  contentRevision: "17387d5c0d9a4b1e2f3a4b5c6d7e8f9a0b1c2d3e",
  runId: "run-1",
};
const serverRow = {
  id: noteId,
  type: "dynamic_tool",
  toolName: REVIEW_NOTE_TOOL_NAME,
  nativeItemRef: null,
  input,
};

describe("reviewNoteFromToolItem", () => {
  it("reads only the row the server recorded", () => {
    expect(reviewNoteFromToolItem(serverRow)).toEqual({ ...input, id: noteId });
    for (const lookalike of [
      // The provider's own row for the MCP call.
      {
        ...serverRow,
        id: TurnItemId.make("turn-item:provider:claude:native-item:toolu_1"),
        nativeItemRef: { driver: "claude", itemId: "toolu_1" },
      },
      // A provider row that copies the server's id shape still carries its native ref.
      { ...serverRow, nativeItemRef: { driver: "codex", itemId: "call_1" } },
      { ...serverRow, id: TurnItemId.make("turn-item:provider:codex:native-item:call_1") },
      { ...serverRow, toolName: "mcp__t3-code__flag_for_review" },
      { ...serverRow, type: "mcp_tool" },
      { ...serverRow, input: { ...input, kind: "note" } },
      { ...serverRow, input: { ...input, startLine: 0 } },
      { ...serverRow, input: JSON.stringify(input) },
    ]) {
      expect(reviewNoteFromToolItem(lookalike)).toBeUndefined();
    }
  });
});

describe("reviewReplyFromToolItem", () => {
  it("reads only the row the server recorded", () => {
    const replyInput = {
      kind: "review_reply",
      commentId: "ctx_1",
      reply: "Kept the filter in checkout only.",
      comment: {
        sectionId: "turn:1",
        filePath: "server/src/orders/repository.ts",
        rangeLabel: "L8",
        startIndex: 7,
        endIndex: 7,
        text: "Export needs deleted items.",
        diff: "@@ -8,1 +8,1 @@\n+    SELECT * FROM order_items WHERE deleted_at IS NULL",
      },
      runId: "run-2",
    };
    const id = TurnItemId.make("turn-item:review-reply:thread-1:9a8b7c6d");
    const row = { id, type: "dynamic_tool", toolName: REVIEW_REPLY_TOOL_NAME, input: replyInput };
    expect(reviewReplyFromToolItem(row)).toEqual({ ...replyInput, id });
    for (const lookalike of [
      { ...row, nativeItemRef: { driver: "claude", itemId: "toolu_1" } },
      { ...row, id: noteId },
      { ...row, toolName: REVIEW_NOTE_TOOL_NAME },
      { ...row, input: { ...replyInput, commentId: " " } },
    ]) {
      expect(reviewReplyFromToolItem(lookalike)).toBeUndefined();
    }
  });
});

describe("buildReviewThreads", () => {
  type CommentEntry = Extract<ReviewTimelineEntry, { kind: "comment" }>;
  const comment = (contextId: string, record: Partial<CommentEntry["record"]>): CommentEntry => ({
    kind: "comment",
    contextId,
    record: {
      sectionId: "turn:1",
      filePath: "server/src/orders/repository.ts",
      rangeLabel: "L7 to L9",
      startIndex: 6,
      endIndex: 8,
      text: `Comment ${contextId}`,
      diff: "@@ -7,3 +7,3 @@\n context\n-old\n+new\n tail",
      ...record,
    },
  });
  const reply = (id: string, copy: CommentEntry): ReviewTimelineEntry => ({
    kind: "reply",
    reply: {
      id: TurnItemId.make(`turn-item:review-reply:thread-1:${id}`),
      kind: "review_reply",
      commentId: copy.contextId,
      reply: `Reply ${id}`,
      comment: copy.record,
      runId: RunId.make("run-2"),
    },
  });

  it("opens a thread per comment on the lines the diff's new side quoted", () => {
    const { threads, sentComments } = buildReviewThreads(
      [],
      [
        comment("ctx_diff", {}),
        comment("ctx_file", {
          sectionId: "file:server/src/app.ts",
          filePath: "server/src/app.ts",
          startIndex: 2,
          endIndex: 3,
          diff: "const a = 1;\r\nconst b = 2;\r\n",
          fenceLanguage: "ts",
        }),
        // A comment only on removed lines quotes nothing it can sit on.
        comment("ctx_removed", { diff: "@@ -4,1 +3,0 @@\n-gone" }),
        comment("ctx_pr", { sectionId: "pull-request:12" }),
        reply("r_pr", comment("ctx_pr_2", { sectionId: "pull-request:12" })),
      ],
    );
    expect(
      threads.map(({ id, path, pathBase, startLine, endLine, excerpt, sectionId, runId }) => ({
        id,
        path,
        pathBase,
        startLine,
        endLine,
        excerpt,
        sectionId,
        runId,
      })),
    ).toEqual([
      {
        id: "ctx_diff",
        path: "server/src/orders/repository.ts",
        pathBase: "diff",
        startLine: 7,
        endLine: 9,
        excerpt: "context\nnew\ntail",
        sectionId: reviewThreadSectionId("ctx_diff"),
        runId: "1",
      },
      {
        id: "ctx_file",
        path: "server/src/app.ts",
        pathBase: "workspace",
        startLine: 3,
        endLine: 4,
        excerpt: "const a = 1;\nconst b = 2;",
        sectionId: reviewThreadSectionId("ctx_file", "workspace"),
        runId: null,
      },
      expect.objectContaining({ id: "ctx_removed", excerpt: "" }),
    ]);
    expect(sentComments).toEqual([
      { path: "server/src/orders/repository.ts", pathBase: "diff" },
      { path: "server/src/app.ts", pathBase: "workspace" },
      { path: "server/src/orders/repository.ts", pathBase: "diff" },
    ]);
  });

  it("threads follow-ups and agent replies under the note or comment they answer", () => {
    const note = { ...input, id: noteId } as ReviewNote;
    const root = comment("ctx_root", {});
    const followUp = comment("ctx_follow", { sectionId: reviewThreadSectionId("ctx_root") });
    const onNote = comment("ctx_note", {
      sectionId: reviewNoteSectionId(noteId),
      filePath: input.path,
    });
    const { threads, conversations, sentComments } = buildReviewThreads(
      [note],
      [
        root,
        reply("r1", root),
        followUp,
        followUp,
        reply("r2", followUp),
        onNote,
        reply("r3", onNote),
      ],
    );
    expect(threads.map((thread) => thread.id)).toEqual(["ctx_root"]);
    expect(conversations.get("ctx_root")?.map((entry) => [entry.kind, entry.text])).toEqual([
      ["reply", "Reply r1"],
      ["comment", "Comment ctx_follow"],
      ["reply", "Reply r2"],
    ]);
    expect(conversations.get(noteId)?.map((entry) => [entry.kind, entry.text])).toEqual([
      ["comment", "Comment ctx_note"],
      ["reply", "Reply r3"],
    ]);
    expect(sentComments).toEqual([
      { path: "server/src/orders/repository.ts", pathBase: "diff" },
      { path: "server/src/orders/repository.ts", pathBase: "diff" },
      { path: input.path, pathBase: "workspace" },
    ]);
  });

  it("opens a thread from a reply's own copy when its comment's message is not loaded", () => {
    const root = comment("ctx_root", {});
    const followUp = comment("ctx_follow", { sectionId: reviewThreadSectionId("ctx_root") });
    const { threads, conversations, sentComments } = buildReviewThreads(
      [],
      [reply("r1", root), reply("r2", followUp)],
    );
    expect(threads.map((thread) => [thread.id, thread.comment])).toEqual([
      ["ctx_root", "Comment ctx_root"],
    ]);
    expect(conversations.get("ctx_root")?.map((entry) => entry.text)).toEqual([
      "Reply r1",
      "Comment ctx_follow",
      "Reply r2",
    ]);
    expect(sentComments).toHaveLength(2);
  });

  it("keeps a file-viewer thread's follow-up on workspace paths, loaded or not", () => {
    const fileComment = { filePath: "server/src/app.ts", diff: "const a = 1;\n", fenceLanguage: "ts" };
    const root = comment("ctx_root", { ...fileComment, sectionId: "file:server/src/app.ts" });
    const [rootThread] = buildReviewThreads([], [root]).threads;
    const followUp = comment("ctx_follow", { ...fileComment, sectionId: rootThread!.sectionId });

    const loaded = buildReviewThreads([], [root, followUp]);
    expect(loaded.threads.map((thread) => thread.id)).toEqual(["ctx_root"]);
    expect(loaded.sentComments.map((sent) => sent.pathBase)).toEqual(["workspace", "workspace"]);

    const alone = buildReviewThreads([], [reply("r1", followUp)]);
    expect(alone.threads.map(({ id, pathBase }) => [id, pathBase])).toEqual([
      ["ctx_follow", "workspace"],
    ]);
  });
});

describe("answeredReviewNoteIds", () => {
  it("counts a user's review comment in the note's section as the answer", () => {
    const note = { ...input, id: noteId } as ReviewNote;
    const other = { ...note, id: TurnItemId.make("turn-item:review-note:thread-1:0a1b2c3d") };
    const reply = (role: string, sectionId: string, index: number): AnsweringMessage => ({
      role,
      context: {
        version: 1,
        records: [
          {
            version: 1,
            contextId: ComposerContextId.make(`reply-${index}`),
            label: "Review note",
            kind: "review-comment",
            sectionId,
            sectionTitle: "Review note",
            filePath: input.path,
            startIndex: 6,
            endIndex: 7,
            rangeLabel: "L7 to L8",
            text: "Keep the filter for checkout only.",
            diff: input.excerpt,
          },
        ],
      },
    });
    const answered = answeredReviewNoteIds(
      [note, other],
      [
        reply("user", reviewNoteSectionId(noteId), 1),
        reply("assistant", reviewNoteSectionId(other.id), 2),
        reply("user", "diff:server/src/orders.ts", 3),
        { role: "user" },
      ],
    );
    expect([...answered]).toEqual([noteId]);
  });

  it("keeps the section id within a context record's 255 characters for any thread id", () => {
    const longThread = encodeURIComponent(`thread:delegated-task:${"x%3A".repeat(200)}`);
    expect(
      reviewNoteSectionId(TurnItemId.make(`turn-item:review-note:${longThread}:${"f".repeat(32)}`)),
    ).toBe(`review-note:${"f".repeat(32)}`);
  });
});
