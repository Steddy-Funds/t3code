import type { ThemeAppearance } from "@t3tools/shared/themePalettes";

import {
  resolveDiffThemeName,
  themeEditorSurfaceCss,
  type DiffThemeName,
} from "../lib/diffRendering";
import {
  getPaintedThemeEditorColors,
  usePaintedThemeEditorColors,
} from "../lib/paintedThemeEditorColors";

/** The syntax theme for code painted at `appearance` under the active theme. */
export function useDiffThemeName(appearance: ThemeAppearance): DiffThemeName {
  return resolveDiffThemeName(appearance, usePaintedThemeEditorColors());
}

/** For code outside React (worker pools, editor plugins) that reads the theme when it paints. */
export function getDiffThemeName(appearance: ThemeAppearance): DiffThemeName {
  return resolveDiffThemeName(appearance, getPaintedThemeEditorColors());
}

/** CSS to append to a code surface's own: empty unless the active theme has editor colours. */
export function useThemeEditorSurfaceCss(): string {
  return themeEditorSurfaceCss(usePaintedThemeEditorColors());
}
