import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  FILE_TREE_TAG_NAME,
  type ContextMenuItem as TreeContextMenuItem,
  type ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { EnvironmentId, ProjectEntriesFailure, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";
import { ChevronsDownUpIcon, LocateFixedIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { MorphIcon } from "~/components/MorphIcon";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useFileContextMenu, type FileContextMenuAction } from "~/fileContextMenu";
import { usePaintedThemeEditorColors } from "~/lib/paintedThemeEditorColors";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { cn } from "~/lib/utils";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { joinHostPath } from "./filePath";
import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";
import { buildFileTreePathUpdates } from "./fileTreePathReconciliation";
import { loadFileAncestors } from "./loadFileAncestors";
import { treeGitStatus, treePath, type WorkingTreeChangeEntry } from "./treeGitStatus";
import { useDirectoryEntries } from "./useDirectoryEntries";
import { useProjectPathSearch } from "~/state/queries";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  selectedPath: string | null;
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  /** Host-folder entries use absolute paths. Avoid full traversal: disable expand-all and search only
   * loaded folders. */
  hostFolder?: boolean;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
  /** The left sidebar's Project pane. Without it the panel is the right panel's file tree. */
  projectPane?: ProjectPaneOptions;
}

export interface ProjectPaneOptions {
  /** Workspace-relative changes that colour the names. */
  readonly gitChanges: ReadonlyArray<WorkingTreeChangeEntry>;
  /** The tree takes keyboard focus, at the selected path when it has one, then reports it. */
  readonly focusPending: boolean;
  readonly onTreeFocused: () => void;
  readonly onSelectOpenedFile: () => void;
  readonly selectOpenedFileShortcut: string | null;
}

function rootFailureMessage(failure: ProjectEntriesFailure | null): string | null {
  switch (failure) {
    case "workspace_root_not_found":
      return "This folder no longer exists. Its worktree may have been removed.";
    case "workspace_root_not_directory":
      return "This path is no longer a folder.";
    case "workspace_root_stat_failed":
    case "directory_list_failed":
      return "This folder can't be read.";
    default:
      return null;
  }
}

function treeHost(container: HTMLElement | null): Element | null {
  return container?.querySelector(FILE_TREE_TAG_NAME) ?? null;
}

/** Moves keyboard focus to a row once Pierre has mounted it; a reveal mounts it a frame later. */
function focusTreeRow(container: HTMLElement | null, path: string, attempts = 4): void {
  const row = treeHost(container)?.shadowRoot?.querySelector<HTMLElement>(
    `[data-item-path="${CSS.escape(path)}"]:not([data-file-tree-sticky-row="true"])`,
  );
  if (row) {
    row.focus({ preventScroll: true });
    return;
  }
  if (attempts > 0) requestAnimationFrame(() => focusTreeRow(container, path, attempts - 1));
}

function isTypingKey(event: KeyboardEvent): boolean {
  return (
    event.key.length === 1 &&
    event.key !== " " &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.nativeEvent.isComposing
  );
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RefreshIcon refreshing={props.isPending} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  /** Leaves the field for the tree's rows. */
  onArrowDown?: () => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        data-workspace-focus-default
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && props.onArrowDown) {
            event.preventDefault();
            props.onArrowDown();
            return;
          }
          if (event.key !== "Escape") return;
          props.onClose();
          if (props.onArrowDown) props.onArrowDown();
          else event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

