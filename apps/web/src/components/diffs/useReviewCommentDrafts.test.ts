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
