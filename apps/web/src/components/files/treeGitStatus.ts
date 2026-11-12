import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import type { ProjectEntry, VcsStatusResult } from "@t3tools/contracts";
import { fileBasename, workspaceRelativeFilePath } from "@t3tools/shared/path";

/**
 * What the working-tree line counts say about a path; the status carries no change kind. Untracked
 * files and folders count 0/0, a deleted file only removes lines.
 */
export type WorkingTreeChange = "untracked" | "linesRemoved" | "modified";

export interface WorkingTreeChangeEntry {
  /** Relative to `rootPath`; an untracked folder ends in `/`. */
  readonly path: string;
  readonly change: WorkingTreeChange;
}

export interface WorkingTreeChanges {
  readonly rootPath: string;
  readonly changes: ReadonlyArray<WorkingTreeChangeEntry>;
}

function changeOf(file: { insertions: number; deletions: number }): WorkingTreeChange {
  if (file.insertions === 0) return file.deletions === 0 ? "untracked" : "linesRemoved";
  return "modified";
}

/** Null when the server did not say which root the paths are relative to (older servers). */
export function workingTreeChanges(status: VcsStatusResult | null): WorkingTreeChanges | null {
  const rootPath = status?.workingTree.rootPath;
  if (!rootPath) return null;
  return {
    rootPath,
    changes: status.workingTree.files.map((file) => ({ path: file.path, change: changeOf(file) })),
  };
}

/** The changes inside `cwd`, with paths relative to it. A workspace outside the root has none. */
export function workspaceChanges(
  snapshot: WorkingTreeChanges | null,
  cwd: string,
): ReadonlyArray<WorkingTreeChangeEntry> {
  if (!snapshot) return [];
  const workspacePath = workspaceRelativeFilePath(cwd, snapshot.rootPath);
  if (workspacePath === null) {
    // Git resolves symlinks (macOS /tmp is /private/tmp); the status came from `cwd`, so a root
    // with its name is that same folder.
    return fileBasename(cwd) === fileBasename(snapshot.rootPath) ? snapshot.changes : [];
  }
  if (workspacePath === ".") return snapshot.changes;
  const prefix = `${workspacePath.replace(/\/+$/, "")}/`;
  const result: WorkingTreeChangeEntry[] = [];
  for (const entry of snapshot.changes) {
    if (entry.path.startsWith(prefix) && entry.path.length > prefix.length) {
      result.push({ path: entry.path.slice(prefix.length), change: entry.change });
    }
  }
  return result;
}

/** Pierre's path for an entry: folders end in `/`. */
export function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function nearestAncestorIn(path: string, directories: ReadonlySet<string>): boolean {
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    if (directories.has(path.slice(0, index))) return true;
  }
  return false;
}

/**
 * The Pierre git statuses for the loaded entries. A path with no row only marks its folders, so a
 * removed file shows as `deleted` there. A change wins over `ignored`.
 */
export function treeGitStatus(
  entries: ReadonlyArray<ProjectEntry>,
  changes: ReadonlyArray<WorkingTreeChangeEntry>,
): GitStatusEntry[] {
  const statuses = new Map<string, GitStatus>();
  for (const entry of entries) {
    if (entry.ignored) statuses.set(treePath(entry), "ignored");
  }
  if (changes.length > 0) {
    const onDisk = new Set(entries.map((entry) => entry.path));
    const untrackedDirectories = new Set<string>();
    for (const { path, change } of changes) {
      if (path.endsWith("/")) {
        statuses.set(path, "untracked");
        untrackedDirectories.add(path.slice(0, -1));
        continue;
      }
      const status: GitStatus =
        change === "untracked"
          ? "untracked"
          : change === "linesRemoved" && !onDisk.has(path)
            ? "deleted"
            : "modified";
      statuses.set(path, status);
    }
    // Git lists an untracked folder once; everything loaded under it is untracked too.
    if (untrackedDirectories.size > 0) {
      for (const entry of entries) {
        const path = treePath(entry);
        if (!statuses.has(path) && nearestAncestorIn(entry.path, untrackedDirectories)) {
          statuses.set(path, "untracked");
        }
      }
    }
  }
  return Array.from(statuses, ([path, status]) => ({ path, status }));
}
