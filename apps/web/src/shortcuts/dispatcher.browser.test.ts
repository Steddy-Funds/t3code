import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS, isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { provideShortcutCapability } from "../keybindings";
import { focusScopeProps } from "../lib/focusScopes";
import { dispatchMenuAction, registerCommands, registerMenuAction } from "./dispatcher";

function bindings(entries: ReadonlyArray<[string, KeybindingCommand]>): ResolvedKeybindingsConfig {
  return entries.map(([key, command]) => ({
    command,
    shortcut: {
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      modKey: false,
    },
  }));
}

const keybindings = () =>
  bindings([
    ["k", "chat.new"],
    ["j", "chat.newLocal"],
  ]);

function press(key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

describe("command dispatcher", () => {
  it("runs the newest scope's handler and nothing below it", () => {
    const global = vi.fn();
    const outer = vi.fn();
    const inner = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": global }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": outer }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": inner }, { keybindings }));

    press("k");

    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    expect(global).not.toHaveBeenCalled();
  });

  it("falls through scopes that return false, skip the command, or fail their guard", () => {
    const global = vi.fn();
    const declined = vi.fn(() => false);
    const guarded = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": global }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": declined }, { keybindings }));
    stack.defer(registerCommands({ "chat.newLocal": vi.fn() }, { keybindings }));
    stack.defer(registerCommands({ "chat.new": guarded }, { keybindings, when: () => false }));

    press("k");

    expect(guarded).not.toHaveBeenCalled();
    expect(declined).toHaveBeenCalledOnce();
    expect(global).toHaveBeenCalledOnce();
  });

  it("stops once a handler prevents default, and unregisters on cleanup", () => {
    const lower = vi.fn();
    const upper = vi.fn((event: KeyboardEvent) => {
      event.preventDefault();
      return false;
    });
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": lower }, { keybindings }));
    const unregisterUpper = registerCommands({ "chat.new": upper }, { keybindings });

    press("k");
    expect(lower).not.toHaveBeenCalled();

    unregisterUpper();
    press("k");
    expect(upper).toHaveBeenCalledOnce();
    expect(lower).toHaveBeenCalledOnce();
  });

  it("lets a scope claim raw keys before command lookup", () => {
    const onEscape = vi.fn((event: KeyboardEvent) => (event.key === "Escape" ? undefined : false));
    const command = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerCommands({ "chat.new": command }, { keybindings, onKeyDown: onEscape }));

    press("Escape");
    press("k");

    expect(onEscape).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenCalledOnce();
  });

  it("tells observers whether a scope consumed the key, after the scopes ran", () => {
    const calls: Array<string> = [];
    using stack = new DisposableStack();
    stack.defer(
      registerCommands({}, { observe: (_event, consumed) => calls.push(`observe:${consumed}`) }),
    );
    stack.defer(
      registerCommands({ "chat.new": () => void calls.push("command") }, { keybindings }),
    );

    press("k");
    press("x");

    expect(calls).toEqual(["command", "observe:true", "observe:false"]);
  });

  it("consumes a command chord pressed inside a confirmation without running its handler", () => {
    const command = vi.fn();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    const cancel = document.createElement("button");
    dialog.append(cancel);
    document.body.append(dialog);
    using stack = new DisposableStack();
    stack.defer(() => dialog.remove());
    stack.defer(registerCommands({ "chat.new": command }, { keybindings }));
    cancel.focus();

    const event = new KeyboardEvent("keydown", { key: "k", cancelable: true, bubbles: true });
    cancel.dispatchEvent(event);

    expect(command).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("runs a scoped default only where its scope has focus and its feature works", () => {
    const pane = document.createElement("div");
    pane.setAttribute("data-focus-scope", focusScopeProps("code")["data-focus-scope"]);
    // Focus sits in a shadow root, as in a code viewer: the key reaches the window targeting the host.
    const code = document.createElement("div");
    code.tabIndex = -1;
    pane.attachShadow({ mode: "open" }).append(code);
    const composer = document.createElement("textarea");
    document.body.append(pane, composer);
    const toggleSidebar = vi.fn();
    const goToDeclaration = vi.fn();
    const defaults = { keybindings: () => DEFAULT_RESOLVED_KEYBINDINGS };
    const navigation = { works: true };
    using stack = new DisposableStack();
    stack.defer(() => pane.remove());
    stack.defer(() => composer.remove());
    stack.defer(registerCommands({ "sidebar.toggle": toggleSidebar }, defaults));
    const pressModB = (target: HTMLElement) => {
      target.focus();
      const mac = isMacPlatform(navigator.platform);
      const event = new KeyboardEvent("keydown", {
        key: "b",
        metaKey: mac,
        ctrlKey: !mac,
        cancelable: true,
        bubbles: true,
        composed: true,
      });
      target.dispatchEvent(event);
      return event;
    };

    // Nobody provides code navigation yet: in code the key keeps its earlier command.
    pressModB(code);
    expect(toggleSidebar).toHaveBeenCalledTimes(1);

    // Provided but without a handler: the command resolves, runs nothing, and the key is let through.
    stack.defer(provideShortcutCapability("codeNavigation", () => navigation.works));
    expect(pressModB(code).defaultPrevented).toBe(false);
    expect(toggleSidebar).toHaveBeenCalledTimes(1);

    stack.defer(
      registerCommands(
        { "code.goToDeclaration": (event) => (goToDeclaration(), event.preventDefault()) },
        defaults,
      ),
    );
    expect(pressModB(code).defaultPrevented).toBe(true);
    expect(goToDeclaration).toHaveBeenCalledTimes(1);
    expect(toggleSidebar).toHaveBeenCalledTimes(1);

    // The feature does not work for this surface (its machine has no language service).
    navigation.works = false;
    pressModB(code);
    expect(toggleSidebar).toHaveBeenCalledTimes(2);

    navigation.works = true;
    pressModB(composer);
    expect(toggleSidebar).toHaveBeenCalledTimes(3);
    expect(goToDeclaration).toHaveBeenCalledTimes(1);
  });

  it("routes a menu action to its newest handler", () => {
    const older = vi.fn();
    const newer = vi.fn();
    using stack = new DisposableStack();
    stack.defer(registerMenuAction("test-action", older));
    const unregisterNewer = registerMenuAction("test-action", newer);

    dispatchMenuAction("test-action");
    unregisterNewer();
    dispatchMenuAction("test-action");

    expect(newer).toHaveBeenCalledOnce();
    expect(older).toHaveBeenCalledOnce();
  });
});
