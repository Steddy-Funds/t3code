import { describe, expect, it } from "vite-plus/test";

import { buildFileReviewComment, type ReviewCommentContext } from "~/reviewCommentContext";

import { sendableReviewComments, withQuotedSelection } from "./useReviewCommentDrafts";

const fileComment = buildFileReviewComment({
  id: "c1",
  filePath: "src/app.ts",
  startLine: 1,
  endLine: 2,
  text: "Why not baz?",
  contents: "const value = foo(bar);\n  return value;\n",
});
const diffComment: ReviewCommentContext = {
  ...fileComment,
  diff: "@@ -1,1 +1,2 @@\n-const value = foo();\n+const value = foo(bar);\n+  return value;",
  fenceLanguage: "diff",
};

const sideComment = (
  side: "additions" | "deletions",
  endSide: "additions" | "deletions",
): ReviewCommentContext => ({
  ...diffComment,
  diff: "@@ -1,3 +1,3 @@\n head\n-old line\n+new line\n tail",
  selection: { start: 1, side, end: 3, endSide },
});

describe("sendableReviewComments", () => {
  it("leaves pull request context out of a review send", () => {
    const pullRequest = {
      number: 12,
      title: "Billing",
      url: "https://example.com/pull/12",
      headBranch: "billing",
      baseBranch: "main",
      state: "open",
      isDraft: false,
    } as const;
    const comments: ReviewCommentContext[] = [
      fileComment,
      { ...diffComment, id: "diff", sectionId: "unstaged" },
      { ...fileComment, id: "reference", sectionId: "pull-request:12", diff: "", pullRequest },
      { ...diffComment, id: "remark", sectionId: "pull-request:12" },
      { ...fileComment, id: "note-reply", sectionId: "review-note:x" },
    ];
    expect(sendableReviewComments(comments).map((comment) => comment.id)).toEqual([
      "c1",
      "diff",
      "note-reply",
    ]);
  });
});

describe("withQuotedSelection", () => {
  it.each([
    {
      name: "quotes words selected in the commented lines above the comment",
      comment: fileComment,
      selected: "foo(bar)",
      text: "> foo(bar)\n\nWhy not baz?",
    },
    {
      name: "reads a diff's lines without their change markers",
      comment: diffComment,
      selected: "const value = foo(bar);\n  return value;",
      text: "> const value = foo(bar);\n>   return value;\n\nWhy not baz?",
    },
    {
      name: "leaves out a selection made somewhere else",
      comment: fileComment,
      selected: "unrelated words",
      text: "Why not baz?",
    },
    {
      name: "leaves out a selection of the hunk header",
      comment: diffComment,
      selected: "@@ -1,1 +1,2 @@",
      text: "Why not baz?",
    },
    {
      name: "ignores an empty selection",
      comment: fileComment,
      selected: "   ",
      text: "Why not baz?",
    },
    {
      name: "is the quote alone while nothing is typed yet",
      comment: { ...fileComment, text: "" },
      selected: "foo(bar)",
      text: "> foo(bar)",
    },
    {
      name: "quotes a pane's text that skips the other side's rows of a change (additions)",
      comment: sideComment("additions", "additions"),
      selected: "head\nnew line\ntail",
      text: "> head\n> new line\n> tail\n\nWhy not baz?",
    },
    {
      name: "quotes a pane's text that skips the other side's rows of a change (deletions)",
      comment: sideComment("deletions", "deletions"),
      selected: "head\nold line\ntail",
      text: "> head\n> old line\n> tail\n\nWhy not baz?",
    },
    {
      name: "quotes a pane's text across a change that only adds",
      comment: {
        ...sideComment("additions", "additions"),
        diff: "@@ -1,2 +1,3 @@\n head\n+added\n tail",
      },
      selected: "head\nadded\ntail",
      text: "> head\n> added\n> tail\n\nWhy not baz?",
    },
    {
      name: "still quotes text as stacked shows it for a one-side comment",
      comment: sideComment("additions", "additions"),
      selected: "old line\nnew line",
      text: "> old line\n> new line\n\nWhy not baz?",
    },
    {
      name: "leaves out the other side's text joined across rows of this side",
      comment: sideComment("additions", "additions"),
      selected: "old line\ntail",
      text: "Why not baz?",
    },
    {
      name: "leaves out this side's text joined across the other side's rows of a deletions comment",
      comment: sideComment("deletions", "deletions"),
      selected: "head\nnew line",
      text: "Why not baz?",
    },
    {
      name: "leaves out a pane's skipping text for a range across sides",
      comment: sideComment("deletions", "additions"),
      selected: "head\nnew line\ntail",
      text: "Why not baz?",
    },
    {
      name: "leaves out a pane's skipping text for a comment with no selection",
      comment: { ...sideComment("additions", "additions"), selection: undefined },
      selected: "head\nnew line\ntail",
      text: "Why not baz?",
    },
    {
      name: "leaves out a pane's skipping text for a non-diff fence",
      comment: {
        ...sideComment("additions", "additions"),
        fenceLanguage: "ts",
        diff: "head\n-old line\n+new line\ntail",
      },
      selected: "head\n+new line\ntail",
      text: "Why not baz?",
    },
    {
      name: "quotes text of a non-diff fence with its markers, as before",
      comment: {
        ...sideComment("additions", "additions"),
        fenceLanguage: "ts",
        diff: "head\n-old line\n+new line\ntail",
      },
      selected: "-old line\n+new line",
      text: "> -old line\n> +new line\n\nWhy not baz?",
    },
    {
      name: "ignores the hunk header on a pane's lines",
      comment: sideComment("additions", "additions"),
      selected: "@@ -1,3 +1,3 @@",
      text: "Why not baz?",
    },
  ])("$name", ({ comment, selected, text }) => {
    expect(withQuotedSelection(comment, selected).text).toBe(text);
  });

  it("bounds a long selection", () => {
    const line = "x".repeat(900);
    const comment = buildFileReviewComment({
      id: "c2",
      filePath: "src/app.ts",
      startLine: 1,
      endLine: 1,
      text: "Too long",
      contents: line,
    });
    const quoted = withQuotedSelection(comment, line).text;
    expect(quoted).toBe(`> ${"x".repeat(400)}…\n\nToo long`);
  });
});
