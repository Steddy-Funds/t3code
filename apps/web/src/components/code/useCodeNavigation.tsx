import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type {
  CodeDefinitionKind,
  CodeDocument,
  CodeHighlightKind,
  CodeIntelErrorReason,
  CodeLocation,
  CodePosition,
  CodeRange,
  EnvironmentId,
  KeybindingCommand,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { fileContentRevision } from "@t3tools/shared/fileContentRevision";
import type { PostRenderPhase } from "@pierre/diffs";
import type { AsyncResult, Atom } from "effect/reactivity";
import { createContext, type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import { useCodeNavigationStore } from "~/codeNavigationStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import { provideShortcutCapability } from "~/keybindings";
import { focusScopeProps } from "~/lib/focusScopes";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { registerCommands } from "~/shortcuts/dispatcher";
import { codeIntelEnvironment } from "~/state/codeIntel";
import { projectContentSearch } from "~/state/projects";

import {
  getProjectFileContents,
  getProjectFileQueryAtom,
  getUnsavedProjectFileQueryData,
} from "../files/projectFilesQueryState";
import { fileExtension } from "./codeLanguages";
import { createCodeLinkHover, isNavigationModifier } from "./codeLinkHover";
import {
  type CodeHighlightName,
  type CodeWordHit,
  domRangeFor,
  pointerTarget,
  positionAtTarget,
  positionRect,
  setCodeHighlight,
  wordAtTarget,
} from "./codeNavigationDom";
import {
  CHANGED_ON_DISK,
  type CodeNavigationAction,
  codeIntelFailureMessage,
  noResultMessage,
  waitingMessage,
} from "./codeNavigationMessages";
import {
  codeIntelOutcome,
  codeIntelStep,
  definitionExcerpt,
  fencedCode,
  isLineUnchanged,
  isOwnDeclaration,
  isSameFile,
  textMatchLocations,
  wordAtPosition,
} from "./codeNavigationModel";
import {
  CODE_NAVIGATION_POPUP_ATTRIBUTE,
  type CodePopup,
  type CodePopupAnchor,
  CodeNavigationPopup,
} from "./CodeNavigationPopup";
import { codeNavigationThreadKey, navigateToCodeLocation, registerCodeViewer } from "./navigation";
import type { CodeIntelFile } from "./useCodeIntelFile";

/** What the viewer needs from Pierre's editor; its `Editor` satisfies it. */
export interface CodeEditorHandle {
  readonly getViewState: () => {
    readonly selections?: ReadonlyArray<{
      readonly start: CodePosition;
      readonly end: CodePosition;
      readonly direction: -1 | 0 | 1;
    }>;
  };
  readonly focus: (options?: { readonly lineNumber: number; readonly character: number }) => void;
}

/** The editable surface hands its editor to the viewer's navigation through this. */
export const CodeEditorSlotContext = createContext<
  ((editor: CodeEditorHandle | null) => void) | null
>(null);

const WAITING_HINT_DELAY_MS = 500;
const USAGES_LIMIT = 200;

const PAINTED_HIGHLIGHTS: ReadonlyArray<CodeHighlightName> = [
  "t3-code-target",
  "t3-code-usage-text",
  "t3-code-usage-read",
  "t3-code-usage-write",
];

const USAGE_HIGHLIGHT: Record<CodeHighlightKind, CodeHighlightName> = {
  text: "t3-code-usage-text",
  read: "t3-code-usage-read",
  write: "t3-code-usage-write",
};

// CSS highlights are document-wide; the viewer that painted last owns them.
let highlightOwner: object | null = null;

type CodeCommand =
  | "declaration"
  | "typeDeclaration"
  | "implementation"
  | "usages"
  | "highlightUsages"
  | "documentation"
  | "definition"
  | "goToLine";

const CODE_COMMANDS: ReadonlyArray<readonly [KeybindingCommand, CodeCommand]> = [
  ["code.goToDeclaration", "declaration"],
  ["code.goToTypeDeclaration", "typeDeclaration"],
  ["code.goToImplementation", "implementation"],
  ["code.findUsages", "usages"],
  ["code.highlightUsages", "highlightUsages"],
  ["code.quickDocumentation", "documentation"],
  ["code.quickDefinition", "definition"],
  ["code.goToLine", "goToLine"],
];

const DEFINITION_KIND: Partial<Record<CodeCommand, CodeDefinitionKind>> = {
  declaration: "definition",
  typeDeclaration: "typeDefinition",
  implementation: "implementation",
};

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt"]);

function isInsideCodePopup(element: Element | null): boolean {
  return element?.closest(`[${CODE_NAVIGATION_POPUP_ATTRIBUTE}]`) != null;
}

interface LookupRequest {
  seq: number;
  controller: AbortController | null;
}

/** A lookup the user dismissed or moved past never lands: its answer was for another view. */
function cancelLookup(request: LookupRequest): void {
  request.seq += 1;
  request.controller?.abort();
  request.controller = null;
}

interface PaintedRanges {
  /** The text the ranges were computed for; an edit makes them stale. */
  readonly text: string;
  readonly ranges: ReadonlyArray<{ readonly name: CodeHighlightName; readonly range: CodeRange }>;
}

export interface CodeNavigationOptions {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
  readonly path: string | null;
  readonly text: string;
  /** A raw text file is on screen. */
  readonly shown: boolean;
  readonly editable: boolean;
  readonly intel: CodeIntelFile;
}

/**
 * Code navigation for the file viewer: Cmd+click and the code commands ask the language server
 * and jump through `navigateToCodeLocation`. Everything waits for status to say the server has
 * code intelligence, so an older server never shows any of it.
 */
export function useCodeNavigation(options: CodeNavigationOptions) {
  const { environmentId, cwd, threadRef, path, editable, intel } = options;
  const active = options.shown && path !== null && intel.supported;
  const canFollowLinks = active && intel.server !== null;
  const threadKey = codeNavigationThreadKey(threadRef);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const editorRef = useRef<CodeEditorHandle | null>(null);
  // A read-only caret belongs to the file it was placed in.
  const cursorRef = useRef<{ readonly path: string; readonly position: CodePosition } | null>(null);
  const pressRef = useRef<CodeWordHit | null>(null);
  const keepPopupFocusRef = useRef(false);
  const shownPathRef = useRef(path);
  const targetRef = useRef<PaintedRanges | null>(null);
  const usagesRef = useRef<PaintedRanges | null>(null);
  const requestRef = useRef<LookupRequest>({ seq: 0, controller: null });
  const [owner] = useState(() => ({}));
  const linksEnabled = useStableCallback(() => canFollowLinks);
  const [linkHover] = useState(() => createCodeLinkHover(linksEnabled));
  const [popup, setPopup] = useState<CodePopup | null>(null);
  const [hasEditor, setHasEditor] = useState(false);
  // Stable, so the editor options that hand it the editor never change and never re-attach it.
  const [setEditor] = useState(() => (editor: CodeEditorHandle | null) => {
    editorRef.current = editor;
    setHasEditor(editor !== null);
  });

  const currentText = () =>
    path === null
      ? options.text
      : (getProjectFileContents(environmentId, cwd, path) ?? options.text);

  const shadowRoot = () => containerRef.current?.shadowRoot ?? null;

  const paint = () => {
    const root = shadowRoot();
    if (root === null) return;
    const text = currentText();
    if (targetRef.current?.text !== text) targetRef.current = null;
    if (usagesRef.current?.text !== text) usagesRef.current = null;
    const painted = [...(targetRef.current?.ranges ?? []), ...(usagesRef.current?.ranges ?? [])];
    if (painted.length === 0 && highlightOwner !== owner) return;
    highlightOwner = painted.length === 0 ? null : owner;
    for (const name of PAINTED_HIGHLIGHTS) {
      setCodeHighlight(
        name,
        painted.flatMap((entry) => {
          if (entry.name !== name) return [];
          const range = domRangeFor(root, entry.range);
          return range === null ? [] : [range];
        }),
      );
    }
  };

  const clearTarget = () => {
    if (targetRef.current === null) return;
    targetRef.current = null;
    paint();
  };

  const currentPosition = (): CodePosition | null => {
    const selection = editorRef.current?.getViewState().selections?.[0];
    if (selection) return selection.direction < 0 ? selection.start : selection.end;
    if (cursorRef.current !== null && cursorRef.current.path === path) {
      return cursorRef.current.position;
    }
    const target = linkHover.hovered();
    const hovered = target === null ? null : wordAtTarget(target);
    return hovered?.range.start ?? null;
  };

  const anchorAt = (position: CodePosition | null): CodePopupAnchor => {
    let last: DOMRect | null = null;
    return {
      getBoundingClientRect: () => {
        const root = shadowRoot();
        const rect = position === null || root === null ? null : positionRect(root, position);
        if (rect !== null && rect.height > 0) last = rect;
        return last ?? surfaceRef.current?.getBoundingClientRect() ?? new DOMRect();
      },
    };
  };

  const hint = (position: CodePosition | null, message: string) =>
    setPopup({ kind: "hint", anchor: anchorAt(position), message });

  // Pierre's editor takes focus a frame later. Until then the viewer holds it, so a popup
  // that closes under the keyboard never drops focus to the page and on to the composer.
  const holdFocus = () => {
    const surface = surfaceRef.current;
    if (surface && !surface.contains(document.activeElement))
      surface.focus({ preventScroll: true });
  };

  const focusViewer = () => {
    holdFocus();
    editorRef.current?.focus();
  };

  // A reveal waits for this viewer to show its file, and for the editor when the file is editable.
  const applyReveal = () => {
    const reveal = useCodeNavigationStore.getState().revealByThreadKey[threadKey];
    if (!reveal || !active || path === null || !isSameFile(reveal.path, path, cwd)) return;
    if (!containerRef.current?.isConnected) return;
    targetRef.current = {
      text: currentText(),
      ranges: [{ name: "t3-code-target", range: reveal.range }],
    };
    paint();
    if (editable && editorRef.current === null) return;
    useCodeNavigationStore.getState().consumeReveal(threadKey, reveal.id);
    const { start } = reveal.range;
    cursorRef.current = { path, position: start };
    // Opening a result with Cmd+Enter keeps the list, and the keyboard, where they are.
    if (keepPopupFocusRef.current && isInsideCodePopup(document.activeElement)) return;
    if (editorRef.current) {
      editorRef.current.focus({ lineNumber: start.line + 1, character: start.character });
    } else {
      surfaceRef.current?.focus({ preventScroll: true });
    }
  };

  const reloadFile = (filePath: string) =>
    executeAtomQuery(appAtomRegistry, getProjectFileQueryAtom(environmentId, cwd, filePath), {
      refresh: true,
      reportFailure: false,
      reportDefect: false,
    });

  /**
   * One request at a time: a newer one supersedes it, and an answer for text the viewer no longer
   * shows is dropped. A clean file that changed on disk is reloaded and asked once more.
   */
  const ask = async <A extends { readonly revision: string }>(
    position: CodePosition,
    query: (document: CodeDocument) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
    onFailure?: (reason: CodeIntelErrorReason) => boolean,
    retried = false,
  ): Promise<A | null> => {
    if (path === null) return null;
    const request = requestRef.current;
    cancelLookup(request);
    const seq = request.seq;
    const controller = new AbortController();
    request.controller = controller;
    const anchor = anchorAt(position);
    const server = intel.server;
    const askedText = currentText();
    const waiting = window.setTimeout(() => {
      if (requestRef.current.seq !== seq) return;
      setPopup({ kind: "hint", anchor, message: waitingMessage(server) });
      intel.refreshStatus();
    }, WAITING_HINT_DELAY_MS);
    const result = await executeAtomQuery(
      appAtomRegistry,
      query({ cwd, path, ifRevision: fileContentRevision(askedText) }),
      { refresh: true, reportFailure: false, reportDefect: false, signal: controller.signal },
    );
    window.clearTimeout(waiting);
    if (request.seq !== seq) return null;
    request.controller = null;
    if (server?.state !== "ready") intel.refreshStatus();
    const outcome = codeIntelOutcome(result);
    if (outcome._tag === "failed" && onFailure?.(outcome.reason)) return null;
    const step = codeIntelStep(
      outcome,
      {
        revision: fileContentRevision(currentText()),
        unsaved: getUnsavedProjectFileQueryData(environmentId, cwd, path) !== null,
      },
      retried,
    );
    switch (step._tag) {
      case "use":
        return step.value;
      case "ignore":
        return null;
      case "close":
        setPopup(null);
        return null;
      case "hint":
        setPopup({ kind: "hint", anchor, message: step.message });
        return null;
      case "reload":
        await reloadFile(path);
        if (request.seq !== seq) return null;
        // Lines moved under the caret: asking again would answer for another name.
        if (!isLineUnchanged(askedText, currentText(), position.line)) {
          setPopup({ kind: "hint", anchor, message: CHANGED_ON_DISK });
          return null;
        }
        return ask(position, query, onFailure, true);
      case "failed": {
        const message = codeIntelFailureMessage(step.reason, step.message, {
          extension: fileExtension(path),
          server,
        });
        setPopup({ kind: "hint", anchor, message });
        return null;
      }
    }
  };

  const openLocations = (
    position: CodePosition,
    title: string,
    locations: ReadonlyArray<CodeLocation>,
    note: string | null,
  ) => setPopup({ kind: "locations", anchor: anchorAt(position), title, note, locations });

  // Without a language server for the file, usages are the project's whole-word text matches.
  const findTextMatches = async (position: CodePosition, word: string | null) => {
    if (path === null) return;
    const unsupported = codeIntelFailureMessage("unsupported_language", "", {
      extension: fileExtension(path),
      server: null,
    });
    if (word === null) return hint(position, unsupported);
    const seq = requestRef.current.seq;
    const result = await executeAtomQuery(
      appAtomRegistry,
      projectContentSearch({
        environmentId,
        input: {
          cwd,
          query: word,
          limit: USAGES_LIMIT,
          caseSensitive: true,
          wholeWord: true,
          useRegex: false,
        },
      }),
      { reportFailure: false, reportDefect: false },
    );
    if (requestRef.current.seq !== seq) return;
    if (result._tag !== "Success") return hint(position, "Text search failed");
    const locations = textMatchLocations(result.value.matches);
    if (locations.length === 0) return hint(position, noResultMessage("usages"));
    openLocations(position, `Text matches for ${word}`, locations, `${unsupported}.`);
  };

  const findUsages = async (position: CodePosition) => {
    const word = wordAtPosition(currentText(), position);
    const answer = await ask(
      position,
      (document) =>
        codeIntelEnvironment.references({
          environmentId,
          input: { document, position, includeDeclaration: false, limit: USAGES_LIMIT },
        }),
      (reason) => {
        if (reason !== "unsupported_language") return false;
        void findTextMatches(position, word);
        return true;
      },
    );
    if (answer === null) return;
    if (answer.locations.length === 0) return hint(position, noResultMessage("usages"));
    openLocations(
      position,
      word === null ? "Usages" : `Usages of ${word}`,
      answer.locations,
      answer.truncated ? `Showing the first ${answer.locations.length}.` : null,
    );
  };

  const goTo = async (
    action: CodeNavigationAction,
    kind: CodeDefinitionKind,
    position: CodePosition,
  ) => {
    const answer = await ask(position, (document) =>
      codeIntelEnvironment.definition({ environmentId, input: { document, position, kind } }),
    );
    if (answer === null || path === null) return;
    const { locations } = answer;
    if (locations.length === 0) return hint(position, noResultMessage(action));
    if (kind === "definition" && isOwnDeclaration(locations, path, cwd, position)) {
      return findUsages(position);
    }
    if (locations.length === 1) {
      setPopup(null);
      return navigateToCodeLocation(threadRef, locations[0]!);
    }
    openLocations(position, "Choose a target", locations, null);
  };

  const highlightUsages = async (position: CodePosition) => {
    const answer = await ask(position, (document) =>
      codeIntelEnvironment.documentHighlights({ environmentId, input: { document, position } }),
    );
    if (answer === null) return;
    if (answer.ranges.length === 0) return hint(position, noResultMessage("highlightUsages"));
    setPopup(null);
    usagesRef.current = {
      text: currentText(),
      ranges: answer.ranges.map((entry) => ({
        name: USAGE_HIGHLIGHT[entry.kind],
        range: entry.range,
      })),
    };
    paint();
  };

  const showDocumentation = async (position: CodePosition) => {
    const answer = await ask(position, (document) =>
      codeIntelEnvironment.hover({ environmentId, input: { document, position } }),
    );
    if (answer === null) return;
    const markdown = answer.markdown?.trim() ?? "";
    if (markdown === "") return hint(position, noResultMessage("documentation"));
    setPopup({ kind: "documentation", anchor: anchorAt(position), markdown });
  };

  const showDefinition = async (position: CodePosition) => {
    const answer = await ask(position, (document) =>
      codeIntelEnvironment.definition({
        environmentId,
        input: { document, position, kind: "definition" },
      }),
    );
    if (answer === null) return;
    const location = answer.locations[0];
    if (location === undefined) return hint(position, noResultMessage("definition"));
    const seq = requestRef.current.seq;
    const file = await executeAtomQuery(
      appAtomRegistry,
      getProjectFileQueryAtom(environmentId, cwd, location.path),
      { reportFailure: false, reportDefect: false },
    );
    if (requestRef.current.seq !== seq) return;
    if (file._tag !== "Success") return hint(position, `Could not read ${location.path}`);
    setPopup({
      kind: "definition",
      anchor: anchorAt(position),
      location,
      markdown: fencedCode(definitionExcerpt(file.value.contents, location.range), location.path),
    });
  };

  const runAt = (command: Exclude<CodeCommand, "goToLine">, position: CodePosition) => {
    const kind = DEFINITION_KIND[command];
    if (kind) return goTo(command, kind, position);
    if (command === "usages") return findUsages(position);
    if (command === "highlightUsages") return highlightUsages(position);
    if (command === "documentation") return showDocumentation(position);
    return showDefinition(position);
  };

  const runCommand = useEffectEvent((command: CodeCommand, event: KeyboardEvent) => {
    event.preventDefault();
    cancelLookup(requestRef.current);
    keepPopupFocusRef.current = false;
    const position = currentPosition();
    if (command === "goToLine") {
      setPopup({
        kind: "goToLine",
        anchor: anchorAt(position),
        lineCount: currentText().split("\n").length,
      });
      return;
    }
    if (position === null) return hint(null, "Click a symbol first");
    void runAt(command, position);
  });

  const onViewerKeyDown = useEffectEvent((event: KeyboardEvent): boolean => {
    if (MODIFIER_KEYS.has(event.key)) return false;
    // Escape, or any other key: the user moved on from a lookup still in flight.
    cancelLookup(requestRef.current);
    clearTarget();
    if (popup?.kind === "hint") setPopup(null);
    if (event.key !== "Escape") return false;
    if (popup !== null) {
      setPopup(null);
    } else if (usagesRef.current !== null) {
      usagesRef.current = null;
      paint();
    } else {
      return false;
    }
    event.preventDefault();
    // The editor's own Escape would also clear its selection and drop focus.
    event.stopPropagation();
    return true;
  });

  // Cmd+click must not reach the editor: it would move the caret or add one.
  const onPointerDown = useEffectEvent((event: MouseEvent) => {
    if (event.button !== 0) return;
    clearTarget();
    const target = pointerTarget(event);
    if (canFollowLinks && isNavigationModifier(event)) {
      const hit = target === null ? null : wordAtTarget(target);
      if (hit !== null) {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === "pointerdown") pressRef.current = hit;
        return;
      }
    }
    if (event.type !== "pointerdown") return;
    pressRef.current = null;
    // Recorded for editable files too: Pierre's editor can stop reporting its caret.
    if (target === null || path === null) return;
    const position = positionAtTarget(target);
    cursorRef.current = position === null ? null : { path, position };
  });

  const onClick = useEffectEvent((event: MouseEvent) => {
    const hit = pressRef.current;
    pressRef.current = null;
    if (hit === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (!isNavigationModifier(event)) return;
    const { start } = hit.range;
    // The clicked word is where Back returns to.
    if (path !== null) cursorRef.current = { path, position: start };
    keepPopupFocusRef.current = false;
    editorRef.current?.focus({ lineNumber: start.line + 1, character: start.character });
    void goTo("declaration", "definition", start);
  });

  const revealSoon = useEffectEvent(() => {
    requestAnimationFrame(() => applyReveal());
  });

  const getLocation = useEffectEvent(() => {
    const position = currentPosition();
    return position === null || path === null ? null : { path, position };
  });

  const getDocument = useEffectEvent(() =>
    path === null
      ? null
      : {
          environmentId,
          cwd,
          path,
          text: currentText(),
          unsaved: getUnsavedProjectFileQueryData(environmentId, cwd, path) !== null,
          position: currentPosition(),
        },
  );

  const releaseHighlights = useEffectEvent(() => {
    linkHover.release();
    targetRef.current = null;
    usagesRef.current = null;
    if (highlightOwner !== owner) return;
    highlightOwner = null;
    for (const name of PAINTED_HIGHLIGHTS) setCodeHighlight(name, []);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the viewer's shortcuts, capability and pointer listeners with the window dispatcher and the DOM
  useEffect(() => {
    const element = surfaceRef.current;
    if (!active || element === null) return;
    const isFocused = () => element.contains(document.activeElement);
    const releaseViewer = registerCodeViewer({
      element,
      threadRef,
      location: getLocation,
      document: getDocument,
    });
    const handlers = Object.fromEntries(
      CODE_COMMANDS.map(([command, codeCommand]) => [
        command,
        (event: KeyboardEvent) => runCommand(codeCommand, event),
      ]),
    );
    const releaseCommands = registerCommands(handlers, {
      capture: true,
      when: isFocused,
      onKeyDown: (event) => onViewerKeyDown(event),
    });
    const withdrawCapability = provideShortcutCapability("codeNavigation", isFocused);
    const unsubscribe = useCodeNavigationStore.subscribe((state, previous) => {
      if (state.revealByThreadKey[threadKey] !== previous.revealByThreadKey[threadKey]) {
        revealSoon();
      }
    });
    const pointerDown = (event: MouseEvent) => onPointerDown(event);
    const pointerMove = (event: PointerEvent) => linkHover.pointerMove(event);
    const pointerLeave = () => linkHover.pointerLeave();
    const click = (event: MouseEvent) => onClick(event);
    const modifierChange = (event: Event) => linkHover.modifierChange(event);
    element.addEventListener("pointermove", pointerMove);
    element.addEventListener("pointerleave", pointerLeave);
    element.addEventListener("pointerdown", pointerDown, true);
    element.addEventListener("mousedown", pointerDown, true);
    element.addEventListener("click", click, true);
    window.addEventListener("keydown", modifierChange, true);
    window.addEventListener("keyup", modifierChange, true);
    window.addEventListener("blur", modifierChange);
    revealSoon();
    return () => {
      element.removeEventListener("pointermove", pointerMove);
      element.removeEventListener("pointerleave", pointerLeave);
      element.removeEventListener("pointerdown", pointerDown, true);
      element.removeEventListener("mousedown", pointerDown, true);
      element.removeEventListener("click", click, true);
      window.removeEventListener("keydown", modifierChange, true);
      window.removeEventListener("keyup", modifierChange, true);
      window.removeEventListener("blur", modifierChange);
      unsubscribe();
      withdrawCapability();
      releaseCommands();
      releaseViewer();
      cancelLookup(requestRef.current);
      releaseHighlights();
    };
  }, [active, threadKey, threadRef, linkHover]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one viewer serves every file tab, so a file switch drops what was asked or shown over the last file
  useEffect(() => {
    if (shownPathRef.current === path) return;
    shownPathRef.current = path;
    cancelLookup(requestRef.current);
    linkHover.forget();
    pressRef.current = null;
    // Cmd+Enter in a result list opens another file and keeps the list.
    if (!keepPopupFocusRef.current) setPopup(null);
  }, [path, linkHover]);

  const onPostRender = (fileContainer: HTMLElement, phase: PostRenderPhase) => {
    if (phase === "unmount") {
      if (containerRef.current === fileContainer) containerRef.current = null;
      return;
    }
    containerRef.current = fileContainer;
    paint();
    applyReveal();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a reveal that waited for Pierre's editor applies once the editor attaches
  useEffect(() => {
    if (hasEditor) revealSoon();
  }, [hasEditor]);

  const closePopup = (restoreFocus: boolean) => {
    cancelLookup(requestRef.current);
    keepPopupFocusRef.current = false;
    setPopup(null);
    if (restoreFocus) focusViewer();
  };

  const openLocation = (location: CodeLocation, keepOpen: boolean) => {
    keepPopupFocusRef.current = keepOpen;
    if (!keepOpen) {
      holdFocus();
      setPopup(null);
    }
    navigateToCodeLocation(threadRef, location);
  };

  const goToPosition = (position: CodePosition) => {
    keepPopupFocusRef.current = false;
    holdFocus();
    setPopup(null);
    if (path === null) return;
    navigateToCodeLocation(threadRef, {
      path,
      external: false,
      range: { start: position, end: position },
    });
  };

  // A list kept open with Cmd+Enter stays up, filter and all, while the next file loads.
  const popupNode: ReactNode =
    popup !== null && (active || popup.kind === "locations") ? (
      <CodeNavigationPopup
        popup={popup}
        cwd={cwd}
        onClose={closePopup}
        onOpenLocation={openLocation}
        onGoToPosition={goToPosition}
      />
    ) : null;

  return {
    surfaceProps: active
      ? { ref: surfaceRef, tabIndex: -1, ...focusScopeProps("code") }
      : { ref: surfaceRef },
    onPostRender,
    setEditor,
    popup: popupNode,
  };
}
