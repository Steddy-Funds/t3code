import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  CodeLocation,
  CodePosition,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import {
  type CodeHistoryDirection,
  type CodeHistoryEntry,
  EMPTY_CODE_HISTORY,
  stepCodeHistory,
  useCodeNavigationStore,
} from "../../codeNavigationStore";
import { rightPanelHostRef, useRightPanelStore } from "../../rightPanelStore";
import { registerCommands } from "../../shortcuts/dispatcher";

export interface NavigateToCodeLocationOptions {
  /** Defaults to true: the jump records where it left from, for `navigation.back`. */
  readonly pushHistory?: boolean;
}

/** The file a viewer shows, as the text it shows now. */
export interface CodeViewerDocument {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly path: string;
  readonly text: string;
  /** The buffer has edits not yet on disk. */
  readonly unsaved: boolean;
  readonly position: CodePosition | null;
}

/** A code viewer mounted in a thread's panel, so jumps know where they leave from. */
export interface CodeViewer {
  readonly element: HTMLElement;
  readonly threadRef: ScopedThreadRef;
  readonly location: () => CodeHistoryEntry | null;
  readonly document: () => CodeViewerDocument | null;
}

/** History is the panel's: a side chat shares its parent thread's panel. */
export function codeNavigationThreadKey(threadRef: ScopedThreadRef): string {
  return scopedThreadKey(rightPanelHostRef(threadRef));
}

// The most recently used viewer is last.
const viewers: CodeViewer[] = [];
let releaseHistoryCommands: (() => void) | null = null;

function isShown(element: HTMLElement): boolean {
  return element.isConnected && element.checkVisibility();
}

function activeViewer(threadKey: string): CodeViewer | undefined {
  return viewers.findLast(
    (viewer) => codeNavigationThreadKey(viewer.threadRef) === threadKey && isShown(viewer.element),
  );
}

/**
 * Opens a location in the thread's file viewer, project or library, puts the caret on it and,
 * unless told otherwise, records where the jump left from. Every code jump goes through here.
 */
export function navigateToCodeLocation(
  threadRef: ScopedThreadRef,
  location: CodeLocation,
  options: NavigateToCodeLocationOptions = {},
): void {
  const threadKey = codeNavigationThreadKey(threadRef);
  const store = useCodeNavigationStore.getState();
  if (options.pushHistory !== false) {
    const origin = activeViewer(threadKey)?.location();
    if (origin) store.recordOrigin(threadKey, origin);
  }
  store.reveal(threadKey, threadRef, location.path, location.range);
  useRightPanelStore.getState().openFile(threadRef, location.path, location.range.start.line + 1);
}

/** Once app navigation leaves the jump's page, back and forward stay the app's, also on return. */
export function expireCodeJump(): void {
  const { lastJump } = useCodeNavigationStore.getState();
  if (lastJump !== null && lastJump.href !== window.location.href) {
    useCodeNavigationStore.setState({ lastJump: null });
  }
}

export function startCodeJumpExpiry(router: AnyRouter): () => void {
  return router.subscribe("onResolved", expireCodeJump);
}

/** The viewer holding focus, if any. */
export function focusedCodeViewer(): CodeViewer | undefined {
  const focused = document.activeElement;
  return viewers.findLast((viewer) => viewer.element.contains(focused));
}

function historyThreadRef(): ScopedThreadRef | null {
  const focusedViewer = focusedCodeViewer();
  if (focusedViewer) return focusedViewer.threadRef;
  const { lastJump } = useCodeNavigationStore.getState();
  // Any app navigation since the jump changed the location; then back is the app's again.
  return lastJump !== null && lastJump.href === window.location.href ? lastJump.threadRef : null;
}

function stepCodeNavigation(direction: CodeHistoryDirection, event: KeyboardEvent): boolean {
  const threadRef = historyThreadRef();
  if (threadRef === null) return false;
  const threadKey = codeNavigationThreadKey(threadRef);
  const store = useCodeNavigationStore.getState();
  const step = stepCodeHistory(
    store.historyByThreadKey[threadKey] ?? EMPTY_CODE_HISTORY,
    direction,
    activeViewer(threadKey)?.location() ?? null,
  );
  if (step === null) return false;
  event.preventDefault();
  event.stopPropagation();
  store.setHistory(threadKey, step.history);
  const position = step.target.position;
  navigateToCodeLocation(
    threadRef,
    { path: step.target.path, external: false, range: { start: position, end: position } },
    { pushHistory: false },
  );
  return true;
}

function isKeybindingCaptureTarget(event: KeyboardEvent): boolean {
  return (
    event.target instanceof HTMLElement &&
    event.target.closest("[data-keybinding-capture]") !== null
  );
}

/**
 * Registers a viewer while it is mounted. While any is, back and forward step through code
 * history first, ahead of the editor's own keys, and fall through to the app history.
 */
export function registerCodeViewer(viewer: CodeViewer): () => void {
  viewers.push(viewer);
  releaseHistoryCommands ??= registerCommands(
    {
      "navigation.back": (event) => stepCodeNavigation("back", event),
      "navigation.forward": (event) => stepCodeNavigation("forward", event),
    },
    { capture: true, when: (event) => !isKeybindingCaptureTarget(event) },
  );
  const activate = () => {
    const index = viewers.indexOf(viewer);
    if (index === -1 || index === viewers.length - 1) return;
    viewers.splice(index, 1);
    viewers.push(viewer);
  };
  viewer.element.addEventListener("focusin", activate);
  viewer.element.addEventListener("pointerdown", activate, true);
  return () => {
    viewer.element.removeEventListener("focusin", activate);
    viewer.element.removeEventListener("pointerdown", activate, true);
    const index = viewers.indexOf(viewer);
    if (index !== -1) viewers.splice(index, 1);
    if (viewers.length === 0) {
      releaseHistoryCommands?.();
      releaseHistoryCommands = null;
    }
  };
}
