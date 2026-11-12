import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { RunId, TurnItemId } from "@t3tools/contracts";
import type { ReviewNote } from "@t3tools/shared/reviewNote";
import { describe, expect, it } from "vite-plus/test";

import {
  anchorReviewNote,
  type PlacedReviewNote,
  placeReviewNotes,
  stepReviewNote,
} from "./reviewNoteAnchoring";

const REVISION = "3b18e512dba79e4c8300dd08aeb37f8e728b8dad";

const note = (overrides: Partial<ReviewNote> = {}): ReviewNote => ({
  id: TurnItemId.make("review-note:thread-1:abc"),
  kind: "review_note",
  path: "src/app.ts",
  startLine: 2,
  endLine: 3,
  note: "Check the retry.",
  excerpt: "retry()\nreturn",
  excerptTruncated: false,
  contentRevision: REVISION,
  runId: RunId.make("run-1"),
  ...overrides,
});

const diffOf = (lines: ReadonlyArray<string>) =>
  parsePatchFiles(lines.join("\n"), { cacheKeyPrefix: "review-note-anchoring" })[0]!.files[0]!;

const changed = (index: string, body: ReadonlyArray<string>) =>
  diffOf([
    "diff --git a/src/app.ts b/src/app.ts",
    `index 1111111..${index} 100644`,
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    ...body,
  ]);

describe("anchorReviewNote", () => {
  it.each([
    {
      state: "exact on the flagged revision",
      fileDiff: changed(REVISION.slice(0, 7), [
        "@@ -1,3 +1,4 @@",
        " start",
        "+retry()",
        "+return",
        " end",
      ]),
      expected: { kind: "exact", startLine: 2, endLine: 3 },
    },
    {
      state: "moved where the excerpt occurs once",
      fileDiff: changed("2222222", [
        "@@ -1,3 +1,6 @@",
        " start",
        "+added",
        "+added again",
        "+retry()",
        "+return",
        " end",
      ]),
      expected: { kind: "moved", startLine: 4, endLine: 5 },
    },
    {
      state: "unattached when the excerpt is gone",
      fileDiff: changed("2222222", ["@@ -1,3 +1,3 @@", " start", "-retry()", "+giveUp()", " end"]),
      expected: { kind: "unattached" },
    },
    {
      state: "unattached when the excerpt occurs twice",
      fileDiff: changed("2222222", [
        "@@ -1,2 +1,6 @@",
        " start",
        "+retry()",
        "+return",
        "+retry()",
        "+return",
        " end",
      ]),
      expected: { kind: "unattached" },
    },
    {
      state: "unattached on a deleted file",
      fileDiff: diffOf([
        "diff --git a/src/app.ts b/src/app.ts",
        "deleted file mode 100644",
        `index ${REVISION.slice(0, 7)}..0000000`,
        "--- a/src/app.ts",
        "+++ /dev/null",
        "@@ -1,4 +0,0 @@",
        "-start",
        "-retry()",
        "-return",
        "-end",
      ]),
      expected: { kind: "unattached" },
    },
    {
      state: "unattached on a renamed file",
      fileDiff: diffOf([
        "diff --git a/src/app.ts b/src/main.ts",
        "similarity index 80%",
        "rename from src/app.ts",
        "rename to src/main.ts",
        `index 1111111..${REVISION.slice(0, 7)} 100644`,
        "--- a/src/app.ts",
        "+++ b/src/main.ts",
        "@@ -1,3 +1,4 @@",
        " start",
        "+retry()",
        "+return",
        " end",
      ]),
      expected: { kind: "unattached" },
    },
    {
      state: "unattached when its lines run through lines the diff folds away",
      overrides: { endLine: 12 },
      fileDiff: changed(REVISION.slice(0, 7), [
        "@@ -1,3 +1,4 @@",
        " start",
        "+retry()",
        " a",
        " b",
        "@@ -9,3 +10,4 @@",
        " x",
        " y",
        "+return",
        " end",
      ]),
      expected: { kind: "unattached" },
    },
    {
      state: "moved over its excerpt's own lines when the note ran past them",
      overrides: { endLine: 9, excerptTruncated: true },
      fileDiff: changed("2222222", [
        "@@ -1,3 +1,6 @@",
        " start",
        "+added",
        "+added again",
        "+retry()",
        "+return",
        " end",
      ]),
      expected: { kind: "moved", startLine: 4, endLine: 5 },
    },
    {
      state: "unattached when the last whole line of a shortened excerpt changed",
      overrides: { endLine: 4, excerptTruncated: true },
      fileDiff: changed("2222222", [
        "@@ -1,3 +1,5 @@",
        " start",
        "+added",
        "+retry()",
        "+returnLater()",
        " end",
      ]),
      expected: { kind: "unattached" },
    },
    {
      state: "moved on a single line the server cut short",
      overrides: { endLine: 2, excerpt: "retry(", excerptTruncated: true },
      fileDiff: changed("2222222", ["@@ -1,3 +1,4 @@", " start", "+added", "+retry()", " end"]),
      expected: { kind: "moved", startLine: 3, endLine: 3 },
    },
    {
      state:
        "unattached when a longer note kept only its whole first line, which only starts a line",
      overrides: { endLine: 3, excerpt: "retry()", excerptTruncated: true },
      fileDiff: changed("2222222", [
        "@@ -1,3 +1,4 @@",
        " start",
        "+added",
        "+retry() // once more",
        " end",
      ]),
      expected: { kind: "unattached" },
    },
    {
      state: "unattached on the flagged revision's lines outside the hunks when hunks are shown",
      overrides: { startLine: 20, endLine: 21 },
      fileDiff: changed(REVISION.slice(0, 7), ["@@ -1,3 +1,4 @@", " start", "+x", "+y", " end"]),
      expected: { kind: "unattached" },
    },
    {
      state: "exact on the flagged revision's lines outside the hunks when the whole file is shown",
      overrides: { startLine: 20, endLine: 21 },
      shownLines: "whole-file" as const,
      fileDiff: changed(REVISION.slice(0, 7), ["@@ -1,3 +1,4 @@", " start", "+x", "+y", " end"]),
      expected: { kind: "exact", startLine: 20, endLine: 21 },
    },
    {
      state:
        "moved as with hunks when the whole file is shown but the revision is not the flagged one",
      shownLines: "whole-file" as const,
      fileDiff: changed("2222222", [
        "@@ -1,3 +1,6 @@",
        " start",
        "+added",
        "+added again",
        "+retry()",
        "+return",
        " end",
      ]),
      expected: { kind: "moved", startLine: 4, endLine: 5 },
    },
    {
      state:
        "unattached when the whole file is shown, the revision is not the flagged one and the lines are outside the hunks",
      overrides: { startLine: 20, endLine: 21 },
      shownLines: "whole-file" as const,
      fileDiff: changed("2222222", ["@@ -1,3 +1,4 @@", " start", "+x", "+y", " end"]),
      expected: { kind: "unattached" },
    },
  ])("is $state", ({ fileDiff, expected, overrides, shownLines }) => {
    expect(anchorReviewNote(note(overrides), fileDiff, undefined, shownLines)).toEqual(expected);
  });
});

