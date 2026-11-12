import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_THEME_IDS } from "@t3tools/shared/themePalettes";
import {
  DEFAULT_MOBILE_THEME_ID,
  MOBILE_THEME_IDS,
  type MobileThemeAppearance,
} from "./mobileTheme";
import {
  createMobileThemeRuntimeOperations,
  getMobileUniwindThemeName,
  type MobileThemeRuntimeState,
} from "./mobileThemeRuntime";

const generatedThemeNames: ReadonlyArray<string> = JSON.parse(
  NodeFS.readFileSync(
    NodePath.resolve(import.meta.dirname, "../../generated-uniwind-theme-names.json"),
    "utf8",
  ),
);
const generatedCSS = NodeFS.readFileSync(
  NodePath.resolve(import.meta.dirname, "../../generated-uniwind-themes.css"),
  "utf8",
);
const APPEARANCES: ReadonlyArray<MobileThemeAppearance> = ["light", "dark"];

const initialState: MobileThemeRuntimeState = {
  baseFontSize: 16,
  themeAppearance: "light",
  themeMode: "system",
};

describe("mobileThemeRuntime", () => {
  it("lets system appearance changes flow through the root ScopedTheme only", () => {
    const operations = createMobileThemeRuntimeOperations(initialState, {
      ...initialState,
      themeAppearance: "dark",
    });

    expect(operations).toEqual([]);
  });
});

describe("getMobileUniwindThemeName", () => {
  const known = new Set(["light", "dark", ...generatedThemeNames]);

  it("never names a theme the generated stylesheet lacks", () => {
    for (const themeId of MOBILE_THEME_IDS) {
      for (const appearance of APPEARANCES) {
        const name = getMobileUniwindThemeName(themeId, appearance);
        expect(known.has(name), `${themeId} ${appearance} -> ${name}`).toBe(true);
        if (name !== "light" && name !== "dark") {
          expect(generatedCSS, name).toContain(`@variant ${name} {`);
        }
      }
    }
  });

  it("names a dark-only theme for dark and falls back to the plain appearance for light", () => {
    expect(getMobileUniwindThemeName("material-ocean", "dark")).toBe("material-ocean-dark");
    expect(getMobileUniwindThemeName("material-ocean", "light")).toBe("light");
  });

  it("names both variants of a built-in with a light palette", () => {
    for (const themeId of BUILT_IN_THEME_IDS.filter((id) => id !== "material-ocean")) {
      expect(getMobileUniwindThemeName(themeId, "light")).toBe(`${themeId}-light`);
      expect(getMobileUniwindThemeName(themeId, "dark")).toBe(`${themeId}-dark`);
    }
  });

  it("uses the plain appearance for the default theme and Material You", () => {
    for (const themeId of [DEFAULT_MOBILE_THEME_ID, "material-you"] as const) {
      expect(getMobileUniwindThemeName(themeId, "light")).toBe("light");
      expect(getMobileUniwindThemeName(themeId, "dark")).toBe("dark");
    }
  });
});

describe("text scale operations", () => {
  it("updates the dark-only theme's dark variant and no light one", () => {
    const operations = createMobileThemeRuntimeOperations(null, {
      baseFontSize: 16,
      themeAppearance: "dark",
      themeMode: "dark",
    });
    const names = operations.flatMap((operation) =>
      operation.kind === "update-text-variables" ? [operation.themeName] : [],
    );
    expect(names).toContain("material-ocean-dark");
    expect(names).not.toContain("material-ocean-light");
    for (const name of names) {
      expect(["light", "dark", ...generatedThemeNames], name).toContain(name);
    }
  });
});
