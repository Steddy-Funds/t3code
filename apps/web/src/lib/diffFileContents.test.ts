import type { FileDiffMetadata } from "@pierre/diffs";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  classifyDiffFileContentsFailure,
  createGitDiffFileContentsLoader,
  createTurnDiffFileContentsLoader,
} from "./diffFileContents";
import { getRenderablePatch } from "./diffRendering";

const originalLines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
const changedLines = originalLines.map((line, index) => (index === 29 ? "line 30 changed" : line));

function toContents(lines: ReadonlyArray<string>) {
  return `${lines.join("\n")}\n`;
}

function parsePartialFileDiff(patch: string): FileDiffMetadata {
  const renderable = getRenderablePatch(patch, "diff-panel:light", {
    compactPartialHunkOffsets: true,
  });
  if (renderable?.kind !== "files") throw new Error("Expected a parsed patch.");
  return renderable.files[0]!;
}

function partialFileDiff(): FileDiffMetadata {
  const patch = [
    "diff --git a/src/file01.ts b/src/file01.ts",
    "index 1111111..2222222 100644",
    "--- a/src/file01.ts",
    "+++ b/src/file01.ts",
    "@@ -27,7 +27,7 @@",
    " line 27",
    " line 28",
    " line 29",
    "-line 30",
    "+line 30 changed",
    " line 31",
    " line 32",
    " line 33",
    "",
  ].join("\n");
  return parsePartialFileDiff(patch);
}

function loaderReturning(oldContents: string, newContents: string) {
  return createGitDiffFileContentsLoader(
    async () => AsyncResult.success({ oldContents, newContents }),
    {
      environmentId: EnvironmentId.make("environment-diff-contents-test"),
      cwd: "/repo",
      sourceKind: "working-tree",
      baseRef: null,
      headRef: null,
      cacheKey: "diff-hash",
    },
  );
}

describe("createGitDiffFileContentsLoader", () => {
  it("loads contents that still reproduce the patch", async () => {
    const loaded = await loaderReturning(
      toContents(originalLines),
      toContents(changedLines),
    )(partialFileDiff());

    expect(loaded.newFile.contents).toBe(toContents(changedLines));
  });

  it.each([
    {
      name: "end before the patch's hunk",
      oldLines: originalLines.slice(0, 30),
      newLines: changedLines.slice(0, 30),
    },
    {
      name: "have unchanged tails that no longer match between sides",
      oldLines: originalLines,
      newLines: [...changedLines, "line 41 appended"],
    },
    {
      name: "changed hunk lines without moving them",
      oldLines: originalLines,
      newLines: changedLines.map((line, index) => (index === 30 ? "edited since" : line)),
    },
  ])("rejects contents that $name", async ({ oldLines, newLines }) => {
    const loader = loaderReturning(toContents(oldLines), toContents(newLines));

    await expect(loader(partialFileDiff())).rejects.toThrow("changed since the diff was loaded");
  });

  it.each([
    {
      name: "a renamed file",
      patch: [
        "diff --git a/ leading.txt b/renamed.txt ",
        "similarity index 100%",
        "rename from  leading.txt",
        "rename to renamed.txt ",
        "",
      ],
      oldPath: " leading.txt",
      newPath: "renamed.txt ",
    },
    {
      name: "a modified file",
      patch: [
        "diff --git a/trailing.txt  b/trailing.txt ",
        "index 422c2b7..55dce13 100644",
        "--- a/trailing.txt \t",
        "+++ b/trailing.txt \t",
        "@@ -1,2 +1,2 @@",
        " a",
        "-b",
        "+B",
        "",
      ],
      oldPath: "trailing.txt ",
      newPath: "trailing.txt ",
    },
  ])("requests the exact whitespace-edged paths of $name", async ({ patch, oldPath, newPath }) => {
    const requested: Array<{ oldPath: string; newPath: string }> = [];
    const loader = createGitDiffFileContentsLoader(
      async ({ input }) => {
        requested.push({ oldPath: input.oldPath, newPath: input.newPath });
        return AsyncResult.success({ oldContents: "a\nb\n", newContents: "a\nB\n" });
      },
      {
        environmentId: EnvironmentId.make("environment-diff-contents-test"),
        cwd: "/repo",
        sourceKind: "working-tree",
        baseRef: null,
        headRef: null,
        cacheKey: "diff-hash",
      },
    );

    await loader(parsePartialFileDiff(patch.join("\n")));

    expect(requested).toEqual([{ oldPath, newPath }]);
  });

  it("loads a whitespace-ignored patch whose context shows one side's whitespace", async () => {
    const patch = [
      "diff --git a/src/file01.ts b/src/file01.ts",
      "index 1111111..2222222 100644",
      "--- a/src/file01.ts",
      "+++ b/src/file01.ts",
      "@@ -2,4 +2,4 @@ a",
      " b",
      " c",
      " d",
      "-e",
      "\\ No newline at end of file",
      "+E",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const loaded = await loaderReturning(
      "a\nb\n  c\nd\ne",
      "a\nb\nc\nd\nE",
    )(parsePartialFileDiff(patch));

    expect(loaded.oldFile?.contents).toBe("a\nb\n  c\nd\ne");
  });
});

const source = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
  fromTurnCount: 2,
  toTurnCount: 5,
  cacheKey: "turn:2-5",
};

