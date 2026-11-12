import type { KeybindingCommand, KeybindingRule, KeybindingShortcut } from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_KEYBINDINGS,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";
import { describe, expect, it } from "vite-plus/test";

import {
  provideShortcutCapability,
  resolveShortcutCommand,
  type ShortcutCapability,
  type ShortcutMatchContext,
} from "../keybindings";
import {
  collectQuickReferenceCommands,
  fitQuickReference,
  quickReferenceGroupsForModifiers,
  type QuickReferenceGroup,
} from "./ShortcutQuickReference.logic";

const MAC = "MacIntel";
const NO_MODIFIERS = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
const CMD = { ...NO_MODIFIERS, metaKey: true };

function collect(
  context: Partial<ShortcutMatchContext>,
  rules: ReadonlyArray<KeybindingRule> = DEFAULT_KEYBINDINGS,
  scriptRules: ReadonlyArray<KeybindingRule> = [],
) {
  return collectQuickReferenceCommands({
    keybindings: compileResolvedKeybindingsConfig(rules),
    scriptKeybindings: compileResolvedKeybindingsConfig(scriptRules),
    context,
    platform: MAC,
  });
}

function commandsIn(groups: ReturnType<typeof collect>): ReadonlyArray<string> {
  return groups.flatMap((group) => group.commands.map((entry) => entry.command));
}

describe("collectQuickReferenceCommands", () => {
  it.each([
    {
      name: "composer focused",
      context: { composerFocus: true, editableFocus: true, isDesktop: true },
      listed: ["commandPalette.toggle", "thread.editQueuedMessage", "thread.jump.1"],
      unlisted: ["terminal.split", "modelPicker.jump.1", "thread.undo", "rightPanel.new"],
    },
    {
      name: "terminal focused",
      context: { terminalFocus: true, terminalOpen: true, isDesktop: true },
      listed: ["terminal.split", "terminal.new", "terminal.close", "terminal.toggle"],
      unlisted: ["commandPalette.toggle", "chat.new", "diff.toggle", "rightPanel.close"],
    },
    {
      name: "a file or the diff open in the right panel",
      context: { rightPanelOpen: true, isDesktop: true },
      listed: ["rightPanel.new", "rightPanel.close", "diff.toggle"],
      unlisted: ["terminal.close", "preview.refresh"],
    },
    {
      name: "the model picker open",
      context: { modelPickerOpen: true, editableFocus: true, isDesktop: true },
      listed: ["modelPicker.jump.1", "modelPicker.nextProvider"],
      unlisted: ["thread.jump.1"],
    },
  ])("lists what a key reaches with $name", ({ context, listed, unlisted }) => {
    const commands = commandsIn(collect(context));
    expect(commands).toEqual(expect.arrayContaining(listed));
    for (const command of unlisted) expect(commands).not.toContain(command);
  });

  it("lists a command another branch adds, and drops the one whose chord it takes", () => {
    const goToDeclaration = "code.goToDeclaration" as KeybindingCommand;
    const rules: ReadonlyArray<KeybindingRule> = [
      { key: "mod+b", command: "sidebar.toggle" },
      { key: "mod+b", command: goToDeclaration, when: "codeFocus" },
    ];

    expect(commandsIn(collect({ codeFocus: true }, rules))).toEqual([goToDeclaration]);
    expect(commandsIn(collect({}, rules))).toEqual(["sidebar.toggle"]);
  });

  it("groups like Settings and keeps every chord of a command", () => {
    const groups = collect({ isDesktop: true });

    expect(groups.map((group) => group.title)).toEqual([
      "Navigation",
      "Threads",
      "Composer",
      "Terminal",
      "Preview & diff",
      "Appearance",
      "Other",
    ]);
    const focusNext = groups
      .flatMap((group) => group.commands)
      .find((entry) => entry.command === "workspace.focusNext");
    expect(focusNext?.shortcuts.map((shortcut) => shortcut.key)).toEqual(["f6", "f6"]);
    expect(focusNext?.shortcuts.map((shortcut) => shortcut.modKey)).toEqual([true, false]);
  });

  it("takes project scripts from the thread's environment unless a command holds the chord", () => {
    const scripts: ReadonlyArray<KeybindingRule> = [
      { key: "mod+shift+u", command: "script.build.run" },
      { key: "mod+j", command: "script.lint.run" },
      { key: "mod+shift+y", command: "terminal.toggle" },
    ];
    const groups = collect({}, [{ key: "mod+j", command: "terminal.toggle" }], scripts);

    expect(
      groups.map((group) => [group.title, group.commands.map((entry) => entry.command)]),
    ).toEqual([
      ["Terminal", ["terminal.toggle"]],
      ["Project scripts", ["script.build.run"]],
    ]);
    expect(groups[0]?.commands[0]?.shortcuts.map((shortcut) => shortcut.key)).toEqual(["j"]);
  });
});

