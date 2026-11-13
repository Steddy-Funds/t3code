import { describe, expect, it } from "vite-plus/test";

import { placeReviewThreadInFile } from "./fileReviewThreads";

describe("placeReviewThreadInFile", () => {
  it.each([
    {
      state: "on its own lines while they read what it quoted",
      contents: "start\r\nretry()\r\nreturn\r\nretry()\r\nreturn\r\n",
      expected: { startLine: 2, endLine: 3, moved: false },
    },
    {
      state: "moved where the quote occurs once",
      contents: "start\nadded\nretry()\nreturn\n",
      expected: { startLine: 3, endLine: 4, moved: true },
    },
    {
      state: "off the file when the quote occurs twice elsewhere",
      contents: "a\nb\nretry()\nreturn\nretry()\nreturn\n",
      expected: null,
    },
    { state: "off the file when the quote is gone", contents: "start\ngiveUp()\n", expected: null },
    {
      state: "off the file when it quoted nothing",
      excerpt: "",
      contents: "start\nretry()\n",
      expected: null,
    },
  ])("places a thread $state", ({ excerpt = "retry()\nreturn", contents, expected }) => {
    expect(placeReviewThreadInFile({ excerpt, startLine: 2 }, contents)).toEqual(expected);
  });
});