const fileDiff = (fields: Partial<FileDiffMetadata>) =>
  ({ name: "src/new.ts", type: "change", hunks: [], ...fields }) as FileDiffMetadata;

function setup(
  result: AsyncResult.Success<unknown, unknown> | AsyncResult.Failure<unknown, unknown>,
) {
  const getContents = vi.fn(async () => result);
  const load = createTurnDiffFileContentsLoader(getContents as never, source);
  return { getContents, load };
}

const contents = AsyncResult.success({ oldContents: "before", newContents: "after" });

describe("createTurnDiffFileContentsLoader", () => {
  it("asks for the file by its path alone when it kept its name", async () => {
    const { getContents, load } = setup(contents);
    await load(fileDiff({}));
    expect(getContents).toHaveBeenCalledWith({
      environmentId: source.environmentId,
      input: { threadId: source.threadId, fromTurnCount: 2, toTurnCount: 5, path: "src/new.ts" },
    });
  });

  it("names the previous path of a rename", async () => {
    const { getContents, load } = setup(contents);
    await load(fileDiff({ type: "rename-changed", prevName: "src/old.ts" }));
    expect(getContents).toHaveBeenCalledWith({
      environmentId: source.environmentId,
      input: {
        threadId: source.threadId,
        fromTurnCount: 2,
        toTurnCount: 5,
        path: "src/new.ts",
        previousPath: "src/old.ts",
      },
    });
  });

  it("gives both files, keyed by side and path", async () => {
    const { load } = setup(contents);
    await expect(
      load(fileDiff({ type: "rename-changed", prevName: "src/old.ts" })),
    ).resolves.toEqual({
      oldFile: { name: "src/old.ts", contents: "before", cacheKey: "turn:2-5:old:src/old.ts" },
      newFile: { name: "src/new.ts", contents: "after", cacheKey: "turn:2-5:new:src/new.ts" },
    });
  });

  it("gives no old file for a pure rename", async () => {
    const { load } = setup(contents);
    await expect(load(fileDiff({ type: "rename-pure", prevName: "src/old.ts" }))).resolves.toEqual({
      oldFile: null,
      newFile: { name: "src/new.ts", contents: "after", cacheKey: "turn:2-5:new:src/new.ts" },
    });
  });

  it("throws the error of a failed command", async () => {
    const error = { _tag: "OrchestrationGetTurnDiffFileContentsError", reason: "binary" };
    const { load } = setup(AsyncResult.failure(Cause.fail(error)));
    await expect(load(fileDiff({}))).rejects.toBe(error);
  });
});

describe("classifyDiffFileContentsFailure", () => {
  it.each([
    {
      name: "a binary turn file",
      error: { _tag: "OrchestrationGetTurnDiffFileContentsError", reason: "binary" },
      expected: "binary",
    },
    {
      name: "a too large turn file",
      error: { _tag: "OrchestrationGetTurnDiffFileContentsError", reason: "too_large" },
      expected: "too-large",
    },
    {
      name: "a turn file not in the diff",
      error: { _tag: "OrchestrationGetTurnDiffFileContentsError", reason: "not_in_diff" },
      expected: "failed",
    },
    {
      name: "an unavailable turn file",
      error: { _tag: "OrchestrationGetTurnDiffFileContentsError", reason: "unavailable" },
      expected: "failed",
    },
    {
      name: "a process output limit",
      error: { _tag: "VcsProcessOutputLimitError" },
      expected: "too-large",
    },
    {
      name: "a binary file in the detail",
      error: { detail: "Refusing a binary file" },
      expected: "binary",
    },
    {
      name: "a 1 MB limit in the detail",
      error: { detail: "File is over 1 MB" },
      expected: "too-large",
    },
    { name: "any other detail", error: { detail: "git exited with 128" }, expected: "failed" },
    {
      name: "a turn error's text is not read",
      error: {
        _tag: "OrchestrationGetTurnDiffFileContentsError",
        reason: "unavailable",
        detail: "binary file",
      },
      expected: "failed",
    },
    { name: "an object with nothing to read", error: {}, expected: "failed" },
    { name: "a string", error: "binary file", expected: "failed" },
    { name: "null", error: null, expected: "failed" },
    { name: "undefined", error: undefined, expected: "failed" },
  ])("reads $name as $expected", ({ error, expected }) => {
    expect(classifyDiffFileContentsFailure(error)).toBe(expected);
  });
});
