import {
  type KeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  MAX_KEYBINDINGS_COUNT,
  MAX_WHEN_EXPRESSION_DEPTH,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";

export {
  EVENT_CODE_SHORTCUT_KEYS,
  isMacPlatform,
  matchesKeybindingShortcut,
  matchesKeybindingShortcutModifiers,
  normalizeEventKey,
  resolveEventKeys,
  shortcutKeyFromEvent,
  type ShortcutEventLike,
  type ShortcutModifierStateLike,
} from "./keybindingMatching.ts";

export const US_SHIFTED_TO_UNSHIFTED_KEYS: ReadonlyMap<string, string> = new Map([
  ["!", "1"],
  ["@", "2"],
  ["#", "3"],
  ["$", "4"],
  ["%", "5"],
  ["^", "6"],
  ["&", "7"],
  ["*", "8"],
  ["(", "9"],
  [")", "0"],
  ["~", "`"],
  ["_", "-"],
  ["+", "="],
  ["{", "["],
  ["}", "]"],
  ["|", "\\"],
  [":", ";"],
  ['"', "'"],
  ["<", ","],
  [">", "."],
  ["?", "/"],
]);

type WhenToken =
  | { type: "identifier"; value: string }
  | { type: "not" }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" };

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+b", command: "sidebar.toggle" },
  { key: "f6", command: "workspace.focusNext" },
  { key: "shift+f6", command: "workspace.focusPrevious" },
  // Some browsers keep plain F6 for their own toolbars; mod+F6 reaches the page in all of them.
  { key: "mod+f6", command: "workspace.focusNext" },
  { key: "mod+shift+f6", command: "workspace.focusPrevious" },
  // A command is labelled with its last rule, so these stay ahead of mod+[ and mod+]. Desktop
  // only: browsers keep mod+alt+arrows for their tabs.
  { key: "mod+alt+arrowleft", command: "navigation.back", when: "!terminalFocus && isDesktop" },
  { key: "mod+alt+arrowright", command: "navigation.forward", when: "!terminalFocus && isDesktop" },
  { key: "mod+[", command: "navigation.back", when: "!terminalFocus" },
  { key: "mod+]", command: "navigation.forward", when: "!terminalFocus" },
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+alt+b", command: "rightPanel.toggle" },
  { key: "mod+shift+b", command: "threadPanel.toggle", when: "!terminalFocus" },
  { key: "mod+t", command: "rightPanel.new", when: "rightPanelOpen && !terminalFocus" },
  { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+shift+d", command: "terminal.splitVertical", when: "terminalFocus" },
  { key: "mod+shift+d", command: "composer.dictation", when: "!terminalFocus" },
  { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  { key: "mod+w", command: "rightPanel.close", when: "!terminalFocus" },
  { key: "mod+shift+t", command: "view.reopenClosed" },
  { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
  { key: "mod+shift+j", command: "preview.toggle" },
  { key: "mod+r", command: "preview.refresh", when: "previewFocus" },
  { key: "mod+l", command: "preview.focusUrl", when: "previewFocus" },
  { key: "mod+=", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod++", command: "preview.zoomIn", when: "previewFocus" },
  { key: "mod+-", command: "preview.zoomOut", when: "previewFocus" },
  { key: "mod+0", command: "preview.resetZoom", when: "previewFocus" },
  { key: "mod+k", command: "commandPalette.toggle", when: "!terminalFocus" },
  { key: "mod+p", command: "filePicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+f", command: "projectSearch.toggle", when: "!terminalFocus" },
  { key: "mod+u", command: "usage.open", when: "!terminalFocus" },
  { key: "mod+alt+a", command: "theme.select", when: "!terminalFocus" },
  { key: "mod+alt+shift+a", command: "appearance.cycle", when: "!terminalFocus" },
  { key: "mod+alt+shift+t", command: "themeEditor.toggle" },
  { key: "mod+s", command: "composer.stash", when: "!terminalFocus" },
  { key: "mod+shift+enter", command: "thread.steerQueuedMessage", when: "!terminalFocus" },
  { key: "alt+arrowup", command: "thread.editQueuedMessage", when: "composerFocus" },
  { key: "mod+enter", command: "composer.sendAlternate", when: "composerFocus && turnRunning" },
  {
    key: "mod+enter",
    command: "composer.sendBackground",
    when: "composerFocus && draftThreadRoute",
  },
  {
    key: "mod+alt+enter",
    command: "composer.sendBackground",
    when: "composerFocus && draftThreadRoute",
  },
  {
    key: "mod+alt+enter",
    command: "composer.sendAndNewThread",
    when: "composerFocus && !draftThreadRoute",
  },
  { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
  { key: "mod+alt+n", command: "chat.newWithoutProject", when: "!terminalFocus" },
  { key: "mod+f", command: "chat.find", when: "!terminalFocus && !previewFocus" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+h", command: "composer.host", when: "!terminalFocus" },
  { key: "mod+shift+e", command: "composer.effort", when: "!terminalFocus" },
  { key: "mod+shift+a", command: "composer.mode", when: "!terminalFocus" },
  { key: "mod+shift+x", command: "composer.workspace", when: "!terminalFocus" },
  { key: "mod+shift+g", command: "composer.branch", when: "!terminalFocus" },
  { key: "mod+shift+l", command: "composer.previousWorktree", when: "!terminalFocus" },
  { key: "mod+shift+k", command: "pullRequest.copyNumber", when: "!terminalFocus" },
  { key: "mod+shift+arrowup", command: "modelPicker.previousProvider", when: "modelPickerOpen" },
  { key: "mod+shift+arrowdown", command: "modelPicker.nextProvider", when: "modelPickerOpen" },
  { key: "mod+o", command: "editor.openFavorite" },
  { key: "mod+shift+[", command: "thread.previous" },
  { key: "mod+shift+]", command: "thread.next" },
  { key: "mod+shift+c", command: "thread.copyReference", when: "!terminalFocus" },
  { key: "mod+shift+s", command: "thread.settle", when: "!terminalFocus" },
  { key: "mod+shift+p", command: "thread.pin", when: "!terminalFocus" },
  { key: "mod+z", command: "thread.undo", when: "!terminalFocus && !editableFocus" },
  ...THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    key: `mod+${index + 1}`,
    command,
    when: "!modelPickerOpen && isDesktop",
  })),
  ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    key: `mod+${index + 1}`,
    command,
    when: "modelPickerOpen && isDesktop",
  })),
  { key: "c", command: "usage.cost", when: "usagePageOpen" },
  { key: "t", command: "usage.tokens", when: "usagePageOpen" },
  { key: "l", command: "usage.limits", when: "usagePageOpen" },
  { key: "mod+shift+1", command: "usage.period.day", when: "usagePageOpen" },
  { key: "mod+shift+2", command: "usage.period.week", when: "usagePageOpen" },
  { key: "mod+shift+3", command: "usage.period.month", when: "usagePageOpen" },
  { key: "mod+shift+4", command: "usage.period.quarter", when: "usagePageOpen" },
  // JetBrains keys. The last match wins, so these stay below the defaults whose shortcuts they
  // share. A rule on a shared shortcut must not match before its command has a handler there
  // (nothing falls through): a scope says what a surface is, a capability that a feature works.
  // A command is labelled with its last rule, so the shortcut JetBrains shows comes last.
  { key: "mod+b", command: "code.goToDeclaration", when: "codeFocus && codeNavigation" },
  { key: "mod+shift+b", command: "code.goToTypeDeclaration", when: "codeFocus && codeNavigation" },
  { key: "mod+alt+b", command: "code.goToImplementation", when: "codeFocus && codeNavigation" },
  { key: "mod+alt+f7", command: "code.findUsages", when: "codeFocus && codeNavigation" },
  { key: "alt+f7", command: "code.findUsages", when: "codeFocus && codeNavigation" },
  { key: "mod+shift+f7", command: "code.highlightUsages", when: "codeFocus && codeNavigation" },
  { key: "f1", command: "code.quickDocumentation", when: "codeFocus && codeNavigation" },
  { key: "alt+space", command: "code.quickDefinition", when: "codeFocus && codeNavigation" },
  { key: "mod+l", command: "code.goToLine", when: "codeFocus && codeNavigation" },
  {
    key: "mod+o",
    command: "code.goToClass",
    when: "(codeFocus || projectTreeFocus) && codeSymbols",
  },
  { key: "mod+alt+o", command: "code.goToSymbol", when: "!terminalFocus && codeSymbols" },
  { key: "mod+shift+o", command: "filePicker.toggle", when: "codeFocus || projectTreeFocus" },
  { key: "mod+e", command: "code.recentFiles", when: "!terminalFocus && codeSymbols" },
  { key: "mod+f12", command: "code.fileStructure", when: "codeFocus && codeSymbols" },
  { key: "ctrl+shift+arrowdown", command: "code.nextMethod", when: "codeFocus && codeSymbols" },
  { key: "ctrl+shift+arrowup", command: "code.previousMethod", when: "codeFocus && codeSymbols" },
  { key: "f7", command: "diff.nextChange", when: "diffFocus" },
  { key: "shift+f7", command: "diff.previousChange", when: "diffFocus" },
  { key: "mod+arrowdown", command: "diff.jumpToSource", when: "diffFocus" },
  { key: "f4", command: "diff.jumpToSource", when: "diffFocus" },
  // After chat.find: in a diff, mod+f finds in the pane.
  { key: "mod+f", command: "diff.find", when: "diffFocus" },
  // Desktop only: browsers keep mod+1 for their tabs.
  {
    key: "mod+1",
    command: "projectPane.toggle",
    when: "(codeFocus || projectTreeFocus) && projectPane && isDesktop",
  },
  { key: "alt+f1", command: "projectPane.selectOpenedFile", when: "codeFocus && projectPane" },
];