describe("collectQuickReferenceCommands against the keys", () => {
  const ALL_CAPABILITIES = ["codeNavigation", "codeSymbols", "projectPane"] as const;
  const GOES_TO_CODE = ["code.goToDeclaration", "code.fileStructure", "code.goToClass"];

  // The event a chord is, on `platform`: Mod is Cmd on macOS and Ctrl elsewhere.
  function pressing(shortcut: KeybindingShortcut, platform: string) {
    const mac = platform === MAC;
    return {
      key: shortcut.key,
      metaKey: shortcut.metaKey || (shortcut.modKey && mac),
      ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
      shiftKey: shortcut.shiftKey,
      altKey: shortcut.altKey,
    };
  }

  const FOCI = [
    {
      name: "no focus scope",
      context: { isDesktop: true },
      capabilities: ALL_CAPABILITIES,
      listed: ["commandPalette.toggle", "navigation.back"],
      unlisted: [...GOES_TO_CODE, "diff.nextChange", "projectPane.toggle"],
    },
    {
      name: "code with every capability",
      context: { isDesktop: true, codeFocus: true },
      capabilities: ALL_CAPABILITIES,
      listed: [...GOES_TO_CODE, "projectPane.toggle", "projectPane.selectOpenedFile"],
      unlisted: ["diff.nextChange", "diff.find"],
    },
    {
      name: "code without the capabilities",
      context: { isDesktop: true, codeFocus: true },
      capabilities: [],
      listed: ["filePicker.toggle"],
      unlisted: [...GOES_TO_CODE, "projectPane.toggle", "code.recentFiles"],
    },
    {
      name: "a diff",
      context: { isDesktop: true, diffFocus: true },
      capabilities: ALL_CAPABILITIES,
      listed: ["diff.nextChange", "diff.previousChange", "diff.jumpToSource", "diff.find"],
      unlisted: [...GOES_TO_CODE, "projectPane.toggle"],
    },
    {
      name: "a code pane that is also a diff",
      context: { isDesktop: true, codeFocus: true, diffFocus: true },
      capabilities: ALL_CAPABILITIES,
      listed: ["diff.nextChange", "code.goToDeclaration"],
      unlisted: [],
    },
    {
      name: "the Project tree",
      context: { isDesktop: true, projectTreeFocus: true },
      capabilities: ALL_CAPABILITIES,
      listed: ["projectPane.toggle", "filePicker.toggle", "code.goToClass"],
      unlisted: ["code.goToDeclaration", "diff.nextChange", "projectPane.selectOpenedFile"],
    },
  ] satisfies ReadonlyArray<{
    name: string;
    context: Partial<ShortcutMatchContext>;
    capabilities: ReadonlyArray<ShortcutCapability>;
    listed: ReadonlyArray<string>;
    unlisted: ReadonlyArray<string>;
  }>;

  it.each(FOCI.flatMap((focus) => [MAC, "Linux"].map((platform) => ({ ...focus, platform }))))(
    "lists $name on $platform, and each listed chord resolves to its command",
    ({ context, capabilities, listed, unlisted, platform }) => {
      using stack = new DisposableStack();
      for (const capability of capabilities) stack.defer(provideShortcutCapability(capability));
      const keybindings = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);

      const groups = collectQuickReferenceCommands({
        keybindings,
        scriptKeybindings: compileResolvedKeybindingsConfig([]),
        context,
        platform,
      });

      const commands = groups.flatMap((group) => group.commands.map((entry) => entry.command));
      expect(commands).toEqual(expect.arrayContaining(listed));
      for (const command of unlisted) expect(commands).not.toContain(command);
      const disagreements = groups.flatMap((group) =>
        group.commands.flatMap((entry) =>
          entry.shortcuts.flatMap((shortcut) => {
            const resolved = resolveShortcutCommand(pressing(shortcut, platform), keybindings, {
              platform,
              context,
            });
            return resolved === entry.command
              ? []
              : [`${entry.command} ${shortcut.key}: ${resolved}`];
          }),
        ),
      );
      expect(disagreements).toEqual([]);
    },
  );

  it("takes the capabilities the features provide, and drops them once withdrawn", () => {
    const keybindings = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);
    const listed = () =>
      collectQuickReferenceCommands({
        keybindings,
        scriptKeybindings: compileResolvedKeybindingsConfig([]),
        context: { isDesktop: true, codeFocus: true },
        platform: MAC,
      }).flatMap((group) => group.commands.map((entry) => entry.command));
    let works = true;
    const withdraw = provideShortcutCapability("codeNavigation", () => works);

    try {
      expect(listed()).toContain("code.goToDeclaration");
      works = false;
      expect(listed()).not.toContain("code.goToDeclaration");
      works = true;
    } finally {
      withdraw();
    }
    expect(listed()).not.toContain("code.goToDeclaration");
  });
});

