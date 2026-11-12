import { assert, describe, it } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
  insertMissingDefaultKeybindings,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";

import {
  type KeybindingCommand,
  type KeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  effectiveShortcutsForCommand,
  formatShortcutLabel,
  isRichTextBoldShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  provideShortcutCapability,
  resolveChatShortcutCommand,
  resolveShortcutCommand,
  ruleCanMatch,
  shortcutConflictKey,
  shouldShowThreadJumpHintsForModifiers,
  shortcutLabelForCommand,
  terminalNavigationShortcutData,
  type ShortcutCapability,
  type ShortcutEventLike,
} from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("terminal word navigation", () => {
  it.each(["Win32", "Linux x86_64"])(
    "leaves Ctrl+Arrow to the terminal encoder on %s",
    (platform) => {
      for (const key of ["ArrowLeft", "ArrowRight"]) {
        assert.equal(terminalNavigationShortcutData(event({ key, ctrlKey: true }), platform), null);
      }
    },
  );

  it.each(["Win32", "Linux x86_64", "MacIntel"])(
    "preserves Alt+Arrow word navigation on %s",
    (platform) => {
      assert.equal(
        terminalNavigationShortcutData(event({ key: "ArrowLeft", altKey: true }), platform),
        "\u001bb",
      );
      assert.equal(
        terminalNavigationShortcutData(event({ key: "ArrowRight", altKey: true }), platform),
        "\u001bf",
      );
    },
  );
});

function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}

function whenAnd(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "and", left, right };
}

interface TestBinding {
  shortcut: KeybindingShortcut;
  command: KeybindingCommand;
  whenAst?: KeybindingWhenNode;
}

function compile(bindings: TestBinding[]): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
    ...(binding.whenAst ? { whenAst: binding.whenAst } : {}),
  }));
}

