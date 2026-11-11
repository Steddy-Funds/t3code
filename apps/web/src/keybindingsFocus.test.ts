import { describe, expect, it, vi } from "vite-plus/test";
import type { KeybindingCommand } from "@t3tools/contracts";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { resolveShortcutCommand } from "./keybindings";
import * as editableFocus from "./lib/editableFocus";
import * as focusScopes from "./lib/focusScopes";

function setupFocus() {
  const editor = new EventTarget();
  const other = new EventTarget();
  vi.stubGlobal("document", { activeElement: editor });
  const focus = vi
    .spyOn(editableFocus, "isEditableFocused")
    .mockImplementation((target) => target === editor);
  // The editor stands for a code pane: the one place a focus scope holds.
  const scopes = vi.spyOn(focusScopes, "readFocusScopes").mockImplementation((target) => ({
    ...focusScopes.NO_FOCUS_SCOPES,
    codeFocus: target === editor,
  }));
  return {
    editor,
    other,
    [Symbol.dispose]() {
      focus.mockRestore();
      scopes.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

function keydown(target?: EventTarget) {
  return {
    key: "k",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...(target ? { target } : {}),
  };
}

function bindings(command: KeybindingCommand, when = "!editableFocus") {
  return compileResolvedKeybindingsConfig([{ key: "mod+k", command, when }]);
}

describe("editable shortcut conditions", () => {
  it.each(["commandPalette.toggle", "sidebar.toggle", "thread.next", "thread.jump.1"] as const)(
    "honors !editableFocus for %s without a caller-provided focus context",
    (command) => {
      using focus = setupFocus();
      const rules = bindings(command);

      expect(
        resolveShortcutCommand(keydown(focus.editor), rules, {
          platform: "Linux",
          context: { terminalFocus: false },
        }),
      ).toBeNull();
      expect(resolveShortcutCommand(keydown(focus.other), rules, { platform: "Linux" })).toBe(
        command,
      );
    },
  );

  it("uses the active element when a forwarded shortcut has no target", () => {
    using _focus = setupFocus();
    expect(
      resolveShortcutCommand(keydown(), bindings("commandPalette.toggle"), { platform: "Linux" }),
    ).toBeNull();
  });

  it("honors a positive editableFocus condition", () => {
    using focus = setupFocus();
    const rules = bindings("commandPalette.toggle", "editableFocus");
    expect(resolveShortcutCommand(keydown(focus.editor), rules, { platform: "Linux" })).toBe(
      "commandPalette.toggle",
    );
    expect(resolveShortcutCommand(keydown(focus.other), rules, { platform: "Linux" })).toBeNull();
  });

  it("preserves explicit focus overrides", () => {
    using focus = setupFocus();
    const rules = bindings("commandPalette.toggle");

    expect(
      resolveShortcutCommand(keydown(focus.editor), rules, {
        platform: "Linux",
        context: { editableFocus: false },
      }),
    ).toBe("commandPalette.toggle");
    expect(
      resolveShortcutCommand(keydown(focus.other), rules, {
        platform: "Linux",
        context: { editableFocus: true },
      }),
    ).toBeNull();
  });

  it("keeps shortcuts without an editable-focus condition active while editing", () => {
    using focus = setupFocus();
    expect(
      resolveShortcutCommand(keydown(focus.editor), bindings("commandPalette.toggle", "true"), {
        platform: "Linux",
      }),
    ).toBe("commandPalette.toggle");
  });
});

describe("focus scope conditions", () => {
  it("reads the scope from the key's target, whatever context the listener built", () => {
    using focus = setupFocus();
    const rules = bindings("commandPalette.toggle", "codeFocus");
    for (const options of [
      { platform: "Linux" },
      { platform: "Linux", context: { terminalFocus: false, editableFocus: true } },
    ]) {
      expect(resolveShortcutCommand(keydown(focus.editor), rules, options)).toBe(
        "commandPalette.toggle",
      );
      expect(resolveShortcutCommand(keydown(focus.other), rules, options)).toBeNull();
    }
    expect(resolveShortcutCommand(keydown(), rules, { platform: "Linux" })).toBe(
      "commandPalette.toggle",
    );
  });

  it("preserves a scope the listener sets itself", () => {
    using focus = setupFocus();
    const rules = bindings("commandPalette.toggle", "codeFocus");
    expect(
      resolveShortcutCommand(keydown(focus.editor), rules, {
        platform: "Linux",
        context: { codeFocus: false },
      }),
    ).toBeNull();
    expect(
      resolveShortcutCommand(keydown(focus.other), rules, {
        platform: "Linux",
        context: { codeFocus: true },
      }),
    ).toBe("commandPalette.toggle");
  });
});
