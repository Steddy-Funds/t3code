import { BUILT_IN_THEMES, MATERIAL_OCEAN_THEME } from "@t3tools/shared/themePalettes";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  applyTerminalAttachStreamEvent,
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  nextTerminalAttachSeedState,
} from "@t3tools/client-runtime/state/terminal";

import {
  shouldHandleTerminalExit,
  synchronizeTerminalOutput,
  synchronizeTerminalSession,
  terminalThemeFromApp,
} from "./ThreadTerminalDrawer";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  THEME_FILE_VERSION,
  applyThemeColorPreview,
  applyThemePalette,
  invalidateCustomThemes,
  parseThemeFile,
} from "../themePalette";

describe("terminal selection actions", () => {
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
  terminal.resetAndWrite.mockClear();
  synchronizeTerminalOutput(terminal, cleared, observedCursor);
  expect(terminal.resetAndWrite).not.toHaveBeenCalled();
  expect(terminal.write).toHaveBeenLastCalledWith("\u001b[H\u001b[2J\u001b[3J");
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

  const snapshot = {
    threadId: "thread",
    terminalId: "term-1",
    cwd: "/repo",
    worktreePath: null,
    status: "error" as const,
    pid: null,
    history: "",
    exitCode: null,
    exitSignal: null,
    label: "Terminal",
    updatedAt: "2026-11-15T00:00:00.000Z",
    error: "Terminal attach failed",
  };
  const attached = applyTerminalAttachStreamEvent(nextTerminalAttachSeedState(), {
    type: "snapshot",
    snapshot,
  });
  const cursor = synchronizeTerminalSession(
    terminal,
    failed,
    attached,
    INITIAL_TERMINAL_OUTPUT_CURSOR,
  );
  terminal.write.mockClear();
  const reconnected = applyTerminalAttachStreamEvent(attached, { type: "snapshot", snapshot });
  synchronizeTerminalSession(terminal, attached, reconnected, cursor);
  expect(terminal.resetAndWrite).toHaveBeenLastCalledWith("");
  expect(terminal.write).toHaveBeenCalledWith("\r\n[terminal] Terminal attach failed\r\n");
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
  const materialAnsi = MATERIAL_OCEAN_THEME.editor?.dark?.ansi ?? [];
  const CUSTOM = parseThemeFile({
    version: THEME_FILE_VERSION,
    id: "midnight",
    name: "Midnight",
    appearance: "dark",
    colors: { canvas: "#101820" },
  });

  // A page the real `applyThemePalette` paints onto, the way `useTheme` does on a theme change.
  function mountPage() {
    let dark = false;
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) =>
          key === CUSTOM_THEMES_STORAGE_KEY ? JSON.stringify([CUSTOM]) : null,
      },
    });
    vi.stubGlobal("document", {
      documentElement: {
        dataset: {},
        classList: {
          toggle: (name: string, force?: boolean) => {
            if (name === "dark") dark = force ?? !dark;
            return dark;
          },
          contains: (name: string) => name === "dark" && dark,
        },
        style: { setProperty: () => {}, removeProperty: () => {} },
      },
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
    invalidateCustomThemes();
    return {
      paint(theme: string, appearance: "light" | "dark") {
        document.documentElement.classList.toggle("dark", appearance === "dark");
        applyThemePalette(theme, appearance);
      },
      palette: () => terminalThemeFromApp().palette,
      [Symbol.dispose]() {
        applyThemePalette("system", "light");
        vi.unstubAllGlobals();
        invalidateCustomThemes();
      },
    };
  }

  it("uses the stock palette under the stock light and dark themes", () => {
    using page = mountPage();
    for (const preference of ["system", "light", "dark"]) {
      page.paint(preference, "light");
      expect(page.palette(), `${preference} light`).toEqual(toColors(STOCK_LIGHT));
      page.paint(preference, "dark");
      expect(page.palette(), `${preference} dark`).toEqual(toColors(STOCK_DARK));
    }
  });

  it("uses the stock palette under every other built-in theme, in both appearances", () => {
    using page = mountPage();
    const others = BUILT_IN_THEMES.filter((theme) => theme.id !== MATERIAL_OCEAN_THEME.id);
    expect(others.length).toBeGreaterThan(0);
    for (const theme of others) {
      page.paint(theme.id, "light");
      expect(page.palette(), `${theme.id} light`).toEqual(toColors(STOCK_LIGHT));
      page.paint(theme.id, "dark");
      expect(page.palette(), `${theme.id} dark`).toEqual(toColors(STOCK_DARK));
    }
  });

  it("uses the stock palette under a custom theme", () => {
    using page = mountPage();
    page.paint("midnight", "dark");
    expect(page.palette()).toEqual(toColors(STOCK_DARK));
    page.paint("midnight", "light");
    expect(page.palette()).toEqual(toColors(STOCK_LIGHT));
  });

  it("takes material-ocean's own ANSI colours, and caches them", () => {
    expect(materialAnsi).toHaveLength(16);
    using page = mountPage();
    page.paint("material-ocean", "dark");
    expect(page.palette()).toEqual(toColors(materialAnsi));
    expect(page.palette()).not.toEqual(toColors(STOCK_DARK));
    expect(page.palette()).toBe(page.palette());
  });

  it("keeps the stock light palette when material-ocean is painted in light", () => {
    using page = mountPage();
    page.paint("material-ocean", "light");
    expect(page.palette()).toEqual(toColors(STOCK_LIGHT));
  });

  it("follows a switch into and out of material-ocean", () => {
    using page = mountPage();
    page.paint("grove", "dark");
    expect(page.palette()).toEqual(toColors(STOCK_DARK));
    page.paint("material-ocean", "dark");
    expect(page.palette()).toEqual(toColors(materialAnsi));
    page.paint("grove", "dark");
    expect(page.palette()).toEqual(toColors(STOCK_DARK));
  });

  it("is the stock palette while a theme editor preview is open, even over material-ocean", () => {
    using page = mountPage();
    page.paint("material-ocean", "dark");
    expect(page.palette()).toEqual(toColors(materialAnsi));
    applyThemeColorPreview(MATERIAL_OCEAN_THEME.colors, "dark");
    expect(page.palette()).toEqual(toColors(STOCK_DARK));
    applyThemeColorPreview(MATERIAL_OCEAN_THEME.colors, "light");
    expect(page.palette()).toEqual(toColors(STOCK_LIGHT));
    page.paint("material-ocean", "dark");
    expect(page.palette()).toEqual(toColors(materialAnsi));
  });
});