describe("quickReferenceGroupsForModifiers", () => {
  const groups = collect({ isDesktop: true }, [
    { key: "mod+k", command: "commandPalette.toggle" },
    { key: "mod+shift+f", command: "projectSearch.toggle" },
    { key: "mod+b", command: "sidebar.toggle" },
    { key: "f6", command: "workspace.focusNext" },
    { key: "mod+f6", command: "workspace.focusNext" },
  ]);
  const view = (held: typeof CMD) =>
    quickReferenceGroupsForModifiers(groups, held, MAC).map((group) => [
      group.title,
      group.entries.map((entry) => `${entry.dimmed ? "dim " : ""}${entry.label} ${entry.keys}`),
    ]);

  it("leads each group with chords on exactly the held modifiers and dims the rest", () => {
    expect(view(CMD)).toEqual([
      [
        "Navigation",
        ["Command Palette: Toggle ⌘K", "Sidebar: Toggle ⌘B", "dim Project Search: Toggle ⇧⌘F"],
      ],
      ["Other", ["Focus Next Workspace Area ⌘F6"]],
    ]);
    expect(view({ ...CMD, shiftKey: true })).toEqual([
      [
        "Navigation",
        ["Project Search: Toggle ⇧⌘F", "dim Command Palette: Toggle ⌘K", "dim Sidebar: Toggle ⌘B"],
      ],
      ["Other", ["dim Focus Next Workspace Area ⌘F6"]],
    ]);
  });

  it("folds a numbered run of commands into one row", () => {
    const jumps = quickReferenceGroupsForModifiers(
      collectQuickReferenceCommands({
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
        scriptKeybindings: [],
        context: { isDesktop: true },
        platform: MAC,
      }),
      CMD,
      MAC,
    )
      .flatMap((group) => group.entries)
      .filter((entry) => entry.id.startsWith("thread.jump."));

    expect(jumps).toEqual([
      { id: "thread.jump.1", label: "Thread: Jump: 1–9", keys: "⌘1–9", dimmed: false },
    ]);
  });
});

describe("fitQuickReference", () => {
  const group = (id: string, bright: number, dimmed: number): QuickReferenceGroup => ({
    id,
    title: id,
    entries: Array.from({ length: bright + dimmed }, (_, index) => ({
      id: `${id}.${index}`,
      label: `Group ${id}: command number ${index}`,
      keys: "⌘K",
      dimmed: index >= bright,
    })),
  });
  // 96 commands in 7 groups: more than the app ships once the code commands land.
  const groups = ["a", "b", "c", "d", "e", "f"]
    .map((id) => group(id, 6, 8))
    .concat(group("g", 12, 0));
  const entries = (view: ReturnType<typeof fitQuickReference>) =>
    view.columns.flatMap((column) => column.flatMap((entry) => entry.entries));
  const tallestColumn = (view: ReturnType<typeof fitQuickReference>) =>
    Math.max(
      ...view.columns.map((column) =>
        column.reduce(
          (lines, entry, index) =>
            lines + entry.entries.length + (entry.continued ? 0 : index > 0 ? 1.5 : 1),
          0,
        ),
      ),
    );

  it("spreads 90 commands over the columns a 1280 window has beside the sidebar", () => {
    const view = fitQuickReference(groups, { widthRem: 64, heightRem: 50 });

    expect(view.hiddenCount).toBe(0);
    // No group is split while whole groups fit the 33 lines the height holds.
    expect(view.columns.map((column) => column.map((entry) => entry.id))).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g"],
    ]);
    expect(entries(view).map((entry) => entry.id)).toEqual(
      groups.flatMap((entry) => entry.entries.map((row) => row.id)),
    );
    expect(tallestColumn(view)).toBeLessThanOrEqual(33);
  });

  it("splits only a group too long for one column, and names it once", () => {
    const view = fitQuickReference([group("x", 40, 0), group("y", 5, 0)], {
      widthRem: 40,
      heightRem: 50,
    });

    expect(view.hiddenCount).toBe(0);
    expect(
      view.columns.map((column) =>
        column.map((entry) => [entry.id, entry.entries.length, entry.continued]),
      ),
    ).toEqual([
      [["x", 23, false]],
      [
        ["x", 17, true],
        ["y", 5, false],
      ],
    ]);
  });

  it("uses more columns on a wide window instead of growing tall", () => {
    const view = fitQuickReference(groups, { widthRem: 150, heightRem: 50 });

    expect(view.columns.map((column) => column.map((entry) => entry.id))).toEqual(
      groups.map((entry) => [entry.id]),
    );
  });

  it("drops dimmed entries first when the window is too small, and counts them", () => {
    const view = fitQuickReference(groups, { widthRem: 40, heightRem: 50 });

    expect(view.columns).toHaveLength(2);
    // Every chord on the held modifiers outlives every other one.
    expect(entries(view).filter((entry) => !entry.dimmed)).toHaveLength(48);
    expect(view.hiddenCount).toBe(96 - entries(view).length);
    expect(view.hiddenCount).toBeGreaterThanOrEqual(43);
    // Space is short, so groups run on into the next column, each named once.
    const headings = view.columns.flat().filter((entry) => !entry.continued);
    expect(headings.map((entry) => entry.id)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    // 33 lines fit the height, one of them for the count under the columns.
    expect(tallestColumn(view)).toBeLessThanOrEqual(32);
  });

  it("still fits one column on a phone", () => {
    const view = fitQuickReference(groups, { widthRem: 24, heightRem: 50 });

    expect(view.columns).toHaveLength(1);
    expect(entries(view).length + view.hiddenCount).toBe(96);
    expect(tallestColumn(view)).toBeLessThanOrEqual(32);
  });
});