function normalizeKeyToken(token: string): string {
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

export function parseKeybindingShortcut(value: string): KeybindingShortcut | null {
  const rawTokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  const tokens = [...rawTokens];
  let trailingEmptyCount = 0;
  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount += 1;
    tokens.pop();
  }
  if (trailingEmptyCount > 0) {
    tokens.push("+");
  }
  if (tokens.some((token) => token.length === 0)) {
    return null;
  }
  if (tokens.length === 0) return null;

  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default: {
        if (key !== null) return null;
        key = normalizeKeyToken(token);
      }
    }
  }

  if (key === null) return null;
  return {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    altKey,
    modKey,
  };
}

function tokenizeWhenExpression(expression: string): WhenToken[] | null {
  const tokens: WhenToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const current = expression[index];
    if (!current) break;

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (expression.startsWith("&&", index)) {
      tokens.push({ type: "and" });
      index += 2;
      continue;
    }
    if (expression.startsWith("||", index)) {
      tokens.push({ type: "or" });
      index += 2;
      continue;
    }
    if (current === "!") {
      tokens.push({ type: "not" });
      index += 1;
      continue;
    }
    if (current === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
      continue;
    }
    if (current === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(index));
    if (!identifier) {
      return null;
    }
    tokens.push({ type: "identifier", value: identifier[0] });
    index += identifier[0].length;
  }

  return tokens;
}

