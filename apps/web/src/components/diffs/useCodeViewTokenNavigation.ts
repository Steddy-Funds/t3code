import type { DiffTokenEventBaseProps, FileDiffMetadata } from "@pierre/diffs";
import { useEffect, useRef, useState } from "react";

import { createCodeLinkHover, isNavigationModifier } from "~/components/code/codeLinkHover";
import {
  CODE_LINKS_ATTRIBUTE,
  pointerTarget,
  wordAtTarget,
} from "~/components/code/codeNavigationDom";
import { useStableCallback } from "~/hooks/useStableCallback";
import { provideShortcutCapability } from "~/keybindings";
import { isEditableFocused } from "~/lib/editableFocus";
import { registerCommands } from "~/shortcuts/dispatcher";

import type { DiffTokenActivation } from "./useDiffCodeNavigation";

/** A word of a diff item: what Go to Declaration asks about, before its side's revision is known. */
export type DiffTokenTarget = Omit<DiffTokenActivation, "revision">;

export type DiffCodeViewTokenActivate = (
  target: DiffTokenTarget,
  fileDiff: FileDiffMetadata,
) => void;

/** The word a pointer event on one of Pierre's diff tokens is on; null off a word. */
function diffTokenTarget(
  token: Pick<DiffTokenEventBaseProps, "side" | "lineNumber" | "tokenElement">,
  event: Pick<MouseEvent, "clientX" | "clientY">,
): DiffTokenTarget | null {
  const hit = wordAtTarget({
    token: token.tokenElement,
    line: token.lineNumber - 1,
    x: event.clientX,
    y: event.clientY,
  });
  if (hit === null) return null;
  return {
    side: token.side,
    line: token.lineNumber,
    character: hit.range.start.character,
    anchor: token.tokenElement,
  };
}

interface DiffCaret {
  readonly target: DiffTokenTarget;
  readonly fileDiff: FileDiffMetadata;
}

/**
 * Go to Declaration in Pierre's stacked and split diffs: Cmd+click on a word, the Cmd-hover link,
 * and the keymap's command at the word last clicked. Without `onActivate` it does nothing.
 */
export function useCodeViewTokenNavigation(onActivate: DiffCodeViewTokenActivate | undefined) {
  const enabled = onActivate !== undefined;
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const linksEnabled = useStableCallback(() => enabled);
  const [linkHover] = useState(() => createCodeLinkHover(linksEnabled));
  const caret = useRef<DiffCaret | null>(null);
  const activate = useStableCallback((target: DiffTokenTarget, fileDiff: FileDiffMetadata) =>
    onActivate?.(target, fileDiff),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens to the viewer's pointer and the window's modifier keys, and registers Go to Declaration with the shortcut dispatcher
  useEffect(() => {
    if (!enabled || root === null) return;
    const inView = (target: EventTarget | null) =>
      target instanceof Node && root.contains(target) && !isEditableFocused(target);
    const onPointerDown = (event: PointerEvent) => {
      caret.current = null;
      // A Cmd+press would start a text selection under the link.
      if (isNavigationModifier(event) && pointerTarget(event) !== null) event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent) => linkHover.pointerMove(event);
    const onPointerLeave = () => linkHover.pointerLeave();
    const onModifierChange = (event: Event) => linkHover.modifierChange(event);
    root.setAttribute(CODE_LINKS_ATTRIBUTE, "");
    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("keydown", onModifierChange);
    window.addEventListener("keyup", onModifierChange);
    window.addEventListener("blur", onModifierChange);
    const withdrawCapability = provideShortcutCapability("codeNavigation", () =>
      inView(document.activeElement),
    );
    // The view is not a `diffFocus` scope: Find and the change keys are the side-by-side view's.
    const releaseCommands = registerCommands(
      {
        "code.goToDeclaration": (event) => {
          event.preventDefault();
          const at = caret.current;
          if (at !== null && at.target.anchor.isConnected) activate(at.target, at.fileDiff);
        },
      },
      {
        capture: true,
        when: (event) => inView(event.target),
        context: () => ({ diffFocus: true }),
      },
    );
    return () => {
      releaseCommands();
      withdrawCapability();
      root.removeAttribute(CODE_LINKS_ATTRIBUTE);
      root.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("keydown", onModifierChange);
      window.removeEventListener("keyup", onModifierChange);
      window.removeEventListener("blur", onModifierChange);
      linkHover.release();
    };
  }, [enabled, root, linkHover, activate]);

  const onTokenClick = (
    token: DiffTokenEventBaseProps,
    event: MouseEvent,
    fileDiff: FileDiffMetadata,
  ) => {
    const target = diffTokenTarget(token, event);
    if (target === null) return;
    if (isNavigationModifier(event)) {
      activate(target, fileDiff);
      return;
    }
    caret.current = { target, fileDiff };
  };

  return { setRoot, onTokenClick: enabled ? onTokenClick : undefined };
}
