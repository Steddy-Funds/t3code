import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import { __setClientSettingsForTests } from "~/hooks/useSettings";
import "~/index.css";
import { act, fakeTimers, render } from "../../test/render";
import { ShortcutQuickReference } from "./ShortcutQuickReference";

// The defaults, plus the commands another branch adds behind a focus scope: 90 or more in all.
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig, DEFAULT_KEYBINDINGS } =
    await import("@t3tools/shared/keybindings");
  const letters = [..."abcdefghijklmnopqrstuvwxyz"];
  const chords = [
    ...[...letters, ..."0123456789"].map((key) => `mod+alt+shift+${key}`),
    ...letters.slice(0, 19).map((key) => `ctrl+alt+${key}`),
  ];
  const codeRules = chords.map((chord, index) => ({
    key: chord,
    command: `code.action${index + 1}` as never,
    when: "codeFocus",
  }));
  return {
    ...actual,
    primaryServerKeybindingsAtom: Atom.make(
      compileResolvedKeybindingsConfig([...DEFAULT_KEYBINDINGS, ...codeRules]),
    ),
  };
});

async function setup(settings: Partial<ClientSettings> = {}) {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, ...settings });
  await page.viewport(1280, 720);
}

const macPlatform = () => vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");

const overlay = () => document.querySelector<HTMLElement>("[data-shortcut-quick-reference]");
const row = (label: string) =>
  [...(overlay()?.querySelectorAll("span") ?? [])].find((span) => span.textContent === label)
    ?.parentElement ?? null;
const isDimmed = (label: string) => row(label)?.hasAttribute("data-dimmed");

const send = (event: Event, target: EventTarget = document.body) =>
  act(() => void target.dispatchEvent(event));
const key = (
  type: "keydown" | "keyup",
  name: string,
  held: { readonly meta?: boolean; readonly shift?: boolean; readonly alt?: boolean } = {},
) =>
  send(
    new KeyboardEvent(type, {
      key: name,
      bubbles: true,
      cancelable: true,
      metaKey: held.meta === true,
      shiftKey: held.shift === true,
      altKey: held.alt === true,
    }),
  );
const holdCmd = () => key("keydown", "Meta", { meta: true });
const releaseCmd = () => key("keyup", "Meta");
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

function append<T extends HTMLElement>(parent: Node, element: T, style = ""): T {
  element.style.cssText = style;
  parent.appendChild(element);
  return element;
}

