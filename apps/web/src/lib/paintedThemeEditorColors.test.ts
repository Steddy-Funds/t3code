import {
  BUILT_IN_THEMES,
  GROVE_THEME,
  MATERIAL_OCEAN_THEME,
  getThemeEditorColors,
} from "@t3tools/shared/themePalettes";
import { describe, expect, it, vi } from "vite-plus/test";

import { getDiffThemeName } from "../hooks/useDiffThemeName";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  THEME_FILE_VERSION,
  THEME_PREVIEW_ID,
  applyThemeColorPreview,
  applyThemePalette,
  getThemeColorsForMode,
  invalidateCustomThemes,
  parseThemeFile,
} from "../themePalette";
import {
  getPaintedThemeEditorColors,
  usePaintedThemeEditorColors,
} from "./paintedThemeEditorColors";
import { themeEditorSurfaceCss } from "./diffRendering";

// Outside React the hook has no renderer: capture the store's subscribe function and read the
// snapshot straight away.
const captured = vi.hoisted(() => ({
  subscribe: null as null | ((listener: () => void) => () => void),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: <T>(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => T,
  ) => {
    captured.subscribe = subscribe;
    return getSnapshot();
  },
}));

const MATERIAL_DARK = getThemeEditorColors(MATERIAL_OCEAN_THEME, "dark");
const CUSTOM = parseThemeFile({
  version: THEME_FILE_VERSION,
  id: "midnight",
  name: "Midnight",
  appearance: "dark",
  colors: { canvas: "#101820" },
});

type FakeRoot = {
  dataset: Record<string, string | undefined>;
  isDark: () => boolean;
  [Symbol.dispose]: () => void;
};

// What `useTheme` does on a theme change: the scheme's class, then the palette.
function paint(theme: string, appearance?: "light" | "dark") {
  document.documentElement.classList.toggle("dark", appearance === "dark");
  applyThemePalette(theme, appearance);
}

// A root the real `applyThemePalette` and `applyThemeColorPreview` paint onto, as on a page.
function mountRoot(storedThemes: unknown = [CUSTOM]): FakeRoot {
  const dataset: Record<string, string | undefined> = {};
  let dark = false;
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) =>
        key === CUSTOM_THEMES_STORAGE_KEY ? JSON.stringify(storedThemes) : null,
    },
  });
  vi.stubGlobal("document", {
    documentElement: {
      dataset,
      classList: {
        toggle: (name: string, force?: boolean) => {
          if (name === "dark") dark = force ?? !dark;
          return dark;
        },
        contains: (name: string) => name === "dark" && dark,
      },
      style: { setProperty: () => {}, removeProperty: () => {} },
    },
  });
  invalidateCustomThemes();
  return {
    dataset,
    isDark: () => dark,
    [Symbol.dispose]() {
      applyThemePalette("system", "light");
      vi.unstubAllGlobals();
      invalidateCustomThemes();
    },
  };
}

function expectStock(appearance: "light" | "dark", label: string) {
  expect(getPaintedThemeEditorColors(), label).toBeNull();
  expect(getDiffThemeName(appearance), label).toBe(
    appearance === "dark" ? "pierre-dark" : "t3-light",
  );
  expect(themeEditorSurfaceCss(getPaintedThemeEditorColors()), label).toBe("");
}

