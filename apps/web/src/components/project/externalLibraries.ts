import type { CodeServerStatus } from "@t3tools/contracts";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";

/** Roots shown before the rest fold behind a count: a monorepo lists each package's node_modules. */
export const SHOWN_LIBRARY_ROOTS = 4;

/** A library folder the workspace's language servers read, under its own top-level tree node. */
export interface ExternalLibraryRoot {
  /** Absolute. */
  readonly path: string;
  /** The top-level node's name: unique, and without "/", which would nest it in the tree. */
  readonly label: string;
}

/**
 * The library roots worth showing, once each. A server whose only roots are stubs adds none:
 * ty's cached typeshed is there for every project, Python or not.
 */
export function externalLibraryRoots(
  servers: ReadonlyArray<CodeServerStatus>,
): ExternalLibraryRoot[] {
  const roots = new Map<string, ExternalLibraryRoot>();
  const labels = new Set<string>();
  for (const server of servers) {
    if (server.libraryRoots.every((root) => root.kind === "stubs")) continue;
    for (const root of server.libraryRoots) {
      if (roots.has(root.path)) continue;
      // U+2215 DIVISION SLASH reads as "/" without splitting the node.
      const base = root.label.replaceAll("/", "∕");
      let label = base;
      for (let copy = 2; labels.has(label); copy++) label = `${base} (${copy})`;
      labels.add(label);
      roots.set(root.path, { path: root.path, label });
    }
  }
  return [...roots.values()];
}

/** The root a tree path lies under, and the path below it ("" for the root's own node). */
export function libraryLocation(
  roots: ReadonlyArray<ExternalLibraryRoot>,
  treePath: string,
): { readonly root: ExternalLibraryRoot; readonly relativePath: string } | null {
  const path = treePath.replace(/\/$/, "");
  const slash = path.indexOf("/");
  const label = slash === -1 ? path : path.slice(0, slash);
  const root = roots.find((candidate) => candidate.label === label);
  if (!root) return null;
  return { root, relativePath: slash === -1 ? "" : path.slice(slash + 1) };
}

/**
 * Where a folder under a root is listed, and the prefix to strip from what comes back. A root
 * inside the workspace lists through it: pnpm links each package's node_modules into the root
 * one, and a listing drops links that leave its cwd.
 */
export function libraryListing(
  root: ExternalLibraryRoot,
  relativePath: string,
  workspace: string,
): { readonly cwd: string; readonly directoryPath: string; readonly prefix: string } {
  const inWorkspace = workspaceRelativeFilePath(root.path, workspace);
  if (inWorkspace === null || inWorkspace === ".") {
    return { cwd: root.path, directoryPath: relativePath, prefix: "" };
  }
  return {
    cwd: workspace,
    directoryPath: relativePath === "" ? inWorkspace : `${inWorkspace}/${relativePath}`,
    prefix: `${inWorkspace}/`,
  };
}
