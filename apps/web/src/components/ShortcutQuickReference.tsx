import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useRouter, type AnyRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { composerRequiresModifier } from "../composer-logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import type { ShortcutMatchContext } from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import {
  selectActiveRightPanel,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { derivePhase } from "../session-logic";
import { useShortcutModifierState } from "../shortcutModifierState";
import { readThreadShell } from "../state/entities";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import {
  collectQuickReferenceCommands,
  fitQuickReference,
  isPointerOverCodeScope,
  isQuickReferenceModifierHeld,
  QUICK_REFERENCE_MIN_WIDTH_REM,
  QUICK_REFERENCE_SHOW_DELAY_MS,
  quickReferenceGroupsForModifiers,
  readFocusScopeContext,
  trackPointerPressed,
  watchQuickReferenceInterruptions,
  type QuickReferenceArea,
  type QuickReferenceCommandGroup,
  type QuickReferenceEntry,
} from "./ShortcutQuickReference.logic";
import { Kbd } from "./ui/kbd";

interface QuickReferenceSnapshot {
  readonly groups: ReadonlyArray<QuickReferenceCommandGroup>;
  readonly area: QuickReferenceArea;
  readonly leftPx: number;
}

/**
 * The `when` context a key pressed now would resolve in. Each shortcut
 * listener builds its own; this mirrors the chat's, the widest one.
 */
function readShortcutContext(router: AnyRouter): Partial<ShortcutMatchContext> {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const drafts = useComposerDraftStore.getState();
  const draftSession = target?.kind === "draft" ? drafts.getDraftSession(target.draftId) : null;
  const threadRef =
    target?.kind === "server"
      ? target.threadRef
      : draftSession
        ? scopeThreadRef(draftSession.environmentId, draftSession.threadId)
        : null;
  const draft = target
    ? drafts.getComposerDraft(target.kind === "server" ? target.threadRef : target.draftId)
    : null;
  const runtime = target?.kind === "server" ? readThreadShell(target.threadRef)?.runtime : null;
  const rightPanels = useRightPanelStore.getState().byThreadKey;

  return {
    ...readFocusScopeContext(),
    terminalFocus: isTerminalFocused(),
    terminalOpen: threadRef
      ? selectThreadTerminalUiState(
          useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
          threadRef,
        ).terminalOpen
      : false,
    previewFocus: isPreviewFocused(),
    previewOpen: selectActiveRightPanel(rightPanels, threadRef) === "preview",
    rightPanelOpen: selectThreadRightPanelState(rightPanels, threadRef).isOpen,
    editableFocus: isEditableFocused(),
    modelPickerOpen: isModelPickerOpen(),
    usagePageOpen: router.state.location.pathname === "/usage",
    composerFocus: document.activeElement?.getAttribute("data-testid") === "composer-editor",
    draftThreadRoute: target?.kind === "draft",
    turnRunning: derivePhase(runtime ?? null) === "running",
    composerRequiresModifier: composerRequiresModifier(
      getClientSettings().sendShortcut,
      draft?.prompt ?? "",
    ),
  };
}

function readSnapshot(router: AnyRouter): QuickReferenceSnapshot {
  const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  const environmentId =
    target?.kind === "server"
      ? target.threadRef.environmentId
      : target
        ? useComposerDraftStore.getState().getDraftSession(target.draftId)?.environmentId
        : undefined;
  const remPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  // Beside the thread sidebar, so its jump hints stay readable; over it when the rest is too narrow.
  const sidebarRight =
    document.querySelector("[data-app-sidebar]")?.getBoundingClientRect().right ?? 0;
  const leftPx =
    (window.innerWidth - sidebarRight) / remPx >= QUICK_REFERENCE_MIN_WIDTH_REM
      ? Math.max(0, sidebarRight)
      : 0;
  return {
    groups: collectQuickReferenceCommands({
      keybindings: appAtomRegistry.get(primaryServerKeybindingsAtom),
      scriptKeybindings: environmentId
        ? (appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.keybindings ?? [])
        : [],
      context: readShortcutContext(router),
      platform: navigator.platform,
    }),
    area: {
      widthRem: (window.innerWidth - leftPx) / remPx,
      heightRem: window.innerHeight / remPx,
    },
    leftPx,
  };
}