const DEFAULT_BINDINGS = compile([
  { shortcut: modShortcut("b"), command: "sidebar.toggle" },
  { shortcut: modShortcut("j"), command: "terminal.toggle" },
  { shortcut: modShortcut("b", { altKey: true }), command: "rightPanel.toggle" },
  {
    shortcut: modShortcut("d"),
    command: "terminal.split",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("d", { shiftKey: true }),
    command: "terminal.splitVertical",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("n"),
    command: "terminal.new",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "terminal.close",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "rightPanel.close",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("d"),
    command: "diff.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("k"),
    command: "commandPalette.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("p"),
    command: "filePicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("f", { shiftKey: true }),
    command: "projectSearch.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("t", { altKey: true, shiftKey: true }),
    command: "themeEditor.toggle",
  },
  {
    shortcut: modShortcut("f"),
    command: "chat.find",
    whenAst: whenAnd(
      whenNot(whenIdentifier("terminalFocus")),
      whenNot(whenIdentifier("previewFocus")),
    ),
  },
  {
    shortcut: modShortcut("m", { shiftKey: true }),
    command: "modelPicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("o", { shiftKey: true }), command: "chat.new" },
  { shortcut: modShortcut("n", { shiftKey: true }), command: "chat.newLocal" },
  { shortcut: modShortcut("o"), command: "editor.openFavorite" },
  { shortcut: modShortcut("[", { shiftKey: true }), command: "thread.previous" },
  { shortcut: modShortcut("]", { shiftKey: true }), command: "thread.next" },
  {
    shortcut: modShortcut("c", { shiftKey: true }),
    command: "thread.copyReference",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("s", { shiftKey: true }),
    command: "thread.settle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("1"), command: "thread.jump.1" },
  { shortcut: modShortcut("2"), command: "thread.jump.2" },
  { shortcut: modShortcut("3"), command: "thread.jump.3" },
  {
    shortcut: modShortcut("1"),
    command: "modelPicker.jump.1",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
  {
    shortcut: modShortcut("2"),
    command: "modelPicker.jump.2",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
  {
    shortcut: modShortcut("3"),
    command: "modelPicker.jump.3",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
]);

describe("effectiveShortcutsForCommand", () => {
  it("passes only effective preview shortcuts to the desktop bridge", () => {
    const reopen = modShortcut("t", { shiftKey: true });
    const second = modShortcut("y", { shiftKey: true });
    const keybindings = compile([
      { shortcut: reopen, command: "view.reopenClosed" },
      {
        shortcut: second,
        command: "view.reopenClosed",
        whenAst: whenIdentifier("previewFocus"),
      },
      {
        shortcut: reopen,
        command: "preview.toggle",
        whenAst: whenIdentifier("previewFocus"),
      },
    ]);
    assert.deepEqual(
      effectiveShortcutsForCommand(keybindings, "view.reopenClosed", {
        platform: "MacIntel",
        context: { previewFocus: true, previewOpen: true },
      }),
      [second],
    );
    assert.deepEqual(
      effectiveShortcutsForCommand(keybindings, "view.reopenClosed", {
        platform: "MacIntel",
        context: { previewFocus: false },
      }),
      [reopen],
    );
  });
});

describe("settle thread shortcut", () => {
  it("does not intercept the terminal", () => {
    assert.isNull(
      resolveShortcutCommand(event({ key: "s", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Win32",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("thread undo shortcut", () => {
  it("leaves native undo alone inside text fields and terminals", () => {
    assert.isNull(
      resolveShortcutCommand(event({ key: "z", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Win32",
        context: { editableFocus: true },
      }),
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "z", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Win32",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("split/new/close terminal shortcuts", () => {
  it("supports when expressions", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.split",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      {
        shortcut: modShortcut("n", { shiftKey: true }),
        command: "terminal.new",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      { shortcut: modShortcut("j"), command: "terminal.toggle" },
    ]);
    assert.isTrue(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: false, terminalFocus: false },
      }),
    );
    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true, shiftKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
  });
});

describe("shortcutLabelForCommand", () => {
  it("returns null for commands shadowed by a later conflicting shortcut", () => {
    const bindings = compile([
      { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.1" },
      { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.7" },
    ]);

    assert.isNull(shortcutLabelForCommand(bindings, "thread.jump.1", "MacIntel"));
    assert.strictEqual(shortcutLabelForCommand(bindings, "thread.jump.7", "MacIntel"), "⇧⌘1");
  });

  it("respects when-context while resolving labels", () => {
    const bindings = compile([
      { shortcut: modShortcut("d"), command: "diff.toggle" },
      {
        shortcut: modShortcut("d"),
        command: "terminal.split",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.strictEqual(
      shortcutLabelForCommand(bindings, "diff.toggle", {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "Ctrl+D",
    );
    assert.isNull(
      shortcutLabelForCommand(bindings, "diff.toggle", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "terminal.split", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "Ctrl+D",
    );
  });
});

describe("thread navigation helpers", () => {
  it("never shows jump hints while the terminal is focused, even with an unrestricted binding", () => {
    assert.isFalse(
      shouldShowThreadJumpHintsForModifiers(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      shouldShowThreadJumpHintsForModifiers(event({ metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
  });

  it("keeps default thread jumps off the web so the browser can switch tabs", () => {
    const input = event({ key: "1", metaKey: true });
    assert.isNull(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: false },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true },
      }),
      "thread.jump.1",
    );
    assert.isFalse(
      shouldShowThreadJumpHintsForModifiers(
        event({ metaKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { isDesktop: false },
        },
      ),
    );
    assert.isTrue(
      shouldShowThreadJumpHintsForModifiers(
        event({ metaKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { isDesktop: true },
        },
      ),
    );
  });
});

describe("model picker navigation helpers", () => {
  it("keeps default model jumps off the web even while the picker is open", () => {
    const input = event({ key: "3", metaKey: true });
    assert.isNull(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: false, modelPickerOpen: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true, modelPickerOpen: true },
      }),
      "modelPicker.jump.3",
    );
    assert.strictEqual(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true, modelPickerOpen: false },
      }),
      "thread.jump.3",
    );
  });
});

describe("chat/editor shortcuts", () => {
  it("toggles the thread panel by default without taking terminal keystrokes", () => {
    for (const platform of ["MacIntel", "Win32", "Linux"]) {
      const input = event({
        key: "b",
        metaKey: platform === "MacIntel",
        ctrlKey: platform !== "MacIntel",
        shiftKey: true,
      });
      assert.strictEqual(
        resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { terminalFocus: false, editableFocus: true },
        }),
        "threadPanel.toggle",
      );
      assert.isNull(
        resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { terminalFocus: true },
        }),
      );
    }
  });

  it("preserves a user-configured thread panel shortcut instead of its default", () => {
    const bindings = mergeWithDefaultKeybindings(
      compile([
        {
          shortcut: modShortcut("b", { altKey: true, shiftKey: true }),
          command: "threadPanel.toggle",
        },
      ]),
    );

    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "b", metaKey: true, altKey: true, shiftKey: true }),
        bindings,
        { platform: "MacIntel" },
      ),
      "threadPanel.toggle",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "b", metaKey: true, shiftKey: true }), bindings, {
        platform: "MacIntel",
      }),
    );
  });
});

describe("cross-command precedence", () => {
  it("uses when + order so a later focused rule overrides a global rule", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "chat.new" },
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "terminal.new",
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.new",
    );
  });

  it("still lets a later global rule win when both rules match", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
      { shortcut: modShortcut("n"), command: "chat.new" },
    ]);

    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "chat.new",
    );
  });
});

