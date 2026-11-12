import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ReviewCommentThread, ReviewThreadEntry } from "@t3tools/shared/reviewNote";

import { resolveDiffPathForWorkspace } from "~/diffFileActions";
import { useThreadReviewNotes } from "~/reviewNotes";
import { useProject, useQuietThreadShell } from "~/state/entities";

import { useReviewNoteDismissals } from "../diffs/reviewNoteDismissals";

export interface FileReviewThreadPlacement {
  readonly startLine: number;
  readonly endLine: number;
  readonly moved: boolean;
}

// A file can be megabytes, and the viewer re-renders on each keystroke; keep its last split.
let splitCache: { readonly contents: string; readonly lines: ReadonlyArray<string> } | null = null;
const linesOf = (contents: string) => {
  if (splitCache?.contents !== contents) {
    splitCache = { contents, lines: contents.split("\n").map((line) => line.replace(/\r$/u, "")) };
  }
  return splitCache.lines;
};

/**
 * Where a thread sits in the file as it reads now: on its own lines while they still read what
 * the comment quoted, else where that text occurs exactly once. Anywhere else it stays off the file.
 */
export function placeReviewThreadInFile(
  thread: Pick<ReviewCommentThread, "excerpt" | "startLine">,
  contents: string,
): FileReviewThreadPlacement | null {
  if (thread.excerpt.length === 0) return null;
  const excerpt = thread.excerpt.split("\n");
  const lines = linesOf(contents);
  const readsAt = (start: number) =>
    start >= 0 &&
    start + excerpt.length <= lines.length &&
    excerpt.every((line, offset) => lines[start + offset] === line);
  const endOf = (start: number) => start + excerpt.length;
  if (readsAt(thread.startLine - 1)) {
    return { startLine: thread.startLine, endLine: endOf(thread.startLine - 1), moved: false };
  }
  let found = -1;
  for (let start = 0; start + excerpt.length <= lines.length; start += 1) {
    if (!readsAt(start)) continue;
    if (found >= 0) return null;
    found = start;
  }
  return found < 0 ? null : { startLine: found + 1, endLine: endOf(found), moved: true };
}

const NO_CONVERSATION: ReadonlyArray<ReviewThreadEntry> = [];

/** The thread's review threads on one workspace file, placed in its current text. */
export function useFileReviewThreads(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly relativePath: string;
  readonly contents: string;
}) {
  const { threads, conversations } = useThreadReviewNotes(input.threadRef);
  const { dismissedIds, dismiss } = useReviewNoteDismissals(input.threadRef);
  const thread = useQuietThreadShell(input.threadRef);
  const project = useProject(
    thread?.projectId ? { environmentId: thread.environmentId, projectId: thread.projectId } : null,
  );
  const roots = {
    workspaceRoot: thread?.worktreePath ?? project?.workspaceRoot,
    repositoryRoot: thread?.worktreePath ? undefined : project?.repositoryIdentity?.rootPath,
  };
  const placed = threads.flatMap((candidate) => {
    if (dismissedIds.has(candidate.id)) return [];
    const path =
      candidate.pathBase === "workspace"
        ? candidate.path
        : resolveDiffPathForWorkspace({ filePath: candidate.path, ...roots });
    if (path !== input.relativePath) return [];
    const placement = placeReviewThreadInFile(candidate, input.contents);
    return placement ? [{ thread: candidate, ...placement }] : [];
  });
  return {
    placed,
    conversationOf: (threadId: string) => conversations.get(threadId) ?? NO_CONVERSATION,
    dismiss,
  };
}
