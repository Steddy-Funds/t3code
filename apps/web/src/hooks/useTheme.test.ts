import { GROVE_THEME, MATERIAL_OCEAN_THEME } from "@t3tools/shared/themePalettes";
import { expect, it, vi } from "vite-plus/test";

// Outside React the hook has no renderer: read the snapshot straight away so `useTheme()`
// hands back the real setters.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: <T>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
}));

const EDITOR_PREFIX = "--app-theme-editor-";
const DEEP_OCEAN = "material-deep-ocean";

type Stored = {
  theme?: string;
  mode?: string;
  halves?: unknown;
  systemDark?: boolean;
};

// Each case gets fresh module state and a fake root, so the ambient theme never leaks across cases.
async function setup(stored: Stored = {}) {
  const storage = new Map<string, string>();
  if (stored.theme !== undefined) storage.set("t3code:theme", stored.theme);
  if (stored.mode !== undefined) storage.set("t3code:theme-appearance-mode", stored.mode);
  if (stored.halves !== undefined) {
    storage.set("t3code:theme-halves:v1", JSON.stringify(stored.halves));
  }
  const env = { systemDark: stored.systemDark ?? false, readThrows: false };
  const properties = new Map<string, string>();
  const dataset: Record<string, string> = {};
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => {
        if (env.readThrows) throw new Error("blocked");
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
    matchMedia: () => ({
      matches: env.systemDark,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("document", {
    documentElement: {
      dataset,
      offsetHeight: 0,
      classList: { add: () => {}, remove: () => {}, toggle: () => false },
      style: {
        setProperty: (name: string, value: string) => void properties.set(name, value),
        removeProperty: (name: string) => void properties.delete(name),
      },
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    callback();
    return 0;
  });
  vi.resetModules();
  const theme = await import("./useTheme");
  const diff = await import("./useDiffThemeName");
  const palette = await import("../themePalette");
  return {
    ...theme,
    ...diff,
    applyThemeColorPreview: palette.applyThemeColorPreview,
    getThemeColorsForMode: palette.getThemeColorsForMode,
    env,
    storage,
    dataset,
    editorVariables: () =>
      [...properties.keys()].filter((name) => name.startsWith(EDITOR_PREFIX)).toSorted(),
    [Symbol.dispose]() {
      vi.unstubAllGlobals();
    },
  };
}

it("reads a stored built-in id, and falls back to system for an unknown or missing one", async () => {
  {
    using t = await setup({ theme: "material-ocean" });
    expect(t.readThemePreference()).toBe("material-ocean");
  }
  {
    using t = await setup({ theme: "no-such-theme" });
    expect(t.readThemePreference()).toBe("system");
  }
  {
    using t = await setup();
    expect(t.readThemePreference()).toBe("system");
  }
});

it("paints the stored material-ocean at load, with its syntax theme and editor variables", async () => {
  using t = await setup({ theme: "material-ocean" });
  expect(t.dataset.themeId).toBe("material-ocean");
  expect(t.getRenderedAppearance()).toBe("dark");
  expect(t.getRenderedThemeEditorColors()).toEqual(MATERIAL_OCEAN_THEME.editor?.dark);
  expect(t.getDiffThemeName()).toBe(DEEP_OCEAN);
  expect(t.editorVariables()).toHaveLength(8);
});

it("falls back to the default theme for an unknown stored id without a crash", async () => {
  using t = await setup({ theme: "no-such-theme", systemDark: true });
  expect(t.dataset.themeId).toBeUndefined();
  expect(t.getThemeSnapshot().theme).toBe("system");
  expect(t.getRenderedThemeEditorColors()).toBeNull();
  expect(t.getDiffThemeName()).toBe("pierre-dark");
  expect(t.editorVariables()).toEqual([]);
});

it("keeps the stock pair under every other theme, in both appearances", async () => {
  for (const theme of ["system", "light", "dark", "t3-chat", "grove", "ocean", "ember", "iris"]) {
    for (const [mode, expected] of [
      ["light", "t3-light"],
      ["dark", "pierre-dark"],
    ] as const) {
      using t = await setup({ theme, mode });
      expect(t.getRenderedThemeEditorColors(), `${theme} ${mode}`).toBeNull();
      expect(t.getDiffThemeName(), `${theme} ${mode}`).toBe(expected);
      expect(t.getDiffThemeName("light"), `${theme} ${mode} asked light`).toBe("t3-light");
      expect(t.getDiffThemeName("dark"), `${theme} ${mode} asked dark`).toBe("pierre-dark");
      expect(t.editorVariables(), `${theme} ${mode}`).toEqual([]);
    }
  }
});

it("follows setTheme into and out of material-ocean without a reload", async () => {
  using t = await setup({ theme: "grove", mode: "dark" });
  expect(t.getDiffThemeName()).toBe("pierre-dark");

  expect(t.setTheme("material-ocean")).toBe(true);
  expect(t.getRenderedThemeEditorColors()).toEqual(MATERIAL_OCEAN_THEME.editor?.dark);
  expect(t.getDiffThemeName()).toBe(DEEP_OCEAN);
  expect(t.editorVariables()).toHaveLength(8);

  expect(t.setTheme("ocean")).toBe(true);
  expect(t.getRenderedThemeEditorColors()).toBeNull();
  expect(t.getDiffThemeName()).toBe("pierre-dark");
  expect(t.editorVariables()).toEqual([]);

  expect(t.setTheme("material-ocean")).toBe(true);
  // setTheme keeps the stored appearance mode, so system theme stays dark here.
  expect(t.setTheme("system")).toBe(true);
  expect(t.getDiffThemeName()).toBe("pierre-dark");
  expect(t.editorVariables()).toEqual([]);
});

it("keeps material-ocean dark under every stored appearance mode and OS setting", async () => {
  for (const mode of ["light", "dark", "system"]) {
    for (const systemDark of [true, false]) {
      using t = await setup({ theme: "material-ocean", mode, systemDark });
      expect(t.getRenderedAppearance(), `${mode} ${systemDark}`).toBe("dark");
      expect(t.getDiffThemeName(), `${mode} ${systemDark}`).toBe(DEEP_OCEAN);
    }
  }
});

it("follows an appearance change on a theme with a light half", async () => {
  using t = await setup({ theme: "grove", mode: "light" });
  expect(t.getDiffThemeName()).toBe("t3-light");
  t.setAppearanceMode("dark");
  expect(t.getDiffThemeName()).toBe("pierre-dark");
  t.setAppearanceMode("light");
  expect(t.getDiffThemeName()).toBe("t3-light");
  t.setAppearanceMode("system");
  t.env.systemDark = true;
  t.refreshTheme();
  expect(t.getDiffThemeName()).toBe("pierre-dark");
});

it("falls back to the stock pair when the syntax theme is asked for in the other appearance", async () => {
  using t = await setup({ theme: "material-ocean" });
  expect(t.getDiffThemeName("dark")).toBe(DEEP_OCEAN);
  expect(t.getDiffThemeName("light")).toBe("t3-light");
});

it("follows a dark mix half of material-ocean over another base theme", async () => {
  using t = await setup({ theme: "grove", mode: "dark" });
  const { setThemeHalf, clearThemeHalves } = t.useTheme();
  expect(t.getDiffThemeName()).toBe("pierre-dark");

  expect(setThemeHalf("dark", "material-ocean")).toBe(true);
  expect(t.getRenderedThemeEditorColors()).toEqual(MATERIAL_OCEAN_THEME.editor?.dark);
  expect(t.getDiffThemeName()).toBe(DEEP_OCEAN);
  expect(t.dataset.themeId).toBe("material-ocean");
  expect(t.editorVariables()).toHaveLength(8);

  // The light half is still grove's.
  t.setAppearanceMode("light");
  expect(t.getRenderedThemeEditorColors()).toBeNull();
  expect(t.getDiffThemeName()).toBe("t3-light");
  expect(t.dataset.themeId).toBe("grove");
  expect(t.editorVariables()).toEqual([]);

  t.setAppearanceMode("dark");
  expect(t.getDiffThemeName()).toBe(DEEP_OCEAN);

  expect(setThemeHalf("dark", null)).toBe(true);
  expect(t.getDiffThemeName()).toBe("pierre-dark");
  expect(t.editorVariables()).toEqual([]);

  expect(setThemeHalf("dark", "material-ocean")).toBe(true);
  expect(clearThemeHalves()).toBe(true);
  expect(t.getDiffThemeName()).toBe("pierre-dark");
  expect(t.editorVariables()).toEqual([]);
});

it("ignores material-ocean as a light mix half", async () => {
  using t = await setup({ theme: "grove", mode: "light" });
  const { setThemeHalf } = t.useTheme();
  setThemeHalf("light", "material-ocean");
  expect(t.getRenderedAppearance()).toBe("light");
  expect(t.dataset.themeId).toBe("grove");
  expect(t.getRenderedThemeEditorColors()).toBeNull();
  expect(t.getDiffThemeName()).toBe("t3-light");
  expect(t.editorVariables()).toEqual([]);
});

it("lets a light mix half take over a dark-only base theme in a light OS", async () => {
  using t = await setup({ theme: "material-ocean", mode: "system", systemDark: false });
  const { setThemeHalf, clearThemeHalves } = t.useTheme();
  expect(t.getDiffThemeName()).toBe(DEEP_OCEAN);

  setThemeHalf("light", "grove");
  expect(t.getRenderedAppearance()).toBe("light");
  expect(t.dataset.themeId).toBe("grove");
  expect(t.getRenderedThemeEditorColors()).toBeNull();
  expect(t.getDiffThemeName()).toBe("t3-light");
  expect(t.editorVariables()).toEqual([]);

  t.env.systemDark = true;
  t.refreshTheme();
  expect(t.getDiffThemeName()).toBe(DEEP_OCEAN);
  expect(t.editorVariables()).toHaveLength(8);

  clearThemeHalves();
  t.env.systemDark = false;
  t.refreshTheme();
  expect(t.getDiffThemeName()).toBe(DEEP_OCEAN);
});

it("falls back to the default theme for a stored mix half naming an unknown id", async () => {
  using t = await setup({ theme: "grove", mode: "dark", halves: { dark: "no-such-theme" } });
  expect(t.getThemeSnapshot().themeHalves).toBeNull();
  expect(t.dataset.themeId).toBe("grove");
  expect(t.getDiffThemeName()).toBe("pierre-dark");
  expect(t.editorVariables()).toEqual([]);
});

it("applies a stored dark mix half of material-ocean at load", async () => {
  using t = await setup({ theme: "grove", mode: "dark", halves: { dark: "material-ocean" } });
  expect(t.dataset.themeId).toBe("material-ocean");
  expect(t.getDiffThemeName()).toBe(DEEP_OCEAN);
  expect(t.editorVariables()).toHaveLength(8);
});

it("drops the editor colours while a theme editor preview is open and restores them after", async () => {
  using t = await setup({ theme: "material-ocean" });
  const notifications = vi.fn();
  const unsubscribe = t.subscribeRenderedAppearance(notifications);
  const grove = t.getThemeColorsForMode(GROVE_THEME, "dark")!;

  t.applyThemeColorPreview(grove, "dark");
  expect(notifications).toHaveBeenCalledTimes(1);
  expect(t.getRenderedThemeEditorColors()).toBeNull();
  expect(t.getDiffThemeName()).toBe("pierre-dark");
  expect(t.editorVariables()).toEqual([]);

  t.applyThemeColorPreview(grove, "light");
  expect(t.getRenderedAppearance()).toBe("light");
  expect(t.getDiffThemeName()).toBe("t3-light");

  // A stored-theme change under a preview does not repaint over the draft.
  t.setAppearanceMode("dark");
  expect(t.dataset.themeId).toBe("__preview");
  expect(t.getRenderedThemeEditorColors()).toBeNull();
  expect(t.editorVariables()).toEqual([]);

  notifications.mockClear();
  t.refreshTheme();
  expect(notifications).toHaveBeenCalled();
  expect(t.dataset.themeId).toBe("material-ocean");
  expect(t.getRenderedThemeEditorColors()).toEqual(MATERIAL_OCEAN_THEME.editor?.dark);
  expect(t.getDiffThemeName()).toBe(DEEP_OCEAN);
  expect(t.editorVariables()).toHaveLength(8);
  unsubscribe();
});

it("treats a preview of material-ocean's own colours as a draft with no editor colours", async () => {
  using t = await setup({ theme: "material-ocean" });
  t.applyThemeColorPreview(MATERIAL_OCEAN_THEME.colors, "dark");
  expect(t.getRenderedThemeEditorColors()).toBeNull();
  expect(t.getDiffThemeName()).toBe("pierre-dark");
});

it("tells a worker-pool subscriber about every theme change that can change the syntax theme", async () => {
  using t = await setup({ theme: "grove", mode: "dark" });
  const { setThemeHalf } = t.useTheme();
  const notifications = vi.fn();
  const unsubscribe = t.subscribeRenderedAppearance(notifications);

  t.setTheme("material-ocean");
  expect(notifications).toHaveBeenCalledTimes(1);
  t.setAppearanceMode("light");
  expect(notifications).toHaveBeenCalledTimes(2);
  setThemeHalf("light", "grove");
  expect(notifications).toHaveBeenCalledTimes(3);

  unsubscribe();
  t.setTheme("grove");
  expect(notifications).toHaveBeenCalledTimes(3);
});

it("reports a blocked storage read as a read error", async () => {
  using t = await setup();
  t.env.readThrows = true;
  expect(() => t.readThemePreference()).toThrow(/Failed to read theme preference/);
});
