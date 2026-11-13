import { isMacPlatform } from "~/lib/utils";

import {
  type CodePointerTarget,
  type CodeWordHit,
  pointerTarget,
  setCodeHighlight,
  wordAtTarget,
  wordHitRange,
} from "./codeNavigationDom";

/** Cmd on macOS, Ctrl elsewhere, with no other modifier: the key of Cmd+click. */
export function isNavigationModifier(event: MouseEvent | KeyboardEvent): boolean {
  const mod = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
  return mod && !event.altKey && !event.shiftKey;
}

/**
 * The Cmd-hover link: while the navigation modifier is held, the word under the pointer is
 * underlined as a link. `enabled` is read on each event, so a surface can turn links off.
 */
export function createCodeLinkHover(enabled: () => boolean) {
  let hovered: CodePointerTarget | null = null;
  let link: CodeWordHit | null = null;
  let modifier = false;

  const update = () => {
    const target = enabled() && modifier ? hovered : null;
    const hit = target === null ? null : wordAtTarget(target);
    const previous = link;
    if (previous && previous.token !== hit?.token) {
      previous.token.removeAttribute("data-code-nav-link");
    }
    link = hit;
    if (hit === null) {
      if (previous) setCodeHighlight("t3-code-link", []);
      return;
    }
    hit.token.setAttribute("data-code-nav-link", "");
    const range = wordHitRange(hit);
    setCodeHighlight("t3-code-link", range === null ? [] : [range]);
  };

  return {
    /** The token under the pointer, if any. */
    hovered: () => hovered,
    pointerMove(event: PointerEvent) {
      hovered = pointerTarget(event);
      modifier = isNavigationModifier(event);
      if (modifier || link) update();
    },
    pointerLeave() {
      hovered = null;
      update();
    },
    /** For the window's keydown, keyup and blur: the modifier can change with the pointer still. */
    modifierChange(event: Event) {
      const pressed = event instanceof KeyboardEvent && isNavigationModifier(event);
      if (pressed === modifier) return;
      modifier = pressed;
      update();
    },
    /** Forgets the pointer, as when the surface shows another file. */
    forget() {
      hovered = null;
    },
    release() {
      link?.token.removeAttribute("data-code-nav-link");
      if (link) setCodeHighlight("t3-code-link", []);
      link = null;
      hovered = null;
    },
  };
}
