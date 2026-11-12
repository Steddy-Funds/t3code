import { useEffect, useState } from "react";

import { observeResize } from "~/lib/observeResize";

// Room for a readable conversation beside the docked editor.
const COMPOSER_DOCK_MIN_WORKSPACE_PX = 1200;

/** Whether the chat workspace holding `composerOverlay` is wide enough to dock the composer. */
export function useComposerDockFits(composerOverlay: HTMLElement | null): boolean {
  const [fits, setFits] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the chat workspace's rendered width
  useEffect(() => {
    const workspace = composerOverlay?.parentElement;
    if (!workspace) return;
    return observeResize(workspace, (entries) => {
      const width = entries.at(-1)?.contentRect.width ?? 0;
      setFits(width >= COMPOSER_DOCK_MIN_WORKSPACE_PX);
    });
  }, [composerOverlay]);
  return fits;
}
