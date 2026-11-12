import * as Equal from "effect/Equal";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  type WorkingTreeChangeEntry,
  type WorkingTreeChanges,
  workingTreeChanges,
} from "~/components/files/treeGitStatus";
import type { vcsEnvironment } from "~/state/vcs";

export type WorkingTreePhase = "loading" | "ready" | "failed";

/** Only what colours the tree, so line counts changing on every edit don't re-render it. */
export const workingTreeChangesAtom = Atom.family(
  (status: ReturnType<typeof vcsEnvironment.status>) =>
    Atom.map(
      status,
      (result): { phase: WorkingTreePhase; snapshot: WorkingTreeChanges | null } => ({
        phase: AsyncResult.isInitial(result)
          ? "loading"
          : AsyncResult.isFailure(result)
            ? "failed"
            : "ready",
        // A failure keeps the last success, so a locked index doesn't blink the colours off.
        snapshot: workingTreeChanges(AsyncResult.getOrElse(result, () => null)),
      }),
    ).pipe(Atom.withEquality(Equal.equals)),
);

/**
 * Changes when the open folders may list differently: a file appears in or leaves the working
 * tree, the status starts failing (the worktree was removed), or a turn ends (new ignored files,
 * workspaces without git). Line counts alone never change it. Null until the status first loads.
 */
export function workspaceRefreshToken(
  phase: WorkingTreePhase,
  changes: ReadonlyArray<WorkingTreeChangeEntry>,
  turnCompletedAt: string | null,
): string | null {
  if (phase === "loading") return null;
  return `${phase === "failed" ? "failed" : structureToken(changes)}|${turnCompletedAt ?? ""}`;
}

function structureToken(changes: ReadonlyArray<WorkingTreeChangeEntry>): string {
  let hash = 0x811c9dc5;
  let count = 0;
  for (const { path, change } of changes) {
    if (change === "modified") continue;
    count += 1;
    const text = `${change}\u0000${path}\n`;
    for (let index = 0; index < text.length; index += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
    }
  }
  return `${count}:${(hash >>> 0).toString(36)}`;
}
