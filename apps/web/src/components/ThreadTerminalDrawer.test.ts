import { MATERIAL_OCEAN_THEME } from "@t3tools/shared/themePalettes";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyTerminalAttachStreamEvent,
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  nextTerminalAttachSeedState,
} from "@t3tools/client-runtime/state/terminal";

import {
  shouldClearTerminalSelectionAction,
  shouldHandleTerminalExit,
  synchronizeTerminalOutput,
  synchronizeTerminalSession,
} from "./ThreadTerminalDrawer";

describe("terminal selection actions", () => {
  it("does not let an old selection popup cancel its replacement right-click menu", () => {
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: false,
        openMenuRequestId: 3,
        currentRequestId: 4,
      }),
    ).toBe(false);
    expect(
      shouldClearTerminalSelectionAction({
        actionPending: false,
        openMenuRequestId: null,
        currentRequestId: 4,
      }),
    ).toBe(false);
  });

  it("handles an exit that lands while the terminal surface is still loading", () => {
    expect(shouldHandleTerminalExit("exited", "running", false, 1)).toBe(true);
    expect(shouldHandleTerminalExit("exited", "exited", false, 1)).toBe(false);
    expect(shouldHandleTerminalExit("closed", "running", true, 1)).toBe(false);
  });
});

it("retains visible output and selection until a replacement subscription receives its snapshot", () => {
  const terminal = {
    resetAndWrite: vi.fn(),
    write: vi.fn(),
    getSelection: vi.fn(() => "selected"),
    getSelectionCellCount: vi.fn(() => 8),
    clearSelection: vi.fn(),
  };
  const snapshot = {
    threadId: "thread",
    terminalId: "term-1",
    cwd: "/repo",
    worktreePath: null,
    status: "running" as const,
    pid: 123,
    history: "host output",
    exitCode: null,
    exitSignal: null,
    label: "Terminal 1",
    updatedAt: "2026-09-05T00:00:00.000Z",
  };
  const attached = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
    type: "snapshot",
    snapshot,
  });
  const cursor = synchronizeTerminalOutput(terminal, attached, INITIAL_TERMINAL_OUTPUT_CURSOR);
  expect(terminal.resetAndWrite).toHaveBeenLastCalledWith("host output");
  terminal.resetAndWrite.mockClear();
  terminal.clearSelection.mockClear();

  const pending = combineTerminalSessionState(
    { ...snapshot, hasRunningSubprocess: false },
    EMPTY_TERMINAL_BUFFER_STATE,
  );
  expect(pending.status).toBe("running");
  expect(synchronizeTerminalOutput(terminal, pending, cursor)).toBe(cursor);
  expect(terminal.resetAndWrite).not.toHaveBeenCalled();
  expect(terminal.write).not.toHaveBeenCalled();
  expect(terminal.clearSelection).not.toHaveBeenCalled();

  const observed = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
    type: "snapshot",
    snapshot: { ...snapshot, history: "host output\nobserved output" },
  });
  const observedCursor = synchronizeTerminalOutput(terminal, observed, cursor);
  expect(terminal.resetAndWrite).toHaveBeenLastCalledWith("host output\nobserved output");

  const cleared = applyTerminalAttachStreamEvent(observed, {
    type: "cleared",
    threadId: "thread",
    terminalId: "term-1",
  });
  synchronizeTerminalOutput(terminal, cleared, observedCursor);
  expect(terminal.resetAndWrite).toHaveBeenLastCalledWith("");
});

it("reports an attach failure that leaves the output unchanged", () => {
  const terminal = {
    resetAndWrite: vi.fn(),
    write: vi.fn(),
    getSelection: vi.fn(() => "selected"),
    getSelectionCellCount: vi.fn(() => 8),
    clearSelection: vi.fn(),
  };
  const previous = { ...EMPTY_TERMINAL_BUFFER_STATE, error: null };
  const failed = { ...previous, error: "Terminal attach failed" };

  expect(
    synchronizeTerminalSession(terminal, previous, failed, INITIAL_TERMINAL_OUTPUT_CURSOR),
  ).toBe(INITIAL_TERMINAL_OUTPUT_CURSOR);
  expect(terminal.write).toHaveBeenCalledWith("\r\n[terminal] Terminal attach failed\r\n");
  expect(terminal.resetAndWrite).not.toHaveBeenCalled();
  expect(terminal.getSelection).not.toHaveBeenCalled();
  expect(terminal.getSelectionCellCount).not.toHaveBeenCalled();
  expect(terminal.clearSelection).not.toHaveBeenCalled();
});

