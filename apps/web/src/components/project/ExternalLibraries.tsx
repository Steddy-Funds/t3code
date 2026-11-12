import { FileTree, useFileTree } from "@pierre/trees/react";
import { isCodeIntelUnsupportedError } from "@t3tools/client-runtime/state/code-intel";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectEntry, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { joinHostPath } from "~/components/files/filePath";
import { buildFileTreePathUpdates } from "~/components/files/fileTreePathReconciliation";
import { CollapsibleSectionHeader } from "~/components/ui/collapsible-section-header";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { codeIntelEnvironment } from "~/state/codeIntel";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";

import {
  type ExternalLibraryRoot,
  externalLibraryRoots,
  type LibraryListing,
  libraryListings,
  libraryLocation,
  SHOWN_LIBRARY_ROOTS,
} from "./externalLibraries";

function parentOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

/** Lists library folders as they open. Paths are tree paths: the root's label, then its own. */
function useLibraryEntries(
  environmentId: EnvironmentId,
  workspace: string,
  roots: ReadonlyArray<ExternalLibraryRoot>,
) {
  const [listed, setListed] = useState(new Map<string, readonly ProjectEntry[]>());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const requested = useRef(new Set<string>());

  const without = (set: ReadonlySet<string>, path: string) => {
    const next = new Set(set);
    next.delete(path);
    return next;
  };

  const listFirst = async (listings: ReadonlyArray<LibraryListing>) => {
    for (const listing of listings) {
      const atom = projectEnvironment.listEntries({
        environmentId,
        input: { cwd: listing.cwd, directoryPath: listing.directoryPath },
      });
      // One at a time: the next is only for a listing the server refused.
      const result = await executeAtomQuery(appAtomRegistry, atom, {
        refresh: true,
        reportFailure: false,
        reportDefect: false,
      });
      if (result._tag === "Success") return { listing, entries: result.value.entries };
    }
    return null;
  };

  const load = (directory: string) => {
    const location = libraryLocation(roots, directory);
    if (location === null || requested.current.has(directory)) return;
    requested.current.add(directory);
    setLoading((previous) => new Set(previous).add(directory));
    setFailed((previous) => without(previous, directory));
    const { root, relativePath } = location;
    void listFirst(libraryListings(root, relativePath, workspace)).then((result) => {
      setLoading((previous) => without(previous, directory));
      // A failed folder stays requested until Retry, so tree events don't ask for it again.
      if (result === null) {
        setFailed((previous) => new Set(previous).add(directory));
        return;
      }
      const { listing, entries } = result;
      const children = entries
        .filter((entry) => parentOf(entry.path) === listing.directoryPath)
        .map((entry) => ({
          ...entry,
          path: `${root.label}/${entry.path.slice(listing.prefix.length)}`,
        }));
      setListed((previous) => new Map(previous).set(directory, children));
    });
  };

  const retry = () => {
    for (const directory of failed) {
      requested.current.delete(directory);
      load(directory);
    }
  };

  const kinds = new Map<string, ProjectEntry["kind"]>();
  const treePaths: string[] = [];
  const visit = (directory: string) => {
    for (const entry of listed.get(directory) ?? []) {
      kinds.set(entry.path, entry.kind);
      treePaths.push(entry.kind === "directory" ? `${entry.path}/` : entry.path);
      if (entry.kind === "directory") visit(entry.path);
    }
  };
  for (const root of roots) {
    treePaths.push(`${root.label}/`);
    visit(root.label);
  }
  return { kinds, treePaths, load, loading, failed: failed.size > 0, retry };
}