describe("resolveChatShortcutCommand", () => {
  it("runs the active environment's script shortcut instead of the primary environment's", () => {
    const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);
    const active = compile([{ shortcut: modShortcut("t"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "t", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "script.setup.run",
    );
    assert.isNull(
      resolveChatShortcutCommand(event({ key: "r", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
    );
  });

  it("does not run primary scripts before the active environment's bindings arrive", () => {
    const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);

    assert.isNull(
      resolveChatShortcutCommand(event({ key: "r", ctrlKey: true }), primary, [], {
        platform: "Linux",
      }),
    );
  });

  it("keeps primary app commands ahead of conflicting active script shortcuts", () => {
    const primary = compile([{ shortcut: modShortcut("k"), command: "commandPalette.toggle" }]);
    const active = compile([{ shortcut: modShortcut("k"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "k", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "commandPalette.toggle",
    );
  });

  it("keeps app shortcuts on the primary environment when the active environment remaps them", () => {
    const primary = compile([{ shortcut: modShortcut("j"), command: "terminal.toggle" }]);
    const active = compile([{ shortcut: modShortcut("t"), command: "terminal.toggle" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "j", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "terminal.toggle",
    );
    assert.isNull(
      resolveChatShortcutCommand(event({ key: "t", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
    );
  });

  it.each([false, true])(
    "preserves active binding precedence with terminalFocus=%s",
    (terminalFocus) => {
      const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);
      const active = compile([
        { shortcut: modShortcut("r"), command: "script.deploy.run" },
        {
          shortcut: modShortcut("r"),
          command: "terminal.new",
          whenAst: whenIdentifier("terminalFocus"),
        },
      ]);
      const options = { platform: "Linux", context: { terminalFocus } };
      const shortcut = event({ key: "r", ctrlKey: true });

      assert.strictEqual(
        resolveChatShortcutCommand(shortcut, primary, active, options),
        terminalFocus ? null : "script.deploy.run",
      );
      assert.strictEqual(
        resolveChatShortcutCommand(shortcut, active, active, options),
        resolveShortcutCommand(shortcut, active, options),
      );
    },
  );
});

describe("resolveShortcutCommand", () => {
  it("routes mod+w to the terminal while focused and to the right panel otherwise", () => {
    const closeEvent = event({ key: "w", metaKey: true });
    assert.strictEqual(
      resolveShortcutCommand(closeEvent, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "terminal.close",
    );
    assert.strictEqual(
      resolveShortcutCommand(closeEvent, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "rightPanel.close",
    );
  });

  it("navigates history with mod+[ and mod+] outside the terminal", () => {
    const back = event({ key: "[", code: "BracketLeft", metaKey: true });
    const forward = event({ key: "]", code: "BracketRight", ctrlKey: true });
    assert.strictEqual(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" }),
      "navigation.back",
    );
    assert.strictEqual(
      resolveShortcutCommand(forward, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux" }),
      "navigation.forward",
    );
    assert.isNull(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });

  it("matches punctuation shortcuts by physical key across keyboard layouts", () => {
    const keybindings = compile([
      { shortcut: modShortcut("'", { shiftKey: true }), command: "diff.toggle" },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "@", code: "Quote", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
      "diff.toggle",
    );
    assert.isNull(
      resolveShortcutCommand(
        event({ key: '"', code: "Digit2", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
    );
  });

  it("does not let a punctuation position shadow a Latin layout key", () => {
    const keybindings = compile([
      { shortcut: modShortcut("m"), command: "diff.toggle" },
      { shortcut: modShortcut(";"), command: "sidebar.toggle" },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "m", code: "Semicolon", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });

  it("matches Option-modified letters using the physical key code on macOS", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "∫", code: "KeyB", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        { platform: "MacIntel" },
      ),
      "rightPanel.toggle",
    );
  });

  it("matches non-Latin layout letters using the physical key code", () => {
    const keybindings = compile([{ shortcut: modShortcut("d"), command: "diff.toggle" }]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "в", code: "KeyD", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });

  it("ignores the physical key code when the layout types a different Latin letter", () => {
    const keybindings = compile([{ shortcut: modShortcut("d"), command: "diff.toggle" }]);

    assert.isNull(
      resolveShortcutCommand(event({ key: "a", code: "KeyD", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "d", code: "KeyL", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });
});

describe("isRichTextBoldShortcut", () => {
  const selected = { isCollapsed: false };

  it("matches the B key on non-Latin layouts, like the sidebar toggle does", () => {
    const cyrillicB = event({ key: "и", code: "KeyB", ctrlKey: true });
    assert.isTrue(isRichTextBoldShortcut(cyrillicB, selected));
    assert.strictEqual(
      resolveShortcutCommand(cyrillicB, DEFAULT_BINDINGS, { platform: "Win32" }),
      "sidebar.toggle",
    );
  });

  it("follows the letter a Latin layout types, not the physical key", () => {
    assert.isFalse(
      isRichTextBoldShortcut(event({ key: "x", code: "KeyB", ctrlKey: true }), selected),
    );
    assert.isTrue(
      isRichTextBoldShortcut(event({ key: "b", code: "KeyN", ctrlKey: true }), selected),
    );
  });

  it("leaves the chord to the sidebar toggle when no text is selected", () => {
    const modB = event({ key: "b", metaKey: true });
    assert.isFalse(isRichTextBoldShortcut(modB, { isCollapsed: true }));
    assert.isFalse(isRichTextBoldShortcut(modB, null));
  });
});

describe("composer and pull request shortcuts", () => {
  it("uses the dictation chord outside the terminal and preserves terminal split", () => {
    const chord = event({ key: "d", ctrlKey: true, shiftKey: true });
    assert.strictEqual(
      resolveShortcutCommand(chord, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "composer.dictation",
    );
    assert.strictEqual(
      resolveShortcutCommand(chord, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "terminal.splitVertical",
    );
  });
  it("fills missing number shortcuts without replacing the saved URL binding", () => {
    const olderServerBindings = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (binding) =>
        binding.command !== "pullRequest.copyNumber" && binding.command !== "thread.copyReference",
    );
    const bindings = mergeWithDefaultKeybindings([
      ...olderServerBindings,
      ...compileResolvedKeybindingsConfig([
        { key: "mod+shift+8", command: "thread.copyReference", when: "!terminalFocus" },
      ]),
    ]);
    for (const [key, command] of [
      ["k", "pullRequest.copyNumber"],
      ["8", "thread.copyReference"],
      ["c", null],
      ["y", null],
    ] as const) {
      assert.strictEqual(
        resolveShortcutCommand(event({ key, metaKey: true, shiftKey: true }), bindings, {
          platform: "MacIntel",
        }),
        command,
      );
    }
  });

  it.each(["MacIntel", "Win32", "Linux"])(
    "reserves the alternate send chord for the focused composer on %s",
    (platform) => {
      const modifier = {
        metaKey: platform === "MacIntel",
        ctrlKey: platform !== "MacIntel",
      };
      const shiftedEnter = event({ key: "Enter", shiftKey: true, ...modifier });
      for (const composerRequiresModifier of [false, true]) {
        const context = {
          composerFocus: true,
          turnRunning: true,
          composerRequiresModifier,
        };
        assert.strictEqual(
          resolveShortcutCommand(shiftedEnter, DEFAULT_RESOLVED_KEYBINDINGS, {
            platform,
            context,
          }),
          composerRequiresModifier ? "composer.sendAlternate" : "thread.steerQueuedMessage",
        );
        assert.strictEqual(
          shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "composer.sendAlternate", {
            platform,
            context,
          }),
          formatShortcutLabel(
            modShortcut("enter", { shiftKey: composerRequiresModifier }),
            platform,
          ),
        );
        assert.strictEqual(
          resolveShortcutCommand(shiftedEnter, DEFAULT_RESOLVED_KEYBINDINGS, {
            platform,
            context: { ...context, composerFocus: false },
          }),
          "thread.steerQueuedMessage",
        );
      }
    },
  );

  const altEffortBindings = compileResolvedKeybindingsConfig([
    { key: "mod+alt+e", command: "composer.effort", when: "!terminalFocus" },
  ]);

  it("leaves AltGr text entry alone with a custom Alt binding", () => {
    for (const platform of ["Win32", "Linux"]) {
      const input = event({
        key: "€",
        code: "KeyE",
        ctrlKey: true,
        altKey: true,
        getModifierState: (key) => key === "AltGraph",
      });
      assert.isNull(resolveShortcutCommand(input, altEffortBindings, { platform }));
      assert.strictEqual(
        resolveShortcutCommand({ ...input, getModifierState: () => false }, altEffortBindings, {
          platform,
        }),
        "composer.effort",
      );
    }
  });

  it("keeps Firefox modifier reporting usable on Windows and macOS", () => {
    const getModifierState = (key: string) => key === "AltGraph";
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "e", ctrlKey: true, altKey: true, getModifierState }),
        altEffortBindings,
        { platform: "Win32" },
      ),
      "composer.effort",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "´", code: "KeyE", metaKey: true, altKey: true, getModifierState }),
        altEffortBindings,
        { platform: "MacIntel" },
      ),
      "composer.effort",
    );
  });
});

describe("Usage shortcuts", () => {
  it.each(["Linux", "MacIntel"])(
    "preserves desktop numbered thread shortcuts on Usage on %s",
    (platform) => {
      const shortcut = event({
        key: "2",
        ctrlKey: platform === "Linux",
        metaKey: platform === "MacIntel",
      });
      assert.strictEqual(
        resolveShortcutCommand(shortcut, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { usagePageOpen: true, isDesktop: true },
        }),
        "thread.jump.2",
      );
      assert.isNotNull(
        shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "thread.jump.2", {
          platform,
          context: { usagePageOpen: true, isDesktop: true },
        }),
      );
    },
  );

  it("matches shifted number keys for periods and only on Usage", () => {
    const shortcut = event({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true });
    assert.strictEqual(
      resolveShortcutCommand(shortcut, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { usagePageOpen: true },
      }),
      "usage.period.day",
    );
    assert.isNull(
      resolveShortcutCommand(shortcut, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
      }),
    );
  });
});

const PLATFORMS = ["MacIntel", "Linux"] as const;

function pressOf(shortcut: KeybindingShortcut, platform: string): ShortcutEventLike {
  const mac = platform === "MacIntel";
  return event({
    key: shortcut.key,
    metaKey: shortcut.metaKey || (shortcut.modKey && mac),
    ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
    shiftKey: shortcut.shiftKey,
    altKey: shortcut.altKey,
  });
}

function press(key: string, platform: string): ShortcutEventLike {
  const [rule] = compileResolvedKeybindingsConfig([{ key, command: "chat.new" }]);
  return pressOf(rule!.shortcut, platform);
}

function provide(
  names: ReadonlyArray<ShortcutCapability>,
  isAvailable: () => boolean = () => true,
): Disposable {
  const stack = new DisposableStack();
  for (const name of names) stack.defer(provideShortcutCapability(name, isAvailable));
  return stack;
}

function whenVariables(node: KeybindingWhenNode | undefined, names = new Set<string>()) {
  if (!node) return names;
  if (node.type === "identifier") names.add(node.name);
  else if (node.type === "not") whenVariables(node.node, names);
  else {
    whenVariables(node.left, names);
    whenVariables(node.right, names);
  }
  return names;
}

// What the JetBrains keymap added: its own commands, and three more shortcuts for older ones.
const isJetBrainsRule = ({ command, shortcut }: ResolvedKeybindingsConfig[number]) =>
  /^(code|projectPane)\.|^diff\.(nextChange|previousChange|jumpToSource)$/.test(command) ||
  (command.startsWith("navigation.") && shortcut.altKey) ||
  (command === "filePicker.toggle" && shortcut.key === "o");
const EARLIER_DEFAULTS = DEFAULT_RESOLVED_KEYBINDINGS.filter((rule) => !isJetBrainsRule(rule));

describe("JetBrains keymap defaults", () => {
  it("leaves every earlier default as it was wherever no focus scope holds", () => {
    using _capabilities = provide(["codeNavigation", "codeSymbols", "projectPane"]);
    const added = new Set([
      "codeFocus",
      "diffFocus",
      "projectTreeFocus",
      "codeNavigation",
      "codeSymbols",
      "projectPane",
    ]);
    assert.isAbove(EARLIER_DEFAULTS.length, 80);

    for (const platform of PLATFORMS) {
      for (const { shortcut } of EARLIER_DEFAULTS) {
        const keydown = pressOf(shortcut, platform);
        // Only rules on this key can match, so every combination of the variables they read
        // is every context a listener can build for it.
        const read = DEFAULT_RESOLVED_KEYBINDINGS.filter(
          (rule) => rule.shortcut.key === shortcut.key,
        ).reduce(
          (names, rule) => whenVariables(rule.whenAst, names),
          new Set(["composerRequiresModifier"]),
        );
        const variables = [...read].filter((name) => !added.has(name));
        for (let bits = 0; bits < 2 ** variables.length; bits += 1) {
          const context = Object.fromEntries(
            variables.map((name, index) => [name, (bits & (1 << index)) !== 0]),
          );
          const now = resolveShortcutCommand(keydown, DEFAULT_RESOLVED_KEYBINDINGS, {
            platform,
            context,
          });
          const before = resolveShortcutCommand(keydown, EARLIER_DEFAULTS, { platform, context });
          if (now !== before) {
            assert.fail(
              `${shortcutConflictKey(shortcut, platform)} on ${platform} resolved to ${now}, was ${before}, in ${JSON.stringify(context)}`,
            );
          }
        }
      }
    }
  });

  const desktop = { isDesktop: true, isWeb: false };
  const web = { isDesktop: false, isWeb: true };
  const navigation = ["codeNavigation"] as const;
  it.each<{
    key: string;
    context: Record<string, boolean>;
    capabilities?: ReadonlyArray<ShortcutCapability>;
    /** Provided, but its feature does not work where focus is. */
    unavailable?: ReadonlyArray<ShortcutCapability>;
    command: KeybindingCommand | null;
  }>([
    // A command without a handler runs nothing, so a key keeps its earlier command until the
    // feature is provided, and wherever the feature says it does not work.
    { key: "mod+b", context: { codeFocus: true }, command: "sidebar.toggle" },
    {
      key: "mod+b",
      context: { codeFocus: true },
      unavailable: navigation,
      command: "sidebar.toggle",
    },
    {
      key: "mod+b",
      context: { codeFocus: true },
      capabilities: navigation,
      command: "code.goToDeclaration",
    },
    {
      key: "mod+b",
      context: { composerFocus: true },
      capabilities: navigation,
      command: "sidebar.toggle",
    },
    {
      key: "mod+b",
      context: { diffFocus: true },
      capabilities: navigation,
      command: "sidebar.toggle",
    },
    {
      key: "mod+shift+b",
      context: { codeFocus: true },
      capabilities: navigation,
      command: "code.goToTypeDeclaration",
    },
    { key: "mod+shift+b", context: { codeFocus: true }, command: "threadPanel.toggle" },
    {
      key: "mod+alt+b",
      context: { codeFocus: true },
      capabilities: navigation,
      command: "code.goToImplementation",
    },
    {
      key: "mod+alt+b",
      context: { codeFocus: true },
      unavailable: navigation,
      command: "rightPanel.toggle",
    },
    {
      key: "mod+l",
      context: { codeFocus: true },
      capabilities: navigation,
      command: "code.goToLine",
    },
    {
      key: "mod+l",
      context: { codeFocus: true, previewFocus: true },
      unavailable: navigation,
      command: "preview.focusUrl",
    },
    {
      key: "alt+space",
      context: { codeFocus: true },
      capabilities: navigation,
      command: "code.quickDefinition",
    },
    { key: "alt+space", context: { codeFocus: true }, command: null },
    { key: "f7", context: { codeFocus: true, diffFocus: true }, command: "diff.nextChange" },
    { key: "f7", context: { codeFocus: true }, capabilities: navigation, command: null },
    { key: "mod+arrowdown", context: { diffFocus: true }, command: "diff.jumpToSource" },
    { key: "mod+shift+o", context: { codeFocus: true }, command: "filePicker.toggle" },
    { key: "mod+shift+o", context: { projectTreeFocus: true }, command: "filePicker.toggle" },
    { key: "mod+o", context: { codeFocus: true }, command: "editor.openFavorite" },
    {
      key: "mod+o",
      context: { codeFocus: true },
      unavailable: ["codeSymbols"],
      command: "editor.openFavorite",
    },
    {
      key: "mod+o",
      context: { codeFocus: true },
      capabilities: ["codeSymbols"],
      command: "code.goToClass",
    },
    {
      key: "mod+o",
      context: { projectTreeFocus: true },
      capabilities: ["codeSymbols"],
      command: "code.goToClass",
    },
    { key: "mod+o", context: {}, capabilities: ["codeSymbols"], command: "editor.openFavorite" },
    { key: "mod+e", context: {}, command: null },
    { key: "mod+e", context: {}, capabilities: ["codeSymbols"], command: "code.recentFiles" },
    {
      key: "mod+e",
      context: { terminalFocus: true },
      capabilities: ["codeSymbols"],
      command: null,
    },
    {
      key: "ctrl+shift+arrowdown",
      context: { codeFocus: true },
      capabilities: ["codeSymbols"],
      command: "code.nextMethod",
    },
    { key: "mod+1", context: { ...desktop, codeFocus: true }, command: "thread.jump.1" },
    {
      key: "mod+1",
      context: { ...desktop, codeFocus: true },
      unavailable: ["projectPane"],
      command: "thread.jump.1",
    },
    {
      key: "mod+1",
      context: { ...desktop, codeFocus: true },
      capabilities: ["projectPane"],
      command: "projectPane.toggle",
    },
    {
      key: "mod+1",
      context: { ...desktop, projectTreeFocus: true },
      capabilities: ["projectPane"],
      command: "projectPane.toggle",
    },
    {
      key: "mod+1",
      context: { ...desktop, terminalFocus: true },
      capabilities: ["projectPane"],
      command: "thread.jump.1",
    },
    // Browsers keep these keys for their tabs.
    {
      key: "mod+1",
      context: { ...web, codeFocus: true },
      capabilities: ["projectPane"],
      command: null,
    },
    { key: "mod+alt+arrowleft", context: desktop, command: "navigation.back" },
    { key: "mod+alt+arrowright", context: desktop, command: "navigation.forward" },
    { key: "mod+alt+arrowleft", context: web, command: null },
    { key: "mod+alt+arrowleft", context: { ...desktop, terminalFocus: true }, command: null },
  ])("resolves $key to $command in $context with $capabilities, without $unavailable", (row) => {
    using _capabilities = provide(row.capabilities ?? []);
    using _unavailable = provide(row.unavailable ?? [], () => false);
    for (const platform of PLATFORMS) {
      assert.strictEqual(
        resolveShortcutCommand(press(row.key, platform), DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: row.context,
        }),
        row.command,
        platform,
      );
    }
  });

  it("keeps the older shortcut as the one a command is labelled with", () => {
    for (const platform of PLATFORMS) {
      for (const [command, key] of [
        ["navigation.back", "["],
        ["navigation.forward", "]"],
      ] as const) {
        assert.strictEqual(
          shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, command, {
            platform,
            context: { isDesktop: true },
          }),
          formatShortcutLabel(modShortcut(key), platform),
        );
      }
    }
  });

  it("holds a capability while any provider says it works, read at each key", () => {
    const resolve = () =>
      resolveShortcutCommand(press("mod+e", "MacIntel"), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
      });
    const works = { here: false };
    const sameCheck = () => works.here;
    const withdrawFirst = provideShortcutCapability("codeSymbols", sameCheck);
    const withdrawSecond = provideShortcutCapability("codeSymbols", sameCheck);
    assert.isNull(resolve());
    works.here = true;
    assert.strictEqual(resolve(), "code.recentFiles");

    withdrawFirst();
    withdrawFirst();
    assert.strictEqual(resolve(), "code.recentFiles");
    withdrawSecond();
    assert.isNull(resolve());
  });

  it("tells which rules can never match outside the focus scopes", () => {
    const noScopes = { codeFocus: false, diffFocus: false, projectTreeFocus: false };
    const rule = (when?: string) =>
      compileResolvedKeybindingsConfig([
        when === undefined
          ? { key: "mod+b", command: "chat.new" }
          : { key: "mod+b", command: "chat.new", when },
      ])[0]!;
    for (const [when, canMatch] of [
      [undefined, true],
      ["codeFocus", false],
      ["!codeFocus", true],
      ["(codeFocus || projectTreeFocus) && codeSymbols", false],
      ["codeFocus || terminalFocus", true],
      ["!terminalFocus && codeSymbols", true],
      ["!(codeFocus || !diffFocus)", false],
    ] as const) {
      assert.strictEqual(ruleCanMatch(rule(when), noScopes), canMatch, String(when));
    }
  });
});

describe("defaults merged into a server's rules", () => {
  const resolveIn = (bindings: ResolvedKeybindingsConfig, key: string, context = {}) =>
    resolveShortcutCommand(press(key, "MacIntel"), bindings, { platform: "MacIntel", context });
  const inCode = { codeFocus: true, codeNavigation: true };
  const userRules = compileResolvedKeybindingsConfig([
    { key: "mod+b", command: "chat.newLocal" },
    { key: "meta+shift+b", command: "thread.pin" },
  ]);

  it("ranks new scoped defaults above the earlier defaults a server still sends", () => {
    const merged = mergeWithDefaultKeybindings(EARLIER_DEFAULTS);

    assert.deepStrictEqual(
      merged.filter((binding) => EARLIER_DEFAULTS.includes(binding)),
      EARLIER_DEFAULTS,
    );
    assert.strictEqual(resolveIn(merged, "mod+b", inCode), "code.goToDeclaration");
    assert.strictEqual(resolveIn(merged, "mod+b"), "sidebar.toggle");
    assert.strictEqual(resolveIn(merged, "f7", { diffFocus: true }), "diff.nextChange");
    // Extra shortcuts for a command the server already sends come only from its own config.
    assert.strictEqual(resolveIn(merged, "mod+shift+o", { codeFocus: true }), "chat.new");
  });

  it("keeps a rule the user wrote above every default it adds", () => {
    const merged = mergeWithDefaultKeybindings([...EARLIER_DEFAULTS, ...userRules]);

    for (const context of [{}, inCode]) {
      assert.strictEqual(resolveIn(merged, "mod+b", context), "chat.newLocal");
      assert.strictEqual(resolveIn(merged, "mod+shift+b", context), "thread.pin");
    }
  });

  // The placement rule, one layout of a shortcut's rules per row. A missing default goes right
  // after the earlier defaults on its shortcut. A rule the user wrote above all of those ranks
  // below them already and does not count; one among or after them still out-ranks the default.
  const rules = Object.fromEntries(
    Object.entries({
      jump: { key: "mod+1", command: "thread.jump.1", when: "!modelPickerOpen && isDesktop" },
      picker: { key: "mod+1", command: "modelPicker.jump.1", when: "modelPickerOpen && isDesktop" },
      olderJump: { key: "mod+1", command: "thread.jump.1" },
      pane: DEFAULT_KEYBINDINGS.find(({ command }) => command === "projectPane.toggle")!,
      sidebar: { key: "mod+b", command: "sidebar.toggle" },
      declaration: DEFAULT_KEYBINDINGS.find(({ command }) => command === "code.goToDeclaration")!,
      user: { key: "mod+1", command: "chat.newLocal" },
      userCtrl: { key: "ctrl+1", command: "thread.pin" },
      userOnB: { key: "mod+b", command: "chat.newLocal" },
      userMetaB: { key: "meta+b", command: "thread.pin" },
    } satisfies Record<string, KeybindingRule>).map(([name, rule]) => [
      name,
      compileResolvedKeybindingsConfig([rule])[0]!,
    ]),
  );
  it.each<{ config: string; missing: string; placed: string }>([
    { config: "", missing: "pane", placed: "pane" },
    { config: "jump picker", missing: "pane", placed: "jump picker pane" },
    { config: "jump picker user", missing: "pane", placed: "jump picker pane user" },
    { config: "user jump picker", missing: "pane", placed: "user jump picker pane" },
    {
      config: "userCtrl jump picker user",
      missing: "pane",
      placed: "userCtrl jump picker pane user",
    },
    { config: "jump user picker", missing: "pane", placed: "jump pane user picker" },
    { config: "jump userCtrl picker", missing: "pane", placed: "jump pane userCtrl picker" },
    { config: "olderJump picker", missing: "pane", placed: "olderJump picker pane" },
    { config: "user", missing: "pane", placed: "pane user" },
    { config: "sidebar", missing: "declaration", placed: "sidebar declaration" },
    { config: "userOnB sidebar", missing: "declaration", placed: "userOnB sidebar declaration" },
    {
      config: "userMetaB sidebar",
      missing: "declaration",
      placed: "userMetaB sidebar declaration",
    },
    { config: "sidebar userOnB", missing: "declaration", placed: "sidebar declaration userOnB" },
    // A default the config lacks goes below the later defaults on its shortcut.
    { config: "declaration", missing: "sidebar", placed: "sidebar declaration" },
    { config: "userOnB declaration", missing: "sidebar", placed: "sidebar userOnB declaration" },
    {
      config: "jump user picker",
      missing: "sidebar declaration",
      placed: "sidebar declaration jump user picker",
    },
  ])("places $missing into [$config] as [$placed]", ({ config, missing, placed }) => {
    const named = (names: string) =>
      names
        .split(" ")
        .filter(Boolean)
        .map((name) => rules[name]!);
    assert.deepStrictEqual(
      insertMissingDefaultKeybindings(named(config), named(missing), (rule) => rule),
      named(placed),
    );
  });

  it("ranks a new default above defaults from earlier builds", () => {
    using _capabilities = provide(["projectPane"]);
    const olderSpelling = compileResolvedKeybindingsConfig([
      { key: "mod+1", command: "thread.jump.1" },
      { key: "mod+1", command: "modelPicker.jump.1", when: "modelPickerOpen" },
    ]);
    const merged = mergeWithDefaultKeybindings([
      ...EARLIER_DEFAULTS.filter(
        ({ command }) => command !== "thread.jump.1" && command !== "modelPicker.jump.1",
      ),
      ...olderSpelling,
    ]);

    assert.strictEqual(
      resolveIn(merged, "mod+1", { isDesktop: true, codeFocus: true }),
      "projectPane.toggle",
    );
    assert.strictEqual(resolveIn(merged, "mod+1", { isDesktop: true }), "thread.jump.1");
  });

  it("puts a default the server lacks below the later defaults on its shortcut", () => {
    const merged = mergeWithDefaultKeybindings(
      DEFAULT_RESOLVED_KEYBINDINGS.filter(({ command }) => command !== "sidebar.toggle"),
    );

    assert.strictEqual(resolveIn(merged, "mod+b", inCode), "code.goToDeclaration");
    assert.strictEqual(resolveIn(merged, "mod+b"), "sidebar.toggle");
  });

  it("drops defaults, never a server rule, at the rule cap", () => {
    const full = [
      ...EARLIER_DEFAULTS,
      ...compileResolvedKeybindingsConfig(
        Array.from({ length: 256 - EARLIER_DEFAULTS.length }, (_, index) => ({
          key: "mod+alt+f9",
          command: `script.filler-${index}.run` as const,
        })),
      ),
    ];

    assert.deepStrictEqual(mergeWithDefaultKeybindings(full), full);
    // With four free slots the first three missing commands fit; the two-shortcut fourth waits
    // whole, as it does when the server writes its config.
    const nearlyFull = full.slice(0, -4);
    const merged = mergeWithDefaultKeybindings(nearlyFull);
    assert.deepStrictEqual(
      merged.filter((binding) => nearlyFull.includes(binding)),
      nearlyFull,
    );
    assert.sameMembers(
      merged.filter((binding) => !nearlyFull.includes(binding)).map(({ command }) => command),
      ["code.goToDeclaration", "code.goToTypeDeclaration", "code.goToImplementation"],
    );
  });
});
