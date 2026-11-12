import type { FileDiffMetadata } from "@pierre/diffs";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  classifyDiffFileContentsFailure,
  createTurnDiffFileContentsLoader,
} from "./diffFileContents";

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
