import type { VcsStatusResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { workingTreeChangesAtom, workspaceRefreshToken } from "./projectGitChanges";

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
  it("notifies only when a path, its kind of change or the status phase does, not as line counts move", () => {
    const registry = AtomRegistry.make();
    const source = Atom.make<AsyncResult.AsyncResult<VcsStatusResult, string>>(
      AsyncResult.initial(),
    );
    const changes = workingTreeChangesAtom(source as never);
    const notified: unknown[] = [];
    const unsubscribe = registry.subscribe(changes, (value) => notified.push(value));
    expect(registry.get(changes)).toEqual({ phase: "loading", snapshot: null });

    const edited = status([{ path: "src/app.ts", insertions: 1, deletions: 0 }]);
    registry.set(source, edited);
    expect(registry.get(changes).phase).toBe("ready");
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

    // A failed refresh keeps the last colours.
    registry.set(
      source,
      AsyncResult.failWithPrevious("worktree removed", { previous: Option.some(edited) }),
    );
    expect(registry.get(changes).phase).toBe("failed");
    expect(registry.get(changes).snapshot?.changes).toEqual([
      { path: "src/app.ts", change: "modified" },
    ]);
    unsubscribe();
  });
});

describe("workspaceRefreshToken", () => {
  const edited = { path: "src/app.ts", change: "modified" } as const;
  const added = { path: "notes.txt", change: "untracked" } as const;
  const removed = { path: "old.ts", change: "linesRemoved" } as const;

  it("is unknown until the status first loads", () => {
    expect(workspaceRefreshToken("loading", [added], "t1")).toBeNull();
  });

  it("changes when a file appears in or leaves the working tree, the last one included", () => {
    const clean = workspaceRefreshToken("ready", [], null);
    expect(clean).not.toBeNull();
    expect(workspaceRefreshToken("ready", [edited], null)).toBe(clean);
    const withAdded = workspaceRefreshToken("ready", [edited, added], null);
    expect(withAdded).not.toBe(clean);
    expect(workspaceRefreshToken("ready", [added], null)).toBe(withAdded);
    expect(workspaceRefreshToken("ready", [added, removed], null)).not.toBe(withAdded);
    expect(workspaceRefreshToken("ready", [{ ...added, path: "other.txt" }], null)).not.toBe(
      withAdded,
    );
  });

  it("changes when the status starts failing and when a turn ends", () => {
    const ready = workspaceRefreshToken("ready", [added], "t1");
    expect(workspaceRefreshToken("failed", [added], "t1")).not.toBe(ready);
    expect(workspaceRefreshToken("ready", [added], "t2")).not.toBe(ready);
  });
});
