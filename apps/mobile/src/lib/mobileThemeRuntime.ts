import { resolveTextScaleVariables } from "./appearancePreferences";
import { BUILT_IN_THEME_IDS } from "@t3tools/shared/themePalettes";
import type { UniwindConfig } from "uniwind";
import {
  DEFAULT_MOBILE_THEME_ID,
  getMobileThemeAppearances,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeMode,
} from "./mobileTheme";

/** The themes the stylesheet was generated with: a dark-only built-in has no light variant. */
export type MobileUniwindThemeName = UniwindConfig["themes"][number];

export interface MobileThemeRuntimeState {
  readonly baseFontSize: number;
  readonly themeAppearance: MobileThemeAppearance;
  readonly themeMode: MobileThemeMode;
}

export type MobileThemeRuntimeOperation =
  | {
      readonly kind: "update-text-variables";
      readonly themeName: "light" | "dark" | MobileUniwindThemeName;
      readonly variables: Readonly<Record<string, number>>;
    }
  | {
      readonly kind: "set-appearance-mode";
      readonly appearance: MobileThemeAppearance;
      readonly themeMode: MobileThemeMode;
    };

const UNIWIND_THEME_NAMES: ReadonlyArray<"light" | "dark" | MobileUniwindThemeName> = [
  "light",
  "dark",
  ...BUILT_IN_THEME_IDS.flatMap((themeId) =>
    getMobileThemeAppearances(themeId).map((appearance) =>
      getMobileUniwindThemeName(themeId, appearance),
    ),
  ),
];

export function getMobileUniwindThemeName(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
): MobileUniwindThemeName {
  return themeId === DEFAULT_MOBILE_THEME_ID ||
    themeId === "material-you" ||
    !getMobileThemeAppearances(themeId).includes(appearance)
    ? appearance
    : (`${themeId}-${appearance}` as MobileUniwindThemeName);
}

export function createMobileThemeRuntimeOperations(
  previous: MobileThemeRuntimeState | null,
  next: MobileThemeRuntimeState,
): ReadonlyArray<MobileThemeRuntimeOperation> {
  const operations: MobileThemeRuntimeOperation[] = [];

  if (previous === null || previous.baseFontSize !== next.baseFontSize) {
    const variables = resolveTextScaleVariables(next.baseFontSize);
    for (const themeName of UNIWIND_THEME_NAMES) {
      operations.push({ kind: "update-text-variables", themeName, variables });
    }
  }

  if (previous === null || previous.themeMode !== next.themeMode) {
    operations.push({
      kind: "set-appearance-mode",
      appearance: next.themeAppearance,
      themeMode: next.themeMode,
    });
  }

  return operations;
}
