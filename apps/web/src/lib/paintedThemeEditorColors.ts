import {
  BUILT_IN_THEMES,
  getThemeEditorColors,
  type ThemeEditorColors,
} from "@t3tools/shared/themePalettes";
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let observer: MutationObserver | undefined;

function subscribe(listener: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(() => {
      for (const notify of listeners) notify();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme-id", "class"],
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    observer?.disconnect();
    observer = undefined;
  };
}

/**
 * The painted theme's own code and terminal colours, read from the root element the theme is
 * applied to: null under the stock themes, a theme without them, and a theme editor preview.
 * Only built-in themes carry them.
 */
export function getPaintedThemeEditorColors(): ThemeEditorColors | null {
  if (typeof document === "undefined") return null;
  const root = document.documentElement;
  const themeId = root.dataset?.themeId;
  if (!themeId) return null;
  const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === themeId) ?? null;
  return getThemeEditorColors(theme, root.classList.contains("dark") ? "dark" : "light");
}

export function usePaintedThemeEditorColors(): ThemeEditorColors | null {
  return useSyncExternalStore(subscribe, getPaintedThemeEditorColors, () => null);
}
