import { ComposerContextId, REVIEW_NOTE_TOOL_NAME, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  answeredReviewNoteIds,
  type ReviewNote,
  reviewNoteFromToolItem,
  reviewNoteSectionId,
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