describe("terminal palette under each theme", () => {
  const STOCK_LIGHT = [
    "#000000",
    "#cd3131",
    "#107c10",
    "#949800",
    "#0451a5",
    "#bc05bc",
    "#0598bc",
    "#555555",
    "#666666",
    "#cd3131",
    "#14ce14",
    "#b5ba00",
    "#0451a5",
    "#bc05bc",
    "#0598bc",
    "#a5a5a5",
  ];
  const STOCK_DARK = [
    "#000000",
    "#cd3131",
    "#0dbc79",
    "#e5e510",
    "#2472c8",
    "#bc3fbc",
    "#11a8cd",
    "#e5e5e5",
    "#666666",
    "#f14c4c",
    "#23d18b",
    "#f5f543",
    "#3b8eea",
    "#d670d6",
    "#29b8db",
    "#e5e5e5",
  ];
  const toColors = (hexes: ReadonlyArray<string>) =>
    hexes.map((hex) => {
      const value = Number.parseInt(hex.slice(1), 16);
      return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
    });
  const materialAnsi = MATERIAL_OCEAN_THEME.editor?.dark.ansi ?? [];

  async function setup(
    stored: { theme?: string; mode?: string; customThemes?: unknown; halves?: unknown } = {},
  ) {
    const storage = new Map<string, string>();
    if (stored.theme !== undefined) storage.set("t3code:theme", stored.theme);
    if (stored.mode !== undefined) storage.set("t3code:theme-appearance-mode", stored.mode);
    if (stored.customThemes !== undefined) {
      storage.set("t3code:themes:v1", JSON.stringify(stored.customThemes));
    }
    if (stored.halves !== undefined) {
      storage.set("t3code:theme-halves:v1", JSON.stringify(stored.halves));
    }
    let dark = false;
    const root = {
      dataset: {} as Record<string, string>,
      offsetHeight: 0,
      classList: {
        add: () => {},
        remove: () => {},
        contains: (name: string) => name === "dark" && dark,
        toggle: (name: string, force?: boolean) => {
          if (name === "dark") dark = force ?? !dark;
          return dark;
        },
      },
      style: { setProperty: () => {}, removeProperty: () => {} },
    };
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
      },
      matchMedia: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    vi.stubGlobal("document", {
      documentElement: root,
      body: {},
      querySelector: () => null,
      // No 2d context: colours fall back to the parsed defaults, the palette is what's under test.
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    });
    vi.stubGlobal("getComputedStyle", () => ({
      colorScheme: dark ? "dark" : "light",
      backgroundColor: "",
      color: "",
      getPropertyValue: () => "",
    }));
    vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
      callback();
      return 0;
    });
    vi.resetModules();
    const drawer = await import("./ThreadTerminalDrawer");
    const theme = await import("../hooks/useTheme");
    const palette = await import("../themePalette");
    return {
      ...theme,
      applyThemeColorPreview: palette.applyThemeColorPreview,
      parseThemeFile: palette.parseThemeFile,
      palette: () => drawer.terminalThemeFromApp().palette,
      [Symbol.dispose]() {
        vi.unstubAllGlobals();
      },
    };
  }

  it("uses the stock palette under the stock light and dark themes", async () => {
    {
      using t = await setup({ theme: "system", mode: "light" });
      expect(t.palette()).toEqual(toColors(STOCK_LIGHT));
    }
    {
      using t = await setup({ theme: "system", mode: "dark" });
      expect(t.palette()).toEqual(toColors(STOCK_DARK));
    }
    {
      using t = await setup({ theme: "dark" });
      expect(t.palette()).toEqual(toColors(STOCK_DARK));
    }
  });

  it("uses the stock palette under every other built-in theme, in both appearances", async () => {
    for (const theme of ["t3-chat", "grove", "ocean", "ember", "iris"]) {
      for (const [mode, expected] of [
        ["light", STOCK_LIGHT],
        ["dark", STOCK_DARK],
      ] as const) {
        using t = await setup({ theme, mode });
        expect(t.palette(), `${theme} ${mode}`).toEqual(toColors(expected));
      }
    }
  });

  it("uses the stock palette under a custom theme", async () => {
    using probe = await setup();
    const custom = probe.parseThemeFile({
      version: 1,
      id: "midnight",
      name: "Midnight",
      appearance: "dark",
      colors: { canvas: "#101820" },
    });
    using t = await setup({ theme: "midnight", mode: "dark", customThemes: [custom] });
    expect(t.getThemeSnapshot().theme).toBe("midnight");
    expect(t.palette()).toEqual(toColors(STOCK_DARK));
  });

  it("takes material-ocean's own ANSI colours", async () => {
    expect(materialAnsi).toHaveLength(16);
    using t = await setup({ theme: "material-ocean" });
    expect(t.getRenderedAppearance()).toBe("dark");
    expect(t.palette()).toEqual(toColors(materialAnsi));
    expect(t.palette()).not.toEqual(toColors(STOCK_DARK));
  });

  it("returns the same palette array on repeated reads under material-ocean", async () => {
    using t = await setup({ theme: "material-ocean" });
    expect(t.palette()).toBe(t.palette());
  });

  it("follows setTheme into and out of material-ocean", async () => {
    using t = await setup({ theme: "grove", mode: "dark" });
    expect(t.palette()).toEqual(toColors(STOCK_DARK));
    t.setTheme("material-ocean");
    expect(t.palette()).toEqual(toColors(materialAnsi));
    t.setTheme("grove");
    expect(t.palette()).toEqual(toColors(STOCK_DARK));
  });

  it("takes material-ocean's palette for a dark mix half, and the stock one for the light half", async () => {
    {
      using t = await setup({ theme: "grove", mode: "dark", halves: { dark: "material-ocean" } });
      expect(t.palette()).toEqual(toColors(materialAnsi));
    }
    {
      using t = await setup({ theme: "grove", mode: "light", halves: { dark: "material-ocean" } });
      expect(t.palette()).toEqual(toColors(STOCK_LIGHT));
    }
  });

  it("keeps the stock palette for an unknown mix half", async () => {
    using t = await setup({ theme: "grove", mode: "dark", halves: { dark: "no-such-theme" } });
    expect(t.palette()).toEqual(toColors(STOCK_DARK));
  });

  it("falls back to the stock palette while a theme editor preview is open, even over a stored material-ocean", async () => {
    using t = await setup({ theme: "material-ocean" });
    expect(t.palette()).toEqual(toColors(materialAnsi));
    t.applyThemeColorPreview(MATERIAL_OCEAN_THEME.colors, "dark");
    expect(t.palette()).toEqual(toColors(STOCK_DARK));
    t.applyThemeColorPreview(MATERIAL_OCEAN_THEME.colors, "light");
    expect(t.palette()).toEqual(toColors(STOCK_LIGHT));
    t.refreshTheme();
    expect(t.palette()).toEqual(toColors(materialAnsi));
  });
});