describe("getPaintedThemeEditorColors", () => {
  it("is null with no document", () => {
    vi.stubGlobal("document", undefined);
    try {
      expect(getPaintedThemeEditorColors()).toBeNull();
      expect(usePaintedThemeEditorColors()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is null while the root names no theme, even in the dark scheme", () => {
    using root = mountRoot();
    expect(getPaintedThemeEditorColors()).toBeNull();
    root.dataset.themeId = "";
    expect(getPaintedThemeEditorColors()).toBeNull();
    document.documentElement.classList.toggle("dark", true);
    expect(getPaintedThemeEditorColors()).toBeNull();
  });

  it("is null for an id that is not a built-in", () => {
    using root = mountRoot();
    document.documentElement.classList.toggle("dark", true);
    for (const id of ["no-such-theme", "midnight", "material-ocean-dark", "Material-Ocean"]) {
      root.dataset.themeId = id;
      expect(getPaintedThemeEditorColors(), id).toBeNull();
    }
  });

  it("reads the block off the root's theme id and its dark class", () => {
    using root = mountRoot();
    root.dataset.themeId = "material-ocean";
    expect(getPaintedThemeEditorColors()).toBeNull();
    document.documentElement.classList.toggle("dark", true);
    expect(getPaintedThemeEditorColors()).toBe(MATERIAL_DARK);
    document.documentElement.classList.toggle("dark", false);
    expect(getPaintedThemeEditorColors()).toBeNull();
  });

  it("is what the hook hands a component", () => {
    using root = mountRoot();
    paint("material-ocean", "dark");
    expect(root.dataset.themeId).toBe("material-ocean");
    expect(usePaintedThemeEditorColors()).toBe(MATERIAL_DARK);
    paint("grove", "dark");
    expect(usePaintedThemeEditorColors()).toBeNull();
  });
});

describe("the painted theme, as applyThemePalette and applyThemeColorPreview paint it", () => {
  it("gives Material Ocean its syntax theme, CSS and colours once painted", () => {
    using root = mountRoot();
    paint("material-ocean", "dark");
    expect(root.isDark()).toBe(true);
    expect(getPaintedThemeEditorColors()).toBe(MATERIAL_DARK);
    expect(getDiffThemeName("dark")).toBe("material-deep-ocean");
    const css = themeEditorSurfaceCss(getPaintedThemeEditorColors());
    expect(css).toContain(MATERIAL_DARK!.lineNumber);
    expect(css).toContain(MATERIAL_DARK!.caretRow);
    expect(css).toContain(MATERIAL_DARK!.diff.inserted);
  });

  it("falls back to the stock pair for an appearance the theme has no block for", () => {
    using _root = mountRoot();
    paint("material-ocean", "dark");
    expect(getDiffThemeName("light")).toBe("t3-light");
  });

  it("is stock under the stock light and dark themes, in both appearances", () => {
    using _root = mountRoot();
    for (const preference of ["system", "light", "dark"] as const) {
      for (const appearance of ["light", "dark"] as const) {
        paint(preference, appearance);
        expectStock(appearance, `${preference} ${appearance}`);
      }
    }
  });

  it("is stock under every other built-in theme, in both appearances", () => {
    using _root = mountRoot();
    const others = BUILT_IN_THEMES.filter((theme) => theme.id !== MATERIAL_OCEAN_THEME.id);
    expect(others.length).toBeGreaterThan(0);
    for (const theme of others) {
      for (const appearance of ["light", "dark"] as const) {
        paint(theme.id, appearance);
        expectStock(appearance, `${theme.id} ${appearance}`);
      }
    }
  });

  it("is stock under a custom theme", () => {
    using root = mountRoot();
    paint("midnight", "dark");
    expect(root.dataset.themeId).toBe("midnight");
    expectStock("dark", "midnight dark");
    expect(getDiffThemeName("light")).toBe("t3-light");
  });

  it("is stock under a custom theme that carries an editor block in its file", () => {
    using root = mountRoot([
      {
        id: "sneaky",
        label: "Sneaky",
        appearance: "dark",
        colors: { canvas: "#101820" },
        editor: { dark: MATERIAL_OCEAN_THEME.editor!.dark },
      },
    ]);
    paint("sneaky", "dark");
    expect(root.dataset.themeId).toBe("sneaky");
    expectStock("dark", "sneaky dark");
  });

  it("keeps the built-in's block when a custom theme file reuses its id", () => {
    using root = mountRoot([
      { id: "material-ocean", label: "Mine", appearance: "dark", colors: { canvas: "#000000" } },
    ]);
    paint("material-ocean", "dark");
    expect(root.dataset.themeId).toBe("material-ocean");
    expect(getPaintedThemeEditorColors()).toBe(MATERIAL_DARK);
  });

  it("follows a switch into and out of Material Ocean without a reload", () => {
    using _root = mountRoot();
    paint("grove", "dark");
    expectStock("dark", "grove");
    paint("material-ocean", "dark");
    expect(getDiffThemeName("dark")).toBe("material-deep-ocean");
    paint("midnight", "dark");
    expectStock("dark", "midnight");
    paint("material-ocean", "dark");
    expect(getPaintedThemeEditorColors()).toBe(MATERIAL_DARK);
    paint("system", "light");
    expectStock("light", "system light");
  });

  it("follows an appearance change under Material Ocean", () => {
    using _root = mountRoot();
    paint("material-ocean", "dark");
    expect(getPaintedThemeEditorColors()).toBe(MATERIAL_DARK);
    paint("material-ocean", "light");
    expect(getPaintedThemeEditorColors()).toBeNull();
    expect(getDiffThemeName("dark")).toBe("pierre-dark");
  });

  it("is stock while a theme editor preview is open, even over a painted Material Ocean", () => {
    using root = mountRoot();
    paint("material-ocean", "dark");
    expect(getPaintedThemeEditorColors()).toBe(MATERIAL_DARK);

    applyThemeColorPreview(getThemeColorsForMode(GROVE_THEME, "dark")!, "dark");
    expect(root.dataset.themeId).toBe(THEME_PREVIEW_ID);
    expectStock("dark", "preview dark");

    applyThemeColorPreview(getThemeColorsForMode(GROVE_THEME, "light")!, "light");
    expectStock("light", "preview light");

    // A preview of Material Ocean's own colours is still a draft.
    applyThemeColorPreview(MATERIAL_OCEAN_THEME.colors, "dark");
    expectStock("dark", "preview of material-ocean colours");

    paint("material-ocean", "dark");
    expect(getPaintedThemeEditorColors()).toBe(MATERIAL_DARK);
    expect(getDiffThemeName("dark")).toBe("material-deep-ocean");
  });
});

describe("the store's subscription", () => {
  class FakeObserver {
    static instances: FakeObserver[] = [];
    options: MutationObserverInit | undefined;
    target: unknown;
    disconnected = false;
    constructor(readonly callback: () => void) {
      FakeObserver.instances.push(this);
    }
    observe(target: unknown, options: MutationObserverInit) {
      this.target = target;
      this.options = options;
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  function subscribeFn() {
    usePaintedThemeEditorColors();
    return captured.subscribe!;
  }

  function withObserver(run: (subscribe: (listener: () => void) => () => void) => void) {
    FakeObserver.instances = [];
    const root = { dataset: {}, classList: { contains: () => false } };
    vi.stubGlobal("MutationObserver", FakeObserver);
    vi.stubGlobal("document", { documentElement: root });
    try {
      run(subscribeFn());
    } finally {
      vi.unstubAllGlobals();
    }
    return root;
  }

  it("watches the root's theme id and class, and nothing else", () => {
    const root = withObserver((subscribe) => {
      const unsubscribe = subscribe(() => {});
      expect(FakeObserver.instances).toHaveLength(1);
      expect(FakeObserver.instances[0]!.options).toEqual({
        attributes: true,
        attributeFilter: ["data-theme-id", "class"],
      });
      unsubscribe();
    });
    expect(FakeObserver.instances[0]!.target).toBe(root);
  });

  it("shares one observer and notifies every subscriber", () => {
    withObserver((subscribe) => {
      const first = vi.fn();
      const second = vi.fn();
      const offFirst = subscribe(first);
      const offSecond = subscribe(second);
      expect(FakeObserver.instances).toHaveLength(1);

      FakeObserver.instances[0]!.callback();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);

      offFirst();
      FakeObserver.instances[0]!.callback();
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(2);
      expect(FakeObserver.instances[0]!.disconnected).toBe(false);
      offSecond();
    });
  });

  it("disconnects when the last subscriber leaves, and observes afresh for the next", () => {
    withObserver((subscribe) => {
      const off = subscribe(() => {});
      off();
      expect(FakeObserver.instances[0]!.disconnected).toBe(true);

      const again = subscribe(() => {});
      expect(FakeObserver.instances).toHaveLength(2);
      expect(FakeObserver.instances[1]!.disconnected).toBe(false);
      again();
      expect(FakeObserver.instances[1]!.disconnected).toBe(true);
    });
  });

  it("is a no-op without a document", () => {
    const subscribe = subscribeFn();
    vi.stubGlobal("document", undefined);
    try {
      expect(() => subscribe(() => {})()).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
