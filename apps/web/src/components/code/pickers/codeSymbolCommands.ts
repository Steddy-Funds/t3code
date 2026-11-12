import { isCodeIntelUnsupportedError } from "@t3tools/client-runtime/state/code-intel";
import { useEffect } from "react";

import {
  dispatchCommandPalette,
  isCommandPaletteMounted,
  useCommandPaletteStore,
} from "~/commandPaletteStore";
import type { ActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { getClientSettings } from "~/hooks/useSettings";
import { provideShortcutCapability } from "~/keybindings";
import { registerCommands } from "~/shortcuts/dispatcher";
import { codeIntelEnvironment } from "~/state/codeIntel";
import { useEnvironmentQuery } from "~/state/query";

import { toastManager } from "../../ui/toast";
import {
  type CodeViewer,
  type CodeViewerDocument,
  focusedCodeViewer,
  navigateToCodeLocation,
} from "../navigation";
import { methodJumpTarget } from "./codePickers.logic";
import { documentSymbolsFor } from "./documentSymbols";
import { installDoubleShift, isDoubleShiftSearchOn } from "./doubleShift";

interface FileStructureTarget {
  readonly viewer: CodeViewer;
  readonly document: CodeViewerDocument | null;
}

let structureTarget: FileStructureTarget | null = null;
let jumpOnClose: (() => void) | null = null;

/** The viewer the file structure popup was opened over, and its document then. */
export function fileStructureTarget(): FileStructureTarget | null {
  return structureTarget;
}

/**
 * A picker's jump waits for the palette to close: the workspace is inert while it is open, so
 * the reveal could not focus the editor.
 */
export function jumpWhenPaletteCloses(jump: () => void): void {
  jumpOnClose = jump;
}

/** Runs at the palette's focus restoration, after its focus trap closes. */
export function runJumpFromPalette(): boolean {
  const jump = jumpOnClose;
  jumpOnClose = null;
  jump?.();
  return jump !== null;
}

/** The project's server answers code intelligence; false while unknown and on older servers. */
export function useCodeSymbolsAvailable(target: ActiveProjectTarget | null): boolean {
  const status = useEnvironmentQuery(
    target === null
      ? null
      : codeIntelEnvironment.status({
          environmentId: target.environmentId,
          input: { cwd: target.cwd },
        }),
  );
  return status.data !== null && !isCodeIntelUnsupportedError(status.failure);
}

async function jumpToMethod(viewer: CodeViewer, direction: "next" | "previous"): Promise<void> {
  const answer = await documentSymbolsFor(viewer);
  if (answer._tag === "message") {
    toastManager.add({ id: "code-method-jump", title: answer.message, timeout: 2500 });
    return;
  }
  if (answer._tag !== "symbols") return;
  const { document } = answer;
  const target = methodJumpTarget(answer.symbols, document.position, direction);
  if (target === null) return;
  navigateToCodeLocation(
    viewer.threadRef,
    { path: document.path, external: false, range: { start: target, end: target } },
    { pushHistory: false },
  );
}

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Go to class and symbol, recent files, file structure and next or previous method. They run
 * ahead of the editor, which would take Ctrl+Shift+arrows for selection.
 */
function installCodeSymbolCommands(): () => void {
  const toggle = (mode: "classes" | "symbols" | "recentFiles") => (event: KeyboardEvent) => {
    consume(event);
    if (event.repeat) return;
    dispatchCommandPalette({ _tag: "ToggleMode", mode });
  };
  const onViewer = (run: (viewer: CodeViewer) => void) => (event: KeyboardEvent) => {
    const viewer = focusedCodeViewer();
    if (viewer === undefined) return false;
    consume(event);
    run(viewer);
  };
  return registerCommands(
    {
      "code.goToClass": toggle("classes"),
      "code.goToSymbol": toggle("symbols"),
      "code.recentFiles": toggle("recentFiles"),
      "code.fileStructure": onViewer((viewer) => {
        // Read at the key, not while the popup renders: the viewer's document() is an effect event.
        structureTarget = { viewer, document: viewer.document() };
        dispatchCommandPalette({ _tag: "ToggleMode", mode: "structure" });
      }),
      "code.nextMethod": onViewer((viewer) => void jumpToMethod(viewer, "next")),
      "code.previousMethod": onViewer((viewer) => void jumpToMethod(viewer, "previous")),
    },
    { capture: true, when: isCommandPaletteMounted },
  );
}

/** Code symbol shortcuts, their `codeSymbols` capability, and double Shift for the palette. */
export function useCodeSymbolCommands(target: ActiveProjectTarget | null): void {
  const available = useCodeSymbolsAvailable(target);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the shortcuts with the window dispatcher and double Shift with the window
  useEffect(() => {
    const releaseCommands = installCodeSymbolCommands();
    const releaseDoubleShift = installDoubleShift({
      isOn: () => isDoubleShiftSearchOn(getClientSettings()),
      onDoubleShift: () => {
        if (!useCommandPaletteStore.getState().open) {
          dispatchCommandPalette({ _tag: "SetOpen", open: true });
        }
      },
    });
    return () => {
      releaseCommands();
      releaseDoubleShift();
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the shortcut dispatcher whether the keys work where focus is
  useEffect(
    () =>
      provideShortcutCapability(
        "codeSymbols",
        () => available || focusedCodeViewer() !== undefined,
      ),
    [available],
  );
}
