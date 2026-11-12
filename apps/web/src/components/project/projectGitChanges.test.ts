import type { VcsStatusResult } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { workingTreeChangesAtom, workingTreeStructureToken } from "./projectGitChanges";

vi.mock("~/state/vcs", () => ({ vcsEnvironment: {} }));

const status = (files: VcsStatusResult["workingTree"]["files"]) =>
  AsyncResult.success({
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: files.length > 0,
    workingTree: { rootPath: "/repo", files, insertions: 0, deletions: 0 },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  } satisfies VcsStatusResult);

describe("workingTreeChangesAtom", () => {
  it("notifies only when a path or its kind of change does, not as line counts move", () => {
    const registry = AtomRegistry.make();
    const source = Atom.make<AsyncResult.AsyncResult<VcsStatusResult, never>>(
      status([{ path: "src/app.ts", insertions: 1, deletions: 0 }]),
    );
    const changes = workingTreeChangesAtom(source as never);
    const notified: unknown[] = [];
    const unsubscribe = registry.subscribe(changes, (value) => notified.push(value));
    registry.get(changes);
    notified.length = 0;

    registry.set(source, status([{ path: "src/app.ts", insertions: 9, deletions: 4 }]));
    expect(notified).toEqual([]);

    registry.set(
      source,
      status([
        { path: "src/app.ts", insertions: 9, deletions: 4 },
        { path: "notes.txt", insertions: 0, deletions: 0 },
      ]),
    );
    expect(notified).toHaveLength(1);
    unsubscribe();
  });
});

describe("workingTreeStructureToken", () => {
  it("changes only when a file appears in or leaves the working tree", () => {
    const edited = { path: "src/app.ts", change: "modified" } as const;
    const added = { path: "notes.txt", change: "untracked" } as const;
    const removed = { path: "old.ts", change: "linesRemoved" } as const;

    expect(workingTreeStructureToken([edited])).toBeNull();
    const withAdded = workingTreeStructureToken([edited, added]);
    expect(withAdded).not.toBeNull();
    expect(workingTreeStructureToken([added])).toBe(withAdded);
    expect(workingTreeStructureToken([added, removed])).not.toBe(withAdded);
    expect(workingTreeStructureToken([{ ...added, path: "other.txt" }])).not.toBe(withAdded);
  });
});