export function parseKeybindingWhenExpression(expression: string): KeybindingWhenNode | null {
  const tokens = tokenizeWhenExpression(expression);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;

  const parsePrimary = (depth: number): KeybindingWhenNode | null => {
    if (depth > MAX_WHEN_EXPRESSION_DEPTH) {
      return null;
    }
    const token = tokens[index];
    if (!token) return null;

    if (token.type === "identifier") {
      index += 1;
      return { type: "identifier", name: token.value };
    }

    if (token.type === "lparen") {
      index += 1;
      const expressionNode = parseOr(depth + 1);
      const closeToken = tokens[index];
      if (!expressionNode || !closeToken || closeToken.type !== "rparen") {
        return null;
      }
      index += 1;
      return expressionNode;
    }

    return null;
  };

  const parseUnary = (depth: number): KeybindingWhenNode | null => {
    let notCount = 0;
    while (tokens[index]?.type === "not") {
      index += 1;
      notCount += 1;
      if (notCount > MAX_WHEN_EXPRESSION_DEPTH) {
        return null;
      }
    }

    let node = parsePrimary(depth);
    if (!node) return null;

    while (notCount > 0) {
      node = { type: "not", node };
      notCount -= 1;
    }

    return node;
  };

  const parseAnd = (depth: number): KeybindingWhenNode | null => {
    let left = parseUnary(depth);
    if (!left) return null;

    while (tokens[index]?.type === "and") {
      index += 1;
      const right = parseUnary(depth);
      if (!right) return null;
      left = { type: "and", left, right };
    }

    return left;
  };

  const parseOr = (depth: number): KeybindingWhenNode | null => {
    let left = parseAnd(depth);
    if (!left) return null;

    while (tokens[index]?.type === "or") {
      index += 1;
      const right = parseAnd(depth);
      if (!right) return null;
      left = { type: "or", left, right };
    }

    return left;
  };

  const ast = parseOr(0);
  if (!ast || index !== tokens.length) return null;
  return ast;
}

