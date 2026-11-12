import type { FileDiffContentsLoader } from "@pierre/diffs";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationGetTurnDiffFileContentsInput,
  OrchestrationGetTurnDiffFileContentsResult,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestRef,
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewSourceKind,
  ThreadId,
} from "@t3tools/contracts";

import { resolveFileDiffPath } from "./diffRendering";

interface GitDiffFileContentsSource {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly sourceKind: ReviewDiffPreviewSourceKind;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly cacheKey: string;
}

interface PullRequestDiffFileContentsSource {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly commit: string | null;
  readonly cacheKey: string;
}

interface TurnDiffFileContentsSource {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly cacheKey: string;
}

type GetTurnDiffFileContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: OrchestrationGetTurnDiffFileContentsInput;
}) => Promise<AtomCommandResult<OrchestrationGetTurnDiffFileContentsResult, E>>;

type GetDiffFileContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: ReviewDiffFileContentsInput;
}) => Promise<AtomCommandResult<ReviewDiffFileContentsResult, E>>;

type GetPullRequestDiffFileContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestDiffFileContentsInput;
}) => Promise<AtomCommandResult<PullRequestDiffFileContentsResult, E>>;

function createDiffFileContentsLoader(
  load: (input: {
    readonly changeType: PullRequestDiffFileContentsInput["changeType"];
    readonly oldPath: string;
    readonly newPath: string;
  }) => Promise<{ readonly oldContents: string; readonly newContents: string }>,
  cacheKey: string,
): FileDiffContentsLoader {
  return async (fileDiff) => {
    const newPath = resolveFileDiffPath(fileDiff);
    const oldPath = fileDiff.prevName
      ? resolveFileDiffPath({ ...fileDiff, name: fileDiff.prevName })
      : newPath;
    const contents = await load({ changeType: fileDiff.type, oldPath, newPath });
    const newFile = {
      name: newPath,
      contents: contents.newContents,
      cacheKey: `${cacheKey}:new:${newPath}`,
    };
    if (fileDiff.type === "rename-pure") {
      return { oldFile: null, newFile };
    }
    return {
      oldFile: {
        name: oldPath,
        contents: contents.oldContents,
        cacheKey: `${cacheKey}:old:${oldPath}`,
      },
      newFile,
    };
  };
}

export function createGitDiffFileContentsLoader<E>(
  getDiffFileContents: GetDiffFileContents<E>,
  source: GitDiffFileContentsSource,
): FileDiffContentsLoader {
  return createDiffFileContentsLoader(async ({ changeType, oldPath, newPath }) => {
    const result = await getDiffFileContents({
      environmentId: source.environmentId,
      input: {
        cwd: source.cwd,
        sourceKind: source.sourceKind,
        changeType,
        baseRef: source.baseRef,
        headRef: source.headRef,
        oldPath,
        newPath,
      },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value;
  }, source.cacheKey);
}

export function createPullRequestDiffFileContentsLoader<E>(
  getDiffFileContents: GetPullRequestDiffFileContents<E>,
  source: PullRequestDiffFileContentsSource,
): FileDiffContentsLoader {
  return createDiffFileContentsLoader(async ({ changeType, oldPath, newPath }) => {
    const result = await getDiffFileContents({
      environmentId: source.environmentId,
      input: {
        ...source.reference,
        ...(source.commit === null ? {} : { commit: source.commit }),
        changeType,
        oldPath,
        newPath,
      },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value;
  }, source.cacheKey);
}

/** Whole files of one turn range, read from its checkpoints. */
export function createTurnDiffFileContentsLoader<E>(
  getTurnDiffFileContents: GetTurnDiffFileContents<E>,
  source: TurnDiffFileContentsSource,
): FileDiffContentsLoader {
  return createDiffFileContentsLoader(async ({ oldPath, newPath }) => {
    const result = await getTurnDiffFileContents({
      environmentId: source.environmentId,
      input: {
        threadId: source.threadId,
        fromTurnCount: source.fromTurnCount,
        toTurnCount: source.toTurnCount,
        path: newPath,
        ...(oldPath === newPath ? {} : { previousPath: oldPath }),
      },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value;
  }, source.cacheKey);
}

export type DiffFileContentsFailure = "binary" | "too-large" | "failed";

/**
 * Why a contents loader failed, as far as it tells. The turn loader names its reason; the git
 * and pull request loaders report a size or binary refusal only in their error's text.
 */
export function classifyDiffFileContentsFailure(error: unknown): DiffFileContentsFailure {
  if (typeof error !== "object" || error === null) return "failed";
  const { _tag: tag, reason, detail } = error as Record<string, unknown>;
  if (tag === "OrchestrationGetTurnDiffFileContentsError") {
    return reason === "binary" ? "binary" : reason === "too_large" ? "too-large" : "failed";
  }
  if (tag === "VcsProcessOutputLimitError") return "too-large";
  if (typeof detail !== "string") return "failed";
  if (detail.includes("binary file")) return "binary";
  return detail.includes("1 MB") ? "too-large" : "failed";
}