function LibraryTree({
  environmentId,
  cwd,
  threadRef,
  roots,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  threadRef: ScopedThreadRef;
  roots: ReadonlyArray<ExternalLibraryRoot>;
}) {
  const { resolvedTheme } = useTheme();
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? roots : roots.slice(0, SHOWN_LIBRARY_ROOTS);
  const { kinds, treePaths, load, loading, failed, retry } = useLibraryEntries(
    environmentId,
    cwd,
    shown,
  );
  const kindsRef = useRef(kinds);
  const loadingRef = useRef(loading);
  const previousTreePathsRef = useRef<readonly string[] | null>(null);
  // The model keeps its first options, and the Project pane keeps this tree across threads.
  const openSelected = useStableCallback((selectedPaths: readonly string[]) => {
    const selected = selectedPaths.at(-1)?.replace(/\/$/, "");
    if (!selected || kindsRef.current.get(selected) !== "file") return;
    const location = libraryLocation(roots, selected);
    if (location === null) return;
    useRightPanelStore
      .getState()
      .openFile(threadRef, joinHostPath(location.root.path, location.relativePath));
  });
  const { model } = useFileTree({
    density: "compact",
    // Keeps each root its own row; a root with one folder would otherwise merge into it.
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: openSelected,
    paths: [],
    renderRowDecoration: ({ item, row }) =>
      row.kind === "directory" &&
      row.isExpanded &&
      loadingRef.current.has(item.path.replace(/\/$/, ""))
        ? { icon: "t3-tree-icon-loading", title: "Loading…" }
        : null,
    search: false,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies listed folders to the imperative Pierre tree model
  useEffect(() => {
    kindsRef.current = kinds;
    const previous = previousTreePathsRef.current;
    if (previous === treePaths) return;
    previousTreePathsRef.current = treePaths;
    if (previous === null) {
      model.resetPaths(treePaths);
      return;
    }
    const updates = buildFileTreePathUpdates(previous, treePaths);
    if (updates.length > 0) model.batch(updates);
  }, [kinds, model, treePaths]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- makes the Pierre tree model re-render row decorations when loading folders change
  useEffect(() => {
    if (loadingRef.current === loading) return;
    loadingRef.current = loading;
    model.setComposition(model.getComposition());
  }, [loading, model]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the Pierre tree model to list folders as they are expanded
  useEffect(() => {
    const loadExpanded = () => {
      for (const path of treePaths) {
        if (!path.endsWith("/")) continue;
        const item = model.getItem(path);
        if (item?.isDirectory() && "isExpanded" in item && item.isExpanded()) {
          load(path.slice(0, -1));
        }
      }
    };
    loadExpanded();
    return model.subscribe(loadExpanded);
  }, [load, model, treePaths]);

  return (
    <>
      {failed ? (
        <button
          type="button"
          onClick={retry}
          className="px-3 py-1 text-left text-xs text-destructive"
        >
          Some library folders couldn't be listed. Click to retry.
        </button>
      ) : null}
      <FileTree
        model={model}
        aria-label="External libraries"
        className="min-h-0 flex-1 overflow-hidden"
        style={pierreTreeStyle(resolvedTheme)}
      />
      {shown.length < roots.length ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="self-start px-3 py-1 text-2xs text-muted-foreground hover:text-foreground"
        >
          {roots.length - shown.length} more
        </button>
      ) : null}
    </>
  );
}

/**
 * The library folders the workspace's language servers read (a virtualenv, the standard library,
 * node_modules), browsable below the workspace tree. Hidden when there are none; files open
 * read-only, like a jump into library code.
 */
export default function ExternalLibraries({
  environmentId,
  cwd,
  threadRef,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  threadRef: ScopedThreadRef;
}) {
  const [expanded, setExpanded] = useState(false);
  // A server older than code intel refuses status for good; stop asking it.
  const [unsupportedIn, setUnsupportedIn] = useState<EnvironmentId | null>(null);
  const unsupported = unsupportedIn === environmentId;
  const status = useEnvironmentQuery(
    unsupported ? null : codeIntelEnvironment.status({ environmentId, input: { cwd } }),
  );
  if (!unsupported && isCodeIntelUnsupportedError(status.failure)) setUnsupportedIn(environmentId);
  const roots = externalLibraryRoots(status.data?.servers ?? []);
  if (roots.length === 0) return null;

  return (
    <div
      className={
        expanded
          ? "flex h-2/5 min-h-0 shrink-0 flex-col border-t border-border/60 px-0.5"
          : "shrink-0 border-t border-border/60 px-0.5"
      }
    >
      <CollapsibleSectionHeader expanded={expanded} onClick={() => setExpanded(!expanded)}>
        External Libraries
      </CollapsibleSectionHeader>
      {expanded ? (
        <LibraryTree
          key={roots.map((root) => `${root.label}\n${root.path}`).join("\n")}
          environmentId={environmentId}
          cwd={cwd}
          threadRef={threadRef}
          roots={roots}
        />
      ) : null}
    </div>
  );
}
