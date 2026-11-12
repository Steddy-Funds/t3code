import { useLayoutEffect } from "react";

import { observeResize } from "~/lib/observeResize";

const DOCKED_EDITOR_HEIGHT_PROPERTY = "--docked-editor-height";

/**
 * Grows the docked composer's editor into the column's spare height. Sizing it here instead of
 * stretching each wrapper with `:has()` keeps style recalcs cheap while the timeline streams.
 */
export function useDockedEditorFill(overlay: HTMLElement | null, docked: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sizes the docked editor from the overlay's measured height before paint
  useLayoutEffect(() => {
    if (!overlay || !docked) return;
    const stack = overlay.querySelector<HTMLElement>('[data-chat-composer-stack="true"]');
    if (!stack) return;
    const fill = () => {
      const editor = overlay.querySelector<HTMLElement>("[data-composer-rich-text]");
      if (!editor) return;
      const styles = getComputedStyle(overlay);
      const room =
        overlay.clientHeight -
        Number.parseFloat(styles.paddingTop) -
        Number.parseFloat(styles.paddingBottom);
      const height = Math.max(0, Math.floor(editor.offsetHeight + room - stack.offsetHeight));
      overlay.style.setProperty(DOCKED_EDITOR_HEIGHT_PROPERTY, `${height}px`);
    };
    fill();
    const stopObserving = observeResize([overlay, stack], fill);
    return () => {
      stopObserving();
      overlay.style.removeProperty(DOCKED_EDITOR_HEIGHT_PROPERTY);
    };
  }, [overlay, docked]);
}
