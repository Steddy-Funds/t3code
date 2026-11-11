import type { ThemeAppearance } from "@t3tools/shared/themePalettes";

import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import {
  getRenderedAppearance,
  getRenderedThemeEditorColors,
  useRenderedThemeEditorColors,
} from "./useTheme";

/** The syntax theme for code painted at `appearance` under the active theme. */
export function useDiffThemeName(appearance: ThemeAppearance): DiffThemeName {
  return resolveDiffThemeName(appearance, useRenderedThemeEditorColors());
}

/** For code outside React (worker pools, editor plugins) that reads the theme when it paints. */
export function getDiffThemeName(
  appearance: ThemeAppearance = getRenderedAppearance(),
): DiffThemeName {
  return resolveDiffThemeName(appearance, getRenderedThemeEditorColors());
}
