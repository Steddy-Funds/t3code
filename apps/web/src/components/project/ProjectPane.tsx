import { useAtomValue } from "@effect/atom-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isAbsolutePath } from "@t3tools/shared/path";
import { useEffect, useRef, useState } from "react";

import FileBrowserPanel from "~/components/files/FileBrowserPanel";
import { workspaceChanges } from "~/components/files/treeGitStatus";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useThreadRouteTarget } from "~/hooks/useThreadRouteTarget";
import { shortcutLabelForCommand } from "~/keybindings";
import { focusScopeProps } from "~/lib/focusScopes";
import {
  type RightPanelSurface,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "~/rightPanelStore";
import { useProject, useQuietThreadShell } from "~/state/entities";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { environmentSession, sessionHasScope } from "~/state/session";
import { vcsEnvironment } from "~/state/vcs";

import { workingTreeChangesAtom, workspaceRefreshToken } from "./projectGitChanges";
import { useProjectPaneStore } from "./projectPaneStore";

export interface ProjectPaneTarget {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  /** The thread's worktree, or its project's root; the same root the right panel's files use. */
  readonly cwd: string;
  readonly projectName: string;
}

/** The workspace of the thread on screen, server thread or draft. */
export function useProjectPaneTarget(): ProjectPaneTarget | null {
  const route = useThreadRouteTarget();
  const shell = useQuietThreadShell(route?.kind === "server" ? route.threadRef : null);
  const draft = useComposerDraftStore((store) =>
    route === null
      ? null
      : route.kind === "server"
        ? store.getDraftSessionByRef(route.threadRef)
        : store.getDraftSession(route.draftId),
  );
  const thread = shell ?? draft;
  const threadId = shell?.id ?? draft?.threadId ?? null;
  const project = useProject(
    thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null,
  );
  if (thread === null || threadId === null || project === null) return null;
  return {
    environmentId: thread.environmentId,
    threadRef: scopeThreadRef(thread.environmentId, threadId),
    cwd: thread.worktreePath ?? project.workspaceRoot,
    projectName: project.title,
  };
}

function sameTarget(a: ProjectPaneTarget | null, b: ProjectPaneTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.environmentId === b.environmentId &&
    a.cwd === b.cwd &&
    a.projectName === b.projectName &&
    scopedThreadKey(a.threadRef) === scopedThreadKey(b.threadRef)
  );
}

function openedWorkspaceFile(surface: RightPanelSurface | null) {
  return surface?.kind === "file" &&
    !surface.attachment &&
    surface.relativePath !== "" &&
    !isAbsolutePath(surface.relativePath)
    ? surface
    : null;
}

/** A pane state with no tree still holds the tree's focus scope, so mod+1 leads back out. */
function PaneMessage({ children }: { children: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const focusPending = useProjectPaneStore((state) => state.treeFocusPending);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- takes the keyboard focus a shortcut asked the missing tree for
  useEffect(() => {
    if (!focusPending) return;
    ref.current?.focus({ preventScroll: true });
    useProjectPaneStore.getState().treeFocusHandled();
  }, [focusPending]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      className="px-3 py-4 text-xs text-muted-foreground outline-none"
    >
      {children}
    </div>
  );
}

/** Null until `token` moves off the first value it had: the listing that mounted with it is current. */
function useTokenAfterFirst(token: string | null): string | null {
  const [first, setFirst] = useState(token);
  const [moved, setMoved] = useState(false);
  if (!moved && first === null && token !== null) setFirst(token);
  else if (!moved && first !== null && token !== first) setMoved(true);
  return moved ? token : null;
}

function ProjectFiles({ target }: { target: ProjectPaneTarget }) {
  const { environmentId, cwd, threadRef } = target;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  // Unknown until the session loads; only a loaded session without the grant blocks the tree.
  const canRead = useAtomValue(environmentSession.sessionStateAtom(environmentId), (result) =>
    result._tag === "Success" ? sessionHasScope(result, AuthFilesystemReadScope) : true,
  );
  const workingTree = useAtomValue(
    workingTreeChangesAtom(vcsEnvironment.status({ environmentId, input: { cwd } })),
  );
  const gitChanges = workspaceChanges(workingTree.snapshot, cwd);
  const turnCompletedAt = useQuietThreadShell(threadRef)?.latestRun?.completedAt ?? null;
  const refreshToken = useTokenAfterFirst(
    workspaceRefreshToken(workingTree.phase, gitChanges, turnCompletedAt),
  );
  const openedPath = useRightPanelStore(
    (state) =>
      openedWorkspaceFile(selectActiveRightPanelSurface(state.byThreadKey, threadRef))
        ?.relativePath ?? null,
  );
  const openedRevealId = useRightPanelStore(
    (state) =>
      openedWorkspaceFile(selectActiveRightPanelSurface(state.byThreadKey, threadRef))
        ?.revealRequestId ?? 0,
  );
  const focusPending = useProjectPaneStore((state) => state.treeFocusPending);

  if (!canRead) return <PaneMessage>This connection can't browse files.</PaneMessage>;
  return (
    <FileBrowserPanel
      environmentId={environmentId}
      cwd={cwd}
      projectName={target.projectName}
      selectedPath={openedPath}
      selectedPathRevealId={openedRevealId}
      onOpenFile={(relativePath) => useRightPanelStore.getState().openFile(threadRef, relativePath)}
      workspaceMutationId={refreshToken}
      projectPane={{
        gitChanges,
        focusPending,
        onTreeFocused: () => useProjectPaneStore.getState().treeFocusHandled(),
        onSelectOpenedFile: () => useProjectPaneStore.getState().focusTree(),
        selectOpenedFileShortcut: shortcutLabelForCommand(
          keybindings,
          "projectPane.selectOpenedFile",
          { context: { codeFocus: true, projectPane: true } },
        ),
      }}
    />
  );
}

/**
 * The Project mode of the left sidebar: the active thread's workspace as a tree. While hidden
 * it keeps the last workspace it showed, so switching threads in Threads mode lists nothing.
 */
export default function ProjectPane({
  target,
  active,
}: {
  target: ProjectPaneTarget | null;
  active: boolean;
}) {
  const [shown, setShown] = useState(target);
  if (active && !sameTarget(shown, target)) setShown(target);

  return (
    <div className="flex min-h-0 flex-1 flex-col" {...focusScopeProps("project-tree")}>
      {shown === null ? (
        <PaneMessage>Open a thread to browse its project's files.</PaneMessage>
      ) : (
        <ProjectFiles key={`${shown.environmentId}:${shown.cwd}`} target={shown} />
      )}
    </div>
  );
}
