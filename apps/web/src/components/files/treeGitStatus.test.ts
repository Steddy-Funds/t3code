import type { ProjectEntry, VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { treeGitStatus, workingTreeChanges, workspaceChanges } from "./treeGitStatus";

const status = (rootPath: string | undefined, files: VcsStatusResult["workingTree"]["files"]) =>
  ({
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: files.length > 0,
    workingTree: { ...(rootPath ? { rootPath } : {}), files, insertions: 0, deletions: 0 },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  }) as VcsStatusResult;

const byPath = (entries: ReturnType<typeof treeGitStatus>) =>
  Object.fromEntries(entries.map((entry) => [entry.path, entry.status]));

describe("treeGitStatus", () => {
  it("colours each change from its line counts and whether it is still on disk", () => {
    const entries: ProjectEntry[] = [
      { path: "src", kind: "directory" },
      { path: "src/edited.ts", kind: "file" },
      { path: "src/trimmed.ts", kind: "file" },
      { path: "src/new.ts", kind: "file" },
      { path: "dist", kind: "directory", ignored: true },
      { path: "fresh", kind: "directory" },
      { path: "fresh/a.ts", kind: "file" },
      { path: "fresh/deep", kind: "directory" },
      { path: "fresh/deep/b.ts", kind: "file" },
      { path: "fresh/cache.log", kind: "file", ignored: true },
      { path: ".env", kind: "file", ignored: true },
    ];
    const snapshot = workingTreeChanges(
      status("/repo", [
        { path: "src/edited.ts", insertions: 3, deletions: 1 },
        { path: "src/trimmed.ts", insertions: 0, deletions: 4 },
        { path: "src/new.ts", insertions: 0, deletions: 0 },
        { path: "src/gone.ts", insertions: 0, deletions: 9 },
        { path: "fresh/", insertions: 0, deletions: 0 },
        { path: ".env", insertions: 1, deletions: 0 },
      ]),
    );

    expect(byPath(treeGitStatus(entries, workspaceChanges(snapshot, "/repo")))).toEqual({
      "src/edited.ts": "modified",
      "src/trimmed.ts": "modified",
      "src/new.ts": "untracked",
      "src/gone.ts": "deleted",
      "dist/": "ignored",
      "fresh/": "untracked",
      "fresh/a.ts": "untracked",
      "fresh/deep/": "untracked",
      "fresh/deep/b.ts": "untracked",
      "fresh/cache.log": "ignored",
      ".env": "modified",
    });
  });

  it("keeps only ignored entries when there are no changes", () => {
    const entries: ProjectEntry[] = [
      { path: "node_modules", kind: "directory", ignored: true },
      { path: "README.md", kind: "file" },
    ];
    expect(treeGitStatus(entries, [])).toEqual([{ path: "node_modules/", status: "ignored" }]);
  });
});

describe("workspaceChanges", () => {
  const snapshot = workingTreeChanges(
    status("/repo", [
      { path: "README.md", insertions: 1, deletions: 0 },
      { path: "apps/web/src/main.ts", insertions: 2, deletions: 2 },
      { path: "apps/web/new/", insertions: 0, deletions: 0 },
      { path: "apps/webby/x.ts", insertions: 1, deletions: 0 },
    ]),
  );

  it("re-roots repository paths at a workspace inside the repository", () => {
    expect(workspaceChanges(snapshot, "/repo/apps/web/")).toEqual([
      { path: "src/main.ts", change: "modified" },
      { path: "new/", change: "untracked" },
    ]);
    expect(workspaceChanges(snapshot, "/repo/")).toHaveLength(4);
  });

  it("has nothing for a workspace outside the root or a status with no root", () => {
    expect(workspaceChanges(snapshot, "/elsewhere")).toEqual([]);
    expect(workspaceChanges(snapshot, "/repository")).toEqual([]);
    expect(
      workingTreeChanges(status(undefined, [{ path: "a.ts", insertions: 1, deletions: 0 }])),
    ).toBeNull();
  });

  it("takes a workspace reached through a symlink as the root git resolved", () => {
    const physical = workingTreeChanges(
      status("/private/tmp/demo", [{ path: "a.ts", insertions: 1, deletions: 0 }]),
    );
    expect(workspaceChanges(physical, "/tmp/demo/")).toEqual([
      { path: "a.ts", change: "modified" },
    ]);
  });

  it("matches Windows roots regardless of case and separators", () => {
    const windows = workingTreeChanges(
      status("C:\\Code\\Repo", [{ path: "pkg/a.ts", insertions: 1, deletions: 0 }]),
    );
    expect(workspaceChanges(windows, "c:/code/repo/pkg")).toEqual([
      { path: "a.ts", change: "modified" },
    ]);
  });
});