describe("placeReviewNotes", () => {
  it("orders notes as the viewer shows them and leaves a loading file's note pending", () => {
    const shown = changed(REVISION.slice(0, 7), [
      "@@ -1,3 +1,5 @@",
      " start",
      "+retry()",
      "+return",
      "+retry()",
      " end",
    ]);
    const loading = { ...shown, name: "src/later.ts", hunks: [], additionLines: [] };
    const later = note({ id: TurnItemId.make("review-note:thread-1:later"), startLine: 3 });
    const earlier = note({ id: TurnItemId.make("review-note:thread-1:earlier"), startLine: 2 });
    const elsewhere = note({ id: TurnItemId.make("review-note:thread-1:else"), path: "x.ts" });
    const pending = note({
      id: TurnItemId.make("review-note:thread-1:pending"),
      path: "src/later.ts",
    });

    const placed = placeReviewNotes(
      [pending, later, elsewhere, earlier],
      [
        { fileDiff: shown, fileKey: "app", pending: false },
        { fileDiff: loading, fileKey: "later", pending: true },
      ],
      { workspaceRoot: "/repo", repositoryRoot: undefined },
    );

    expect(placed.map(({ note, fileKey, anchor }) => [note.id, fileKey, anchor.kind])).toEqual([
      [earlier.id, "app", "exact"],
      [later.id, "app", "exact"],
      [pending.id, "later", "pending"],
    ]);
  });

  it("finds a note from a project folder below the repository root under the diff's path", () => {
    const fileDiff = diffOf([
      "diff --git a/apps/web/src/app.ts b/apps/web/src/app.ts",
      `index 1111111..${REVISION.slice(0, 7)} 100644`,
      "--- a/apps/web/src/app.ts",
      "+++ b/apps/web/src/app.ts",
      "@@ -1,3 +1,4 @@",
      " start",
      "+retry()",
      "+return",
      " end",
    ]);

    const placed = placeReviewNotes([note()], [{ fileDiff, fileKey: "app", pending: false }], {
      workspaceRoot: "/repo/apps/web",
      repositoryRoot: "/repo",
    });

    expect(placed.map(({ fileKey, anchor }) => [fileKey, anchor])).toEqual([
      ["app", { kind: "exact", startLine: 2, endLine: 3 }],
    ]);
  });
});

describe("placeReviewNotes with the lines the viewer shows", () => {
  const roots = { workspaceRoot: "/repo", repositoryRoot: undefined };

  it("places a note outside the hunks only for a viewer of whole files, and keeps the two apart in the cache", () => {
    const fileDiff = changed(REVISION.slice(0, 7), [
      "@@ -1,3 +1,4 @@",
      " start",
      "+x",
      "+y",
      " end",
    ]);
    const outside = note({ startLine: 20, endLine: 21 });
    const files = [{ fileDiff, fileKey: "app", pending: false }];
    const anchors = (shown?: "hunks" | "whole-file") =>
      (shown === undefined
        ? placeReviewNotes([outside], files, roots)
        : placeReviewNotes([outside], files, roots, shown)
      ).map(({ anchor }) => anchor.kind);

    // The same diff and note, asked in turn: an answer for one must not serve the other.
    expect([anchors(), anchors("whole-file"), anchors("hunks"), anchors("whole-file")]).toEqual([
      ["unattached"],
      ["exact"],
      ["unattached"],
      ["exact"],
    ]);
  });
});

describe("stepReviewNote", () => {
  it("steps past a note that turned out unplaced instead of starting over", () => {
    const at = (id: string, kind: "exact" | "unattached"): PlacedReviewNote => ({
      note: note({ id: TurnItemId.make(`review-note:thread-1:${id}`) }),
      fileKey: id,
      anchor: kind === "exact" ? { kind, startLine: 2, endLine: 3 } : { kind },
    });
    const notes = [at("a", "exact"), at("b", "unattached"), at("c", "exact")];
    const step = (from: string | null, direction: 1 | -1) =>
      stepReviewNote(notes, from && `review-note:thread-1:${from}`, direction)?.fileKey;

    expect([step("b", 1), step("b", -1), step("c", 1), step(null, 1), step(null, -1)]).toEqual([
      "c",
      "a",
      "a",
      "a",
      "c",
    ]);
  });
});