export function compileResolvedKeybindingRule(rule: KeybindingRule): ResolvedKeybindingRule | null {
  const shortcut = parseKeybindingShortcut(rule.key);
  if (!shortcut) return null;

  if (rule.when !== undefined) {
    const whenAst = parseKeybindingWhenExpression(rule.when);
    if (!whenAst) return null;
    return {
      command: rule.command,
      shortcut,
      whenAst,
    };
  }

  return {
    command: rule.command,
    shortcut,
  };
}

export function compileResolvedKeybindingsConfig(
  config: ReadonlyArray<KeybindingRule>,
): ResolvedKeybindingsConfig {
  const compiled: ResolvedKeybindingRule[] = [];
  for (const rule of config) {
    const result = compileResolvedKeybindingRule(rule);
    if (result) {
      compiled.push(result);
    }
  }
  return compiled.slice(-MAX_KEYBINDINGS_COUNT);
}

export const DEFAULT_RESOLVED_KEYBINDINGS = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);

// Earlier builds wrote these defaults into keybindings.json, on shortcuts a later default shares.
const SUPERSEDED_DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+1", command: "thread.jump.1" },
  { key: "mod+1", command: "thread.jump.1", when: "isDesktop" },
  { key: "mod+1", command: "modelPicker.jump.1", when: "modelPickerOpen" },
  { key: "mod+shift+o", command: "chat.new" },
];