describe("ShortcutQuickReference", () => {
  it("lists the shortcuts of the focused context once Cmd has been held alone for 700 ms", async () => {
    await setup();
    using _platform = macPlatform();
    await using screen = await render(<ShortcutQuickReference />);
    using _timers = fakeTimers();

    await holdCmd();
    await wait(300);
    // Browsers re-send a pointer that has not moved when content shifts under it.
    await send(new PointerEvent("pointermove", { bubbles: true, screenX: 40, screenY: 40 }));
    await send(new PointerEvent("pointermove", { bubbles: true, screenX: 40, screenY: 40 }));
    await wait(399);
    expect(overlay()).toBeNull();
    await wait(1);
    expect(row("Command Palette: Toggle")?.textContent).toContain("⌘K");
    expect(row("Terminal: Split")).toBeNull();
    expect(row("Code: Action1")).toBeNull();

    await releaseCmd();
    expect(overlay()).toBeNull();

    const terminal = append(screen.container, document.createElement("div"));
    terminal.dataset.terminalOwner = "drawer";
    terminal.tabIndex = 0;
    terminal.focus();
    await holdCmd();
    await wait(700);
    expect(row("Terminal: Split")?.textContent).toContain("⌘D");
    expect(row("Command Palette: Toggle")).toBeNull();
  });

  it("only watches: focus, keys and clicks go where they went before", async () => {
    await setup();
    using _platform = macPlatform();
    const onClick = vi.fn();
    await using screen = await render(
      <>
        <button type="button" className="fixed inset-0" onClick={onClick}>
          Under the list
        </button>
        <ShortcutQuickReference />
      </>,
    );
    using _timers = fakeTimers();
    const button = screen.getByRole("button", { name: "Under the list" });
    button.element().focus();
    const onKeyDown = vi.fn();
    window.addEventListener("keydown", onKeyDown);
    using _listener = {
      [Symbol.dispose]: () => window.removeEventListener("keydown", onKeyDown),
    };

    await holdCmd();
    await wait(700);
    expect(overlay()).not.toBeNull();
    expect(document.activeElement).toBe(button.element());

    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();

    await releaseCmd();
    await holdCmd();
    await wait(700);
    expect(overlay()).not.toBeNull();
    const chord = new KeyboardEvent("keydown", {
      key: "k",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    await send(chord, button.element());
    expect(chord.defaultPrevented).toBe(false);
    expect(onKeyDown).toHaveBeenLastCalledWith(chord);
    expect(overlay()).toBeNull();
  });

  it.each([
    [
      "a click",
      () => [
        new PointerEvent("pointerdown", { bubbles: true, buttons: 1 }),
        new PointerEvent("pointerup", { bubbles: true }),
      ],
    ],
    ["pointer travel", () => [new PointerEvent("pointermove", { bubbles: true, movementX: 3 })]],
    ["a swipe", () => [new WheelEvent("wheel", { bubbles: true, deltaX: 12, metaKey: true })]],
    [
      "another key",
      () => [new KeyboardEvent("keydown", { bubbles: true, key: "k", metaKey: true })],
    ],
    ["a drag", () => [new DragEvent("dragover", { bubbles: true })]],
  ])("stays hidden after %s until Cmd is released and held again", async (_name, interruption) => {
    await setup();
    using _platform = macPlatform();
    await using _screen = await render(<ShortcutQuickReference />);
    using _timers = fakeTimers();
    const interrupt = async () => {
      for (const event of interruption()) await send(event);
    };

    await holdCmd();
    await wait(300);
    await interrupt();
    await wait(2_000);
    expect(overlay()).toBeNull();

    await releaseCmd();
    await holdCmd();
    await wait(700);
    expect(overlay()).not.toBeNull();
    await interrupt();
    expect(overlay()).toBeNull();
  });

  it("stays hidden when Cmd goes down while a pointer button is held", async () => {
    await setup();
    using _platform = macPlatform();
    await using _screen = await render(<ShortcutQuickReference />);
    using _timers = fakeTimers();

    await send(new PointerEvent("pointerdown", { bubbles: true, buttons: 1 }));
    await holdCmd();
    await wait(2_000);
    expect(overlay()).toBeNull();

    await send(new PointerEvent("pointerup", { bubbles: true, buttons: 0 }));
    await releaseCmd();
    await holdCmd();
    await wait(700);
    expect(overlay()).not.toBeNull();
  });

  it("keeps its timer when Shift joins the hold, and leads with the Cmd+Shift chords", async () => {
    await setup();
    using _platform = macPlatform();
    await using _screen = await render(<ShortcutQuickReference />);
    using _timers = fakeTimers();

    await holdCmd();
    await wait(300);
    await key("keydown", "Shift", { meta: true, shift: true });
    await wait(399);
    expect(overlay()).toBeNull();
    await wait(1);

    const navigation = [...(overlay()?.querySelectorAll("section") ?? [])].find(
      (section) => section.querySelector("h2")?.textContent === "Navigation",
    );
    expect(navigation?.querySelector("span")?.textContent).toBe("Project Search: Toggle");
    expect(isDimmed("Project Search: Toggle")).toBe(false);
    expect(isDimmed("Command Palette: Toggle")).toBe(true);
  });

  it("arms when Cmd goes down after Shift", async () => {
    await setup();
    using _platform = macPlatform();
    await using _screen = await render(<ShortcutQuickReference />);
    using _timers = fakeTimers();

    await key("keydown", "Shift", { shift: true });
    await wait(5_000);
    expect(overlay()).toBeNull();

    await key("keydown", "Meta", { meta: true, shift: true });
    await wait(699);
    expect(overlay()).toBeNull();
    await wait(1);
    expect(isDimmed("Project Search: Toggle")).toBe(false);
  });

  it("stays visible while Alt is pressed and released, and the list follows", async () => {
    await setup();
    using _platform = macPlatform();
    await using _screen = await render(<ShortcutQuickReference />);
    using _timers = fakeTimers();

    await holdCmd();
    await wait(700);
    expect(isDimmed("Right Panel: Toggle")).toBe(true);
    expect(isDimmed("Command Palette: Toggle")).toBe(false);

    await key("keydown", "Alt", { meta: true, alt: true });
    expect(isDimmed("Right Panel: Toggle")).toBe(false);
    expect(isDimmed("Command Palette: Toggle")).toBe(true);

    await key("keyup", "Alt", { meta: true });
    expect(isDimmed("Right Panel: Toggle")).toBe(true);
    expect(isDimmed("Command Palette: Toggle")).toBe(false);
  });

  it.each([
    ["the window loses focus", () => send(new Event("blur"), window)],
    ["a paste", () => send(new ClipboardEvent("paste", { bubbles: true }))],
  ])("closes when %s, though the Cmd release never arrives", async (_name, loseModifier) => {
    await setup();
    using _platform = macPlatform();
    await using _screen = await render(<ShortcutQuickReference />);
    using _timers = fakeTimers();

    await holdCmd();
    await wait(700);
    expect(overlay()).not.toBeNull();
    await loseModifier();
    expect(overlay()).toBeNull();
    await wait(2_000);
    expect(overlay()).toBeNull();

    await holdCmd();
    await wait(700);
    expect(overlay()).not.toBeNull();
  });

  it.each([
    [
      "the pointer rests on code",
      async (container: HTMLElement) => {
        const code = append(container, document.createElement("div"), "width:200px;height:200px");
        code.dataset.focusScope = "code diff";
        await userEvent.hover(code);
      },
    ],
    [
      "the pointer rests on code inside a shadow root",
      async (container: HTMLElement) => {
        const host = append(container, document.createElement("div"), "width:200px;height:200px");
        const code = append(
          host.attachShadow({ mode: "open" }),
          document.createElement("div"),
          "height:100%",
        );
        code.dataset.focusScope = "code";
        await userEvent.hover(host);
      },
    ],
    [
      "a keybinding is being recorded",
      async (container: HTMLElement) => {
        const capture = append(container, document.createElement("div"));
        capture.dataset.keybindingCapture = "";
        append(capture, document.createElement("input")).focus();
      },
    ],
    [
      "the command palette is open",
      async (container: HTMLElement) => {
        append(container, document.createElement("div")).dataset.commandPalette = "";
      },
    ],
  ])("never arms while %s", async (_name, arrange) => {
    await setup();
    using _platform = macPlatform();
    await using screen = await render(<ShortcutQuickReference />);
    const stage = append(screen.container, document.createElement("div"));
    await arrange(stage);
    using _timers = fakeTimers();

    await holdCmd();
    await wait(2_000);
    expect(overlay()).toBeNull();

    await releaseCmd();
    stage.remove();
    await commands.resetPointer();
    await holdCmd();
    await wait(700);
    expect(overlay()).not.toBeNull();
  });

  it("never shows with the setting off", async () => {
    await setup({ shortcutQuickReferenceEnabled: false });
    using _platform = macPlatform();
    await using _screen = await render(<ShortcutQuickReference />);
    using _timers = fakeTimers();

    await holdCmd();
    await wait(2_000);
    expect(overlay()).toBeNull();
  });

  it.each([
    { width: 1440, height: 900, allShown: true },
    { width: 700, height: 480, allShown: false },
  ])(
    "fits 90 or more commands beside the sidebar at $width×$height without scrolling",
    async ({ width, height, allShown }) => {
      await setup();
      await page.viewport(width, height);
      using _platform = macPlatform();
      await using screen = await render(<ShortcutQuickReference />);
      const sidebar = append(
        screen.container,
        document.createElement("div"),
        "position:fixed;inset:0 auto 0 0;width:300px",
      );
      sidebar.dataset.appSidebar = "";
      const code = append(screen.container, document.createElement("button"));
      code.dataset.focusScope = "code";
      code.focus();
      using _timers = fakeTimers();

      await holdCmd();
      await wait(700);

      const panel = overlay()!.getBoundingClientRect();
      expect(panel.left).toBeGreaterThanOrEqual(300);
      expect(panel.right).toBeLessThanOrEqual(width);
      expect(panel.top).toBeGreaterThanOrEqual(0);
      expect(panel.bottom).toBeLessThanOrEqual(height);
      const labels = [...overlay()!.querySelectorAll("span")];
      const rows = labels.map((label) => label.parentElement!.getBoundingClientRect());
      for (const entry of rows) {
        expect(entry.left).toBeGreaterThanOrEqual(panel.left);
        expect(entry.right).toBeLessThanOrEqual(panel.right);
        expect(entry.bottom).toBeLessThanOrEqual(panel.bottom);
      }
      // No label is cut short: a column is as wide as its longest row.
      expect(
        labels
          .filter((label) => label.scrollWidth > label.clientWidth)
          .map((label) => label.textContent),
      ).toEqual([]);
      if (allShown) {
        expect(rows.length).toBeGreaterThanOrEqual(90);
        expect(row("Code: Action1")).not.toBeNull();
        expect(overlay()!.textContent).not.toContain("more in Settings");
      } else {
        expect(overlay()!.textContent).toMatch(/\d+ more in Settings → Keybindings/);
      }
    },
  );
});
