import * as Equal from "effect/Equal";
import { AsyncResult, Atom } from "effect/reactivity";

import { type WorkingTreeChangeEntry, workingTreeChanges } from "~/components/files/treeGitStatus";
import type { vcsEnvironment } from "~/state/vcs";

/** Only what colours the tree, so line counts changing on every edit don't re-render it. */
export const workingTreeChangesAtom = Atom.family(
  (status: ReturnType<typeof vcsEnvironment.status>) =>
    Atom.map(status, (result) =>
      workingTreeChanges(AsyncResult.getOrElse(result, () => null)),
    ).pipe(Atom.withEquality(Equal.equals)),
);

/**
 * Changes when a file appears in or leaves the working tree, so the listing refreshes then.
 * Null while nothing is untracked or removed.
 */
export function workingTreeStructureToken(
  changes: ReadonlyArray<WorkingTreeChangeEntry>,
): string | null {
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
  return count === 0 ? null : `${count}:${(hash >>> 0).toString(36)}`;
}