function whenIdentity(node: KeybindingWhenNode): string {
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!(${whenIdentity(node.node)})`;
    case "and":
      return `(${whenIdentity(node.left)}&&${whenIdentity(node.right)})`;
    case "or":
      return `(${whenIdentity(node.left)}||${whenIdentity(node.right)})`;
  }
}

function ruleIdentity({ command, shortcut, whenAst }: ResolvedKeybindingRule): string {
  return JSON.stringify([
    command,
    shortcut.key,
    shortcut.modKey,
    shortcut.metaKey,
    shortcut.ctrlKey,
    shortcut.altKey,
    shortcut.shiftKey,
    whenAst ? whenIdentity(whenAst) : null,
  ]);
}

// A rule's place in the default list; superseded defaults come before all of it.
const DEFAULT_RULE_ORDER = new Map([
  ...compileResolvedKeybindingsConfig(SUPERSEDED_DEFAULT_KEYBINDINGS).map(
    (rule) => [ruleIdentity(rule), -1] as const,
  ),
  ...DEFAULT_RESOLVED_KEYBINDINGS.map((rule, index) => [ruleIdentity(rule), index] as const),
]);

// Which of Cmd and Ctrl `mod` means is the client's to know, so mod, ctrl and meta count as one
// modifier here. Matching too much only places a default more cautiously.
function shortcutPlacementKey(shortcut: KeybindingShortcut): string {
  return [
    shortcut.key,
    shortcut.modKey || shortcut.metaKey || shortcut.ctrlKey ? "primary" : "",
    shortcut.shiftKey ? "shift" : "",
    shortcut.altKey ? "alt" : "",
  ].join("|");
}

function missingDefaultInsertIndex(
  config: ReadonlyArray<ResolvedKeybindingRule | null>,
  rule: ResolvedKeybindingRule,
  order: number,
): number {
  const placementKey = shortcutPlacementKey(rule.shortcut);
  let afterEarlierOnShortcut = 0;
  let outRankedAt = config.length;
  for (const [index, entry] of config.entries()) {
    if (entry === null || shortcutPlacementKey(entry.shortcut) !== placementKey) continue;
    const entryOrder = DEFAULT_RULE_ORDER.get(ruleIdentity(entry));
    if (entryOrder !== undefined && entryOrder <= order) {
      afterEarlierOnShortcut = index + 1;
      // A rule the user wrote above an earlier default ranks below that default already.
      outRankedAt = config.length;
      continue;
    }
    outRankedAt = Math.min(outRankedAt, index);
    if (entryOrder !== undefined || afterEarlierOnShortcut > 0) break;
  }
  let afterOwnEarlier = 0;
  for (const [index, entry] of config.entries()) {
    if (entry?.command !== rule.command) continue;
    const entryOrder = DEFAULT_RULE_ORDER.get(ruleIdentity(entry));
    if (entryOrder !== undefined && entryOrder < order) afterOwnEarlier = index + 1;
  }
  // A command is named by its last rule, but which command a key runs comes first.
  return Math.min(Math.max(afterEarlierOnShortcut, afterOwnEarlier), outRankedAt);
}

/**
 * Adds defaults a config lacks without moving what it holds. A default goes below the earlier
 * defaults on its shortcut and of its own command, as in a fresh config, and above the first rule
 * on its shortcut that out-ranks it: a later default, or a rule the user wrote below the earlier.
 */
export function insertMissingDefaultKeybindings<Rule>(
  config: ReadonlyArray<Rule>,
  missingDefaults: ReadonlyArray<Rule>,
  resolve: (rule: Rule) => ResolvedKeybindingRule | null,
): Rule[] {
  const first: Rule[] = [];
  const merged = [...config];
  const mergedResolved = merged.map(resolve);
  const inDefaultOrder = missingDefaults
    .map((rule) => {
      const resolved = resolve(rule);
      const order = resolved ? DEFAULT_RULE_ORDER.get(ruleIdentity(resolved)) : undefined;
      return { rule, resolved, order };
    })
    .sort((left, right) => (left.order ?? -1) - (right.order ?? -1));
  for (const { rule, resolved, order } of inDefaultOrder) {
    const insertIndex =
      resolved && order !== undefined
        ? missingDefaultInsertIndex(mergedResolved, resolved, order)
        : 0;
    if (insertIndex === 0) {
      first.push(rule);
      continue;
    }
    merged.splice(insertIndex, 0, rule);
    mergedResolved.splice(insertIndex, 0, resolved);
  }
  return [...first, ...merged];
}

/**
 * The missing defaults a config has room for, from the front of the list. A command comes whole
 * or waits: a config that holds one of a command's rules counts as having set that command, so
 * a rule cut off here would never be added.
 */
export function missingDefaultsThatFit<Rule extends { readonly command: string }>(
  missingDefaults: ReadonlyArray<Rule>,
  room: number,
): Rule[] {
  const cutOff = new Set(missingDefaults.slice(room).map((rule) => rule.command));
  return missingDefaults.slice(0, room).filter((rule) => !cutOff.has(rule.command));
}

export function mergeWithDefaultKeybindings(
  custom: ResolvedKeybindingsConfig,
): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return [...DEFAULT_RESOLVED_KEYBINDINGS];
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  // Over the cap defaults give way, never a custom rule, and the same ones the server leaves out.
  const room = Math.max(0, MAX_KEYBINDINGS_COUNT - custom.length);
  const merged = insertMissingDefaultKeybindings(
    custom,
    missingDefaultsThatFit(retainedDefaults, room),
    (rule) => rule,
  );

  if (merged.length <= MAX_KEYBINDINGS_COUNT) {
    return merged;
  }

  return merged.slice(-MAX_KEYBINDINGS_COUNT);
}