function buildTreeEntries(
  directoryEntries: readonly ProjectEntry[],
  searchEntries: readonly ProjectEntry[],
  searchPending: boolean,
  query: string,
) {
  const result = new Map(directoryEntries.map((entry) => [entry.path, entry]));
  if (query.trim() && !searchPending) {
    for (const entry of searchEntries) {
      if (!result.has(entry.path)) result.set(entry.path, entry);
      const segments = entry.path.split("/");
      for (let index = 1; index < segments.length; index++) {
        const path = segments.slice(0, index).join("/");
        if (!result.has(path)) result.set(path, { path, kind: "directory" });
      }
    }
  }
  const entries = [...result.values()];
  const entryKinds: ReadonlyMap<string, ProjectEntry["kind"]> = new Map(
    entries.map((entry) => [entry.path, entry.kind] as const),
  );
  const treePaths = entries.map(treePath);
  const directories = entries.filter((entry) => entry.kind === "directory");
  const directoryPaths = directories.map(treePath);
  // Expanding a folder lists it, and an ignored one such as `node_modules` can hold tens of
  // thousands, so expand all skips ignored folders. They still open by hand.
  const expandableDirectoryPaths = directories.filter((entry) => !entry.ignored).map(treePath);
  return { entries, entryKinds, treePaths, directoryPaths, expandableDirectoryPaths };
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onRefreshSelectedFile,
  workspaceMutationId,
  hostFolder = false,
  projectPane,
}: FileBrowserPanelProps) {
  const panelPath = (relativePath: string) =>
    hostFolder ? joinHostPath(cwd, relativePath) : relativePath;
  const { resolvedTheme } = useTheme();
  const fileStatusColors = usePaintedThemeEditorColors()?.fileStatus;
  const composerRef = useComposerHandleContext();
  const fileContextMenu = useFileContextMenu(environmentId);
  const {
    entries: directoryEntries,
    load,
    refresh,
    ready,
    error,
    rootFailure,
    isPending,
    loadingDirectories,
  } = useDirectoryEntries(environmentId, cwd);
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  const pathSearch = useProjectPathSearch(
    { environmentId, cwd: hostFolder ? null : cwd, query: query.slice(0, 256) },
    200,
  );
  const { entries, entryKinds, treePaths, directoryPaths, expandableDirectoryPaths } =
    buildTreeEntries(directoryEntries, pathSearch.entries, pathSearch.isPending, query);
  const entryKindsRef = useRef(entryKinds);
  const previousTreePathsRef = useRef<readonly string[] | null>(null);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);

  // Shadow-DOM row rects are unreliable; capture the composed contextmenu event's viewport position.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);

  // The model keeps its first options, and the Project pane keeps this tree across threads.
  const openFile = useStableCallback(onOpenFile);
  const showEntryContextMenu = useStableCallback(
    (item: TreeContextMenuItem, context: TreeContextMenuOpenContext) => {
      const api = readLocalApi();
      if (!api) {
        context.close();
        return;
      }
      const relativePath = item.path.replace(/\/$/, "");
      const mention = serializeComposerFileLink(panelPath(relativePath));
      const pointer = contextMenuPointerRef.current;
      const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
      const anchorRect = context.anchorElement.getBoundingClientRect();
      const position = pointerIsFresh
        ? { x: pointer.x, y: pointer.y }
        : { x: anchorRect.left, y: anchorRect.bottom };
      const fileTarget = { environmentId, filePath: relativePath, workspaceRoot: cwd };
      const fileMenuItems = fileContextMenu.buildItems(fileTarget);
      // The app menu owns focus; the tree's outside-click handler would dismiss it before click.
      context.close({ restoreFocus: !pointerIsFresh });
      void settlePromise(async () => {
        const clicked = await api.contextMenu.show(
          [
            ...fileMenuItems,
            { id: "copy-mention", label: "Copy mention" },
            { id: "add-to-chat", label: "Add to chat" },
          ],
          position,
        );
        if (clicked === null) return;
        // Open-with submenu ids are absent from the top-level item list.
        const isFileMenuAction =
          fileMenuItems.some((entry) => entry.id === clicked) || clicked.startsWith("editor:");
        if (isFileMenuAction) {
          await fileContextMenu.activate(clicked as FileContextMenuAction, fileTarget);
          return;
        }
        if (clicked === "copy-mention") {
          try {
            await writeTextToClipboard(mention);
            toastManager.add({
              type: "success",
              title: "Mention copied",
              description: relativePath,
            });
          } catch (error) {
            toastManager.add({
              type: "error",
              title: "Failed to copy mention",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          }
          return;
        }
        if (clicked === "add-to-chat") {
          const composer = composerRef?.current;
          if (!composer) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "Open a chat for this project and try again.",
            });
            return;
          }
          const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
          if (!inserted) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "The chat isn't ready to accept input right now.",
            });
          }
        }
      }).then((result) => {
        if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
      });
    },
  );

  const loadingDirectoriesRef = useRef(loadingDirectories);
  const dragMention = createFileTreeDragMentionController(
    hostFolder ? { mentionPath: (path: string) => joinHostPath(cwd, path) } : {},
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          showEntryContextMenu(item, context);
        },
      },
    },
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // Update drag selection even for reveals so subsequent drags cannot use stale paths.
      dragMention.handleSelectionChange(selectedPaths);
      if (syncingSelectionRef.current) return;
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        openFile(panelPath(selectedPath));
      }
    },
    paths: [],
    renderRowDecoration: ({ item, row }) =>
      row.kind === "directory" &&
      row.isExpanded &&
      loadingDirectoriesRef.current.has(item.path.replace(/\/$/, ""))
        ? { icon: "t3-tree-icon-loading", title: "Loading…" }
        : null,
    search: false,
    onSearchChange: (value) => setQuery(value ?? ""),
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- makes the Pierre tree model re-render row decorations when loading directories change
  useEffect(() => {
    if (loadingDirectoriesRef.current === loadingDirectories) return;
    loadingDirectoriesRef.current = loadingDirectories;
    model.setComposition(model.getComposition());
  }, [loadingDirectories, model]);
  const search = useFileTreeSearch(model);
  // Pierre restores the unfiltered tree when a search has no matches.
  const hasNoSearchMatches = search.value.trim().length > 0 && search.matchingPaths.length === 0;
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, expandableDirectoryPaths),
  );
  const toggleAllDirectories = () => {
    const expanded = !(expandAll || allDirectoriesExpanded);
    setExpandAll(expanded);
    setAllDirectoriesExpanded(
      model,
      expanded ? expandableDirectoryPaths : directoryPaths,
      expanded,
    );
  };
  const closeSearch = () => {
    setQuery("");
    search.close();
  };
  const expandedPathsRef = useRef(new Set<string>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the Pierre tree model to load directories as they are expanded
  useEffect(() => {
    const currentPaths = new Set(directoryPaths);
    for (const path of expandedPathsRef.current) {
      if (!currentPaths.has(path)) expandedPathsRef.current.delete(path);
    }
    const loadExpanded = () => {
      if (model.isSearchOpen()) return;
      for (const path of directoryPaths) {
        const item = model.getItem(path);
        if (item?.isDirectory() && "isExpanded" in item && item.isExpanded()) {
          if (!expandedPathsRef.current.has(path)) {
            expandedPathsRef.current.add(path);
            void load(path.replace(/\/$/, ""));
          }
        } else {
          if (item?.isDirectory() && expandedPathsRef.current.has(path)) setExpandAll(false);
          expandedPathsRef.current.delete(path);
        }
      }
    };
    loadExpanded();
    return model.subscribe(loadExpanded);
  }, [directoryPaths, load, model]);
  const gitChanges = projectPane?.gitChanges;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes git statuses into the imperative Pierre tree model
  useEffect(() => {
    model.setGitStatus(treeGitStatus(entries, gitChanges ?? []));
  }, [entries, gitChanges, model]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the selected file's ancestor directories and aborts on cleanup
  useEffect(() => {
    if (!selectedPath) return;
    const controller = new AbortController();
    void loadFileAncestors(selectedPath, load, { signal: controller.signal });
    return () => {
      controller.abort();
    };
  }, [load, selectedPath]);
  const handleSearchValueChange = (value: string) => {
    setQuery(value);
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };
  const handleRefresh = () => {
    refresh();
    if (query.trim()) pathSearch.refresh();
    onRefreshSelectedFile?.();
  };
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: () => {
      refresh();
      if (query.trim()) pathSearch.refresh();
    },
    resourceKey: `files:${environmentId}:${cwd}`,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies tree path changes to the imperative Pierre tree model as a reset or batch update
  useEffect(() => {
    if (!ready) return;
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    const previousTreePaths = previousTreePathsRef.current;
    previousTreePathsRef.current = treePaths;
    if (previousTreePaths === null) {
      model.resetPaths(treePaths);
      return;
    }
    const updates = buildFileTreePathUpdates(previousTreePaths, treePaths);
    if (updates.length > 0) model.batch(updates);
  }, [ready, entryKinds, model, treePaths]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands every directory in the Pierre tree model while expand-all is on and no search is active
  useEffect(() => {
    if (expandAll && !query.trim())
      setAllDirectoriesExpanded(model, expandableDirectoryPaths, true);
  }, [expandableDirectoryPaths, expandAll, model, query]);

  const revealInTree = (path: string, kind: ProjectEntry["kind"], follow: boolean) => {
    const selectedTreePath = kind === "directory" ? `${path}/` : path;
    const selectedItem = model.getItem(selectedTreePath);
    if (!selectedItem) return null;
    syncingSelectionRef.current = true;
    if (!follow) {
      setQuery("");
      model.closeSearch();
    }
    for (const selected of model.getSelectedPaths()) {
      model.getItem(selected)?.deselect();
    }

    // Directory paths include trailing slashes; ancestor lookups must match.
    const segments = path.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    if ("expand" in selectedItem) selectedItem.expand();
    selectedItem.select();
    model.scrollToPath(selectedTreePath, {
      focus: true,
      offset: follow ? "nearest" : "center",
    });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
    return selectedTreePath;
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals an externally selected path in the Pierre tree model by expanding, selecting and scrolling
  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const selectedKind = entryKinds.get(selectedPath);
    if (selectedKind === undefined) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // Refresh rebuilds treePaths; replaying handled reveals would close search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    if (!model.getItem(selectedKind === "directory" ? `${selectedPath}/` : selectedPath)) return;

    // Reveal only external selections; tree selections are visible and re-revealing would close search.
    const selectedInTree = model
      .getSelectedPaths()
      .some((path) => path.replace(/\/$/, "") === selectedPath);
    if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      return;
    }
    // The Project pane follows the opened file without closing a search the user is typing; it
    // reveals the file once the search closes.
    const follow = projectPane !== undefined;
    if (follow && query.trim()) return;
    treeSelectionPathRef.current = null;
    handledRevealRef.current = revealRequest;
    // oxlint-disable-next-line react/set-state-in-effect -- a selection made outside the tree closes its search, whose text this state mirrors
    revealInTree(selectedPath, selectedKind, follow);
  }, [entryKinds, model, projectPane, query, revealInTree, selectedPath, selectedPathRevealId]);

  const focusPending = projectPane?.focusPending ?? false;
  const onTreeFocused = projectPane?.onTreeFocused;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves keyboard focus into the imperative Pierre tree once the requested path has loaded
  useEffect(() => {
    if (!focusPending || !onTreeFocused) return;
    const container = rootRef.current;
    if (error) {
      container?.querySelector<HTMLElement>("[data-project-tree-retry]")?.focus();
      onTreeFocused();
      return;
    }
    if (!ready) return;
    const selectedKind = selectedPath ? entryKinds.get(selectedPath) : undefined;
    // The selected file's folders are still loading; the reveal waits for them.
    if (selectedPath && selectedKind === undefined && loadingDirectories.size > 0) return;
    let revealed: string | null = null;
    if (selectedPath && selectedKind !== undefined) {
      // oxlint-disable-next-line react/set-state-in-effect -- a focus request from a shortcut closes the tree's search, whose text this state mirrors
      revealed = revealInTree(selectedPath, selectedKind, false);
    }
    if (selectedPath && revealed)
      handledRevealRef.current = { path: selectedPath, revealId: selectedPathRevealId };
    const target =
      revealed ??
      model.getFocusedPath() ??
      model.getSelectedPaths().at(-1) ??
      model.getVisibleRows(0, 0)[0]?.path ??
      null;
    if (target === null) {
      container?.querySelector<HTMLElement>('input[type="search"]')?.focus();
    } else {
      if (!revealed) model.scrollToPath(target, { focus: true, offset: "nearest" });
      focusTreeRow(container, target);
    }
    onTreeFocused();
  }, [
    entryKinds,
    error,
    focusPending,
    loadingDirectories,
    model,
    onTreeFocused,
    ready,
    revealInTree,
    selectedPath,
    selectedPathRevealId,
  ]);

  const focusTree = () => {
    const target =
      model.getFocusedPath() ??
      model.getSelectedPaths().at(-1) ??
      model.getVisibleRows(0, 0)[0]?.path ??
      null;
    if (target === null) return;
    model.scrollToPath(target, { focus: true, offset: "nearest" });
    focusTreeRow(rootRef.current, target);
  };
  // Typing on a row starts a search, as in JetBrains' Project view.
  const searchFromTree = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isTypingKey(event) || event.target !== treeHost(rootRef.current)) return;
    event.preventDefault();
    rootRef.current?.querySelector<HTMLElement>('input[type="search"]')?.focus();
    handleSearchValueChange(event.key);
  };
  const collapseAllDirectories = () => {
    setExpandAll(false);
    setAllDirectoriesExpanded(model, directoryPaths, false);
  };
  const rootError = projectPane ? rootFailureMessage(rootFailure) : null;
  const isEmptyFolder =
    projectPane !== undefined && ready && !error && !query.trim() && entries.length === 0;

  return (
    <div
      ref={rootRef}
      className={cn("flex min-h-0 flex-1 flex-col", !projectPane && "bg-background")}
      data-file-browser-panel={`${environmentId}:${cwd}`}
      onKeyDown={projectPane ? searchFromTree : undefined}
      // Capture runs before the tree's shadow-internal row handler opens the menu.
      onContextMenuCapture={(event) => {
        contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
      }}
      // Capture dragstart before the tree selects the row so selection sees the drag flag.
      onDragStartCapture={(event) => dragMention.handleDragStart(event.nativeEvent)}
      onDragEnd={() => dragMention.handleDragEnd((path) => model.getItem(path)?.deselect())}
    >
      <div
        className={cn(
          "flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2 in-data-[preview-panel-mode=inline]:mb-1 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9 in-data-[preview-panel-mode=inline]:border-b-transparent",
          !projectPane && "bg-background",
        )}
        data-surface-subheader
      >
        <RefreshFilesButton isPending={isPending} onRefresh={handleRefresh} />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={closeSearch}
          {...(projectPane ? { onArrowDown: focusTree } : {})}
        />
        {projectPane ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Select opened file"
                    disabled={!selectedPath}
                    onClick={projectPane.onSelectOpenedFile}
                  />
                }
              >
                <LocateFixedIcon />
              </TooltipTrigger>
              <TooltipPopup>
                Select opened file
                {projectPane.selectOpenedFileShortcut
                  ? ` (${projectPane.selectOpenedFileShortcut})`
                  : ""}
              </TooltipPopup>
            </Tooltip>
            {directoryPaths.length > 0 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label="Collapse all folders"
                      onClick={collapseAllDirectories}
                    />
                  }
                >
                  <ChevronsDownUpIcon />
                </TooltipTrigger>
                <TooltipPopup>Collapse all folders</TooltipPopup>
              </Tooltip>
            ) : null}
          </>
        ) : directoryPaths.length > 0 && !hostFolder ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    expandAll || allDirectoriesExpanded
                      ? "Collapse all folders"
                      : "Expand all folders"
                  }
                  onClick={toggleAllDirectories}
                />
              }
            >
              <MorphIcon
                className="size-3.5"
                icon={allDirectoriesExpanded ? ChevronsDownUp : ChevronsUpDown}
              />
            </TooltipTrigger>
            <TooltipPopup>
              {expandAll || allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {rootError ? (
        <div role="alert" className="flex items-center gap-2 px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 text-destructive">{rootError}</span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-project-tree-retry
            onClick={handleRefresh}
          >
            Retry
          </Button>
        </div>
      ) : error || pathSearch.error ? (
        <button
          {...(projectPane ? { "data-project-tree-retry": "" } : {})}
          type="button"
          onClick={handleRefresh}
          className="p-4 text-left text-xs leading-relaxed text-destructive"
        >
          {error ?? pathSearch.error} Click to retry.
        </button>
      ) : null}
      {query.trim() && pathSearch.truncated && !pathSearch.isPending ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">
          More matches available. Refine your search.
        </div>
      ) : null}
      {(!ready || pathSearch.isPending) && !(projectPane && error) && (
        <div
          role="status"
          className={
            entries.length > 0 && !hasNoSearchMatches
              ? "sr-only"
              : "px-3 py-1 text-xs text-muted-foreground"
          }
        >
          Loading files…
        </div>
      )}
      {isEmptyFolder ? (
        <div role="status" className="px-3 py-4 text-xs text-muted-foreground">
          This folder is empty.
        </div>
      ) : null}
      {hasNoSearchMatches ? (
        ready && !isPending && !pathSearch.isPending && !error && !pathSearch.error ? (
          <div role="status" className="px-3 py-4 text-xs text-muted-foreground">
            No matching files.
          </div>
        ) : null
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={pierreTreeStyle(resolvedTheme, fileStatusColors)}
        />
      )}
    </div>
  );
}