/** Where a held modifier means something else, or the chat's shortcuts are off. */
function isQuickReferenceSuppressed(router: AnyRouter): boolean {
  return (
    // The list is the chat's: off a thread (Settings, Usage, pull requests) most of it would do nothing.
    resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {}) === null ||
    isPointerOverCodeScope() ||
    isCommandPaletteOpen()
  );
}

function Entry({ entry }: { readonly entry: QuickReferenceEntry }) {
  return (
    <div
      className="flex h-5.5 items-center gap-4 data-dimmed:opacity-50"
      data-dimmed={entry.dimmed ? "" : undefined}
    >
      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
      <Kbd>{entry.keys}</Kbd>
    </div>
  );
}

function QuickReferenceOverlay() {
  const router = useRouter();
  const modifiers = useShortcutModifierState();
  const held = isQuickReferenceModifierHeld(modifiers, navigator.platform);
  const [interrupted, setInterrupted] = useState(false);
  const [snapshot, setSnapshot] = useState<QuickReferenceSnapshot | null>(null);
  // An interrupted hold stays hidden until the modifier is released and held again.
  if (!held && (interrupted || snapshot !== null)) {
    setInterrupted(false);
    setSnapshot(null);
  }
  const armed = held && !interrupted;
  const isPointerPressedRef = useRef<() => boolean>(() => false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window pointer listeners that track a pressed pointer
  useEffect(() => {
    const tracker = trackPointerPressed(window);
    isPointerPressedRef.current = tracker.isPressed;
    return tracker.dispose;
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the show timer and the window listeners that cancel it, live only while the modifier is held
  useEffect(() => {
    if (!armed || isPointerPressedRef.current() || isQuickReferenceSuppressed(router)) return;
    const timer = window.setTimeout(
      () => setSnapshot(readSnapshot(router)),
      QUICK_REFERENCE_SHOW_DELAY_MS,
    );
    const stopWatching = watchQuickReferenceInterruptions(window, () => {
      setInterrupted(true);
      setSnapshot(null);
    });
    return () => {
      window.clearTimeout(timer);
      stopWatching();
    };
  }, [armed, router]);

  if (!armed || snapshot === null || snapshot.groups.length === 0) return null;
  const view = fitQuickReference(
    quickReferenceGroupsForModifiers(snapshot.groups, modifiers, navigator.platform),
    snapshot.area,
  );

  return (
    // Holding a modifier is not a request to be read to, and screen readers use Ctrl themselves.
    <div
      aria-hidden
      inert
      className="pointer-events-none fixed inset-y-0 right-0 z-[150] flex select-none items-center justify-center p-4"
      style={{ left: snapshot.leftPx }}
    >
      <div
        className="dropdown-glass max-w-full rounded-xl p-4 text-popover-foreground text-xs shadow-xl shadow-black/25 transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none"
        data-shortcut-quick-reference=""
      >
        <div className="flex min-w-0 gap-6">
          {view.columns.map((column) => (
            <div key={column[0]?.entries[0]?.id} className="min-w-0">
              {column.map((group) => (
                <section key={group.id} className="mt-2.75 first:mt-0">
                  {group.continued ? null : (
                    <h2 className="flex h-5.5 items-center font-medium text-2xs text-muted-foreground uppercase tracking-wide">
                      {group.title}
                    </h2>
                  )}
                  {group.entries.map((entry) => (
                    <Entry key={entry.id} entry={entry} />
                  ))}
                </section>
              ))}
            </div>
          ))}
        </div>
        {view.hiddenCount > 0 ? (
          <p className="flex h-5.5 items-end text-muted-foreground">
            {view.hiddenCount} more in Settings → Keybindings
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * While the shortcut modifier (Cmd on macOS, Ctrl elsewhere) is held with
 * nothing else happening, lists the shortcuts that work where focus is. It
 * only watches: no focus, no pointer events, no key is consumed.
 */
export function ShortcutQuickReference() {
  const enabled = useClientSettings((settings) => settings.shortcutQuickReferenceEnabled);
  return enabled ? <QuickReferenceOverlay /> : null;
}
