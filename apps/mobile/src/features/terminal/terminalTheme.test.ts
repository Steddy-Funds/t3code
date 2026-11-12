import {
  GROVE_THEME,
  MATERIAL_OCEAN_THEME,
  getThemeColorsForAppearance,
} from "@t3tools/shared/themePalettes";
import { describe, expect, it } from "vite-plus/test";

import {
  MOBILE_THEME_IDS,
  getMobileThemeVariables,
  themeColorToNativeColor,
} from "../../lib/mobileTheme";
import { getMobileTerminalTheme } from "./terminalTheme";

// The palettes mobile terminals have always used, pinned as literals.
const STOCK_PALETTES = {
  light: [
    "#1F1F21",
    "#ff2e3f",
    "#0dbe4e",
    "#ffca00",
    "#009fff",
    "#c635e4",
    "#08c0ef",
    "#c6c6c8",
    "#1F1F21",
    "#ff2e3f",
    "#0dbe4e",
    "#ffca00",
    "#009fff",
    "#c635e4",
    "#08c0ef",
    "#c6c6c8",
  ],
  dark: [
    "#141415",
    "#ff2e3f",
    "#0dbe4e",
    "#ffca00",
    "#009fff",
    "#c635e4",
    "#08c0ef",
    "#c6c6c8",
    "#141415",
    "#ff2e3f",
    "#0dbe4e",
    "#ffca00",
    "#009fff",
    "#c635e4",
    "#08c0ef",
    "#c6c6c8",
  ],
} as const;

describe("getMobileTerminalTheme", () => {
  it("takes material-ocean's own ANSI colours in dark", () => {
    const theme = getMobileTerminalTheme("material-ocean", "dark");
    expect(theme.palette).toEqual(MATERIAL_OCEAN_THEME.editor?.dark?.ansi);
    expect(theme.palette).toHaveLength(16);
  });

  it("paints material-ocean's terminal in Material Deep Ocean", () => {
    const theme = getMobileTerminalTheme("material-ocean", "dark");
    expect(theme.background.toLowerCase()).toBe("#0f111a");
    expect(theme.foreground.toLowerCase()).toBe("#c3cee3");
    expect(theme.cursorForeground.toLowerCase()).toBe("#ffcc00");
    expect(theme.cursorBackground).toBe(theme.background);
    expect(theme.border).toBe(getMobileThemeVariables("material-ocean", "dark")["--color-border"]);
  });

  it("keeps the stock palette for every other theme, in both appearances", () => {
    for (const themeId of MOBILE_THEME_IDS.filter((id) => id !== "material-ocean")) {
      for (const scheme of ["light", "dark"] as const) {
        expect(getMobileTerminalTheme(themeId, scheme).palette, `${themeId} ${scheme}`).toEqual(
          STOCK_PALETTES[scheme],
        );
      }
    }
  });

  it("keeps the stock palette when material-ocean is asked for light", () => {
    expect(getMobileTerminalTheme("material-ocean", "light").palette).toEqual(STOCK_PALETTES.light);
  });

  it("paints another theme's terminal from its own colours", () => {
    const colors = getThemeColorsForAppearance(GROVE_THEME, "dark")!;
    const theme = getMobileTerminalTheme("grove", "dark");
    expect(theme.background).toBe(themeColorToNativeColor(colors.terminalBackground));
    expect(theme.foreground).toBe(themeColorToNativeColor(colors.terminalForeground));
  });
});
