import type {
  KeybindingCommand,
  KeybindingShortcut,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  isMacPlatform,
  matchesKeybindingShortcutModifiers,
  type ShortcutModifierStateLike,
} from "@t3tools/shared/keybindings";

import {
  effectiveShortcutsForCommand,
  formatShortcutLabel,
  shortcutConflictKey,
  type ShortcutMatchContext,
} from "../keybindings";
import { projectScriptIdFromCommand } from "../projectScripts";
import {
  buildKeybindingRows,
  commandLabel,
  groupKeybindingRows,
} from "./settings/KeybindingsSettings.logic";

export const QUICK_REFERENCE_SHOW_DELAY_MS = 700;

/** Whether the platform's shortcut modifier (Cmd on macOS, Ctrl elsewhere) is down. */
export function isQuickReferenceModifierHeld(
  modifiers: ShortcutModifierStateLike,
  platform: string,
): boolean {
  return isMacPlatform(platform) ? modifiers.metaKey : modifiers.ctrlKey;
}

// AltGraph is left out on purpose: Windows reports AltGr as Control, and typing with it is not a hold.
const MODIFIER_KEYS = new Set(["Meta", "OS", "Command", "Control", "Alt", "Option", "Shift"]);

// A native drag sends no pointer events; `drag` covers one that left the window.
const INTERRUPTING_EVENTS = ["pointerdown", "pointerup", "wheel", "drag", "dragover"] as const;

/**
 * Calls `onInterrupt` when the user does anything but hold modifiers: another
 * key, a pointer press, pointer travel, a wheel or a drag. Every listener is
 * passive, so it can only watch.
 */
export function watchQuickReferenceInterruptions(
  target: Window,
  onInterrupt: () => void,
): () => void {
  let lastPointer: { readonly x: number; readonly y: number } | null = null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (!MODIFIER_KEYS.has(event.key)) onInterrupt();
  };
  // Browsers re-send a still pointer when content moves under it, so only travel counts.
  const onPointerMove = (event: PointerEvent) => {
    const travelled =
      event.movementX !== 0 ||
      event.movementY !== 0 ||
      (lastPointer !== null &&
        (lastPointer.x !== event.screenX || lastPointer.y !== event.screenY));
    lastPointer = { x: event.screenX, y: event.screenY };
    if (travelled) onInterrupt();
  };
  const options = { capture: true, passive: true } as const;
  target.addEventListener("keydown", onKeyDown, options);
  target.addEventListener("pointermove", onPointerMove, options);
  for (const type of INTERRUPTING_EVENTS) target.addEventListener(type, onInterrupt, options);
  return () => {
    target.removeEventListener("keydown", onKeyDown, options);
    target.removeEventListener("pointermove", onPointerMove, options);
    for (const type of INTERRUPTING_EVENTS) target.removeEventListener(type, onInterrupt, options);
  };
}

/**
 * Tracks whether a pointer button is down. A pressed pointer that stays still
 * (a paused drag) sends no events, so a hold that starts then cannot see it.
 */
export function trackPointerPressed(target: Window): {
  readonly isPressed: () => boolean;
  readonly dispose: () => void;
} {
  let pressed = false;
  const onPointerDown = () => {
    pressed = true;
  };
  const onPointerUp = (event: PointerEvent) => {
    pressed = event.buttons !== 0;
  };
  const onRelease = () => {
    pressed = false;
  };
  const options = { capture: true, passive: true } as const;
  target.addEventListener("pointerdown", onPointerDown, options);
  target.addEventListener("pointerup", onPointerUp, options);
  target.addEventListener("pointercancel", onRelease, options);
  target.addEventListener("blur", onRelease);
  return {
    isPressed: () => pressed,
    dispose: () => {
      target.removeEventListener("pointerdown", onPointerDown, options);
      target.removeEventListener("pointerup", onPointerUp, options);
      target.removeEventListener("pointercancel", onRelease, options);
      target.removeEventListener("blur", onRelease);
    },
  };
}

const FOCUS_SCOPE_ATTRIBUTE = "data-focus-scope";

/**
 * Whether the pointer rests on a `code` focus scope, where a held modifier is
 * the start of a Cmd+click. Hover reaches a scope through open shadow roots.
 */
export function isPointerOverCodeScope(root: Document | ShadowRoot = document): boolean {
  if (root.querySelector(`[${FOCUS_SCOPE_ATTRIBUTE}~="code"]:hover`) !== null) return true;
  for (const hovered of root.querySelectorAll(":hover")) {
    if (hovered.shadowRoot && isPointerOverCodeScope(hovered.shadowRoot)) return true;
  }
  return false;
}

function parentAcrossShadowRoots(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/**
 * The `when` variables of the focus scopes around the focused element:
 * `data-focus-scope="code diff"` gives `codeFocus` and `diffFocus`.
 */
export function readFocusScopeContext(): Record<string, boolean> {
  const context: Record<string, boolean> = {};
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  for (; element; element = parentAcrossShadowRoots(element)) {
    for (const scope of element.getAttribute(FOCUS_SCOPE_ATTRIBUTE)?.split(/\s+/) ?? []) {
      if (scope.length === 0) continue;
      const name = scope.replace(/-(.)/g, (_, letter: string) => letter.toUpperCase());
      context[`${name}Focus`] = true;
    }
  }
  return context;
}

export interface QuickReferenceCommand {
  readonly command: KeybindingCommand;
  readonly shortcuts: ReadonlyArray<KeybindingShortcut>;
}

export interface QuickReferenceCommandGroup {
  readonly id: string;
  readonly title: string;
  readonly commands: ReadonlyArray<QuickReferenceCommand>;
}

/**
 * The commands a key can reach in `context`, in Settings' groups and order.
 * Chat runs project scripts from the thread's environment and every other
 * command from the primary one, so the two lists are read the same way here.
 */
export function collectQuickReferenceCommands(input: {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly scriptKeybindings: ResolvedKeybindingsConfig;
  readonly context: Partial<ShortcutMatchContext>;
  readonly platform: string;
}): ReadonlyArray<QuickReferenceCommandGroup> {
  const { keybindings, scriptKeybindings, platform } = input;
  const options = { platform, context: input.context };
  const shortcutsByCommand = new Map<KeybindingCommand, ReadonlyArray<KeybindingShortcut>>();
  const claimedChords = new Set<string>();

  const reachableRows = (config: ResolvedKeybindingsConfig, scripts: boolean) =>
    buildKeybindingRows(config, platform).filter((row) => {
      if (shortcutsByCommand.has(row.command)) return false;
      if ((projectScriptIdFromCommand(row.command) !== null) !== scripts) return false;
      const shortcuts = effectiveShortcutsForCommand(config, row.command, options).filter(
        (shortcut) => !claimedChords.has(shortcutConflictKey(shortcut, platform)),
      );
      shortcutsByCommand.set(row.command, shortcuts);
      return shortcuts.length > 0;
    });

  const commandRows = reachableRows(keybindings, false);
  // A primary command on the same chord runs instead of the thread environment's script.
  for (const row of commandRows) {
    for (const shortcut of shortcutsByCommand.get(row.command) ?? []) {
      claimedChords.add(shortcutConflictKey(shortcut, platform));
    }
  }
  const rows = [...commandRows, ...reachableRows(scriptKeybindings, true)];

  return groupKeybindingRows(rows).map((group) => ({
    id: group.id,
    title: group.title,
    commands: group.rows.map((row) => ({
      command: row.command,
      shortcuts: shortcutsByCommand.get(row.command) ?? [],
    })),
  }));
}

export interface QuickReferenceEntry {
  readonly id: string;
  readonly label: string;
  readonly keys: string;
  /** The chord needs other modifiers than the ones held now. */
  readonly dimmed: boolean;
}

export interface QuickReferenceGroup {
  readonly id: string;
  readonly title: string;
  readonly entries: ReadonlyArray<QuickReferenceEntry>;
}

interface PickedShortcut {
  readonly command: KeybindingCommand;
  readonly shortcut: KeybindingShortcut;
  readonly matchesHeld: boolean;
}

/** The chord to show for a command: one on exactly the held modifiers, else its first. */
function pickShortcut(
  { command, shortcuts }: QuickReferenceCommand,
  held: ShortcutModifierStateLike,
  platform: string,
): PickedShortcut | null {
  const matching = shortcuts.find((shortcut) =>
    matchesKeybindingShortcutModifiers(held, shortcut, platform),
  );
  const shortcut = matching ?? shortcuts[0];
  return shortcut ? { command, shortcut, matchesHeld: matching !== undefined } : null;
}

const NUMBERED_COMMAND = /^(.+)\.(\d)$/;
const MIN_SERIES_LENGTH = 3;

function sameModifiers(left: KeybindingShortcut, right: KeybindingShortcut): boolean {
  return (
    left.modKey === right.modKey &&
    left.metaKey === right.metaKey &&
    left.ctrlKey === right.ctrlKey &&
    left.shiftKey === right.shiftKey &&
    left.altKey === right.altKey
  );
}

/** How many entries from `start` are one numbered series: `x.1`…`x.N` on one chord whose key is that number. */
function seriesLength(picked: ReadonlyArray<PickedShortcut>, start: number): number {
  const first = picked[start];
  const match = first ? NUMBERED_COMMAND.exec(first.command) : null;
  if (!first || !match || first.shortcut.key !== match[2]) return 1;
  const firstNumber = Number(match[2]);
  let length = 1;
  for (;;) {
    const next = picked[start + length];
    const number = String(firstNumber + length);
    if (
      !next ||
      next.command !== `${match[1]}.${number}` ||
      next.shortcut.key !== number ||
      !sameModifiers(next.shortcut, first.shortcut) ||
      !commandLabel(next.command).endsWith(number)
    ) {
      break;
    }
    length += 1;
  }
  return length >= MIN_SERIES_LENGTH && commandLabel(first.command).endsWith(match[2]) ? length : 1;
}

function toEntries(
  picked: ReadonlyArray<PickedShortcut>,
  platform: string,
): ReadonlyArray<QuickReferenceEntry> {
  const entries: Array<QuickReferenceEntry> = [];
  for (let index = 0; index < picked.length;) {
    const first = picked[index];
    if (!first) break;
    const length = seriesLength(picked, index);
    const last = picked[index + length - 1] ?? first;
    const range = length > 1 ? `–${last.shortcut.key}` : "";
    entries.push({
      id: first.command,
      label: `${commandLabel(first.command)}${range}`,
      keys: `${formatShortcutLabel(first.shortcut, platform)}${range}`,
      dimmed: !first.matchesHeld,
    });
    index += length;
  }
  return entries;
}

/**
 * The list while `held` is down. Chords on exactly the held modifiers lead each
 * group; the rest follow, dimmed.
 */
export function quickReferenceGroupsForModifiers(
  groups: ReadonlyArray<QuickReferenceCommandGroup>,
  held: ShortcutModifierStateLike,
  platform: string,
): ReadonlyArray<QuickReferenceGroup> {
  return groups.flatMap((group) => {
    const picked = group.commands.flatMap((command) => pickShortcut(command, held, platform) ?? []);
    if (picked.length === 0) return [];
    const entries = [
      ...toEntries(
        picked.filter((entry) => entry.matchesHeld),
        platform,
      ),
      ...toEntries(
        picked.filter((entry) => !entry.matchesHeld),
        platform,
      ),
    ];
    return [{ id: group.id, title: group.title, entries }];
  });
}

// Sizes in rem, mirrored by the classes in ShortcutQuickReference.tsx.
const COLUMN_GAP_REM = 1.5;
// The panel's margin from the window plus its own padding, on each side.
const PANEL_INSET_REM = 2;
const LINE_HEIGHT_REM = 1.375;
const GROUP_GAP_LINES = 0.5;
const PREFERRED_COLUMN_LINES = 16;
const MAX_COLUMNS = 8;
// Widths at the panel's 12px text, rounded up: a letter, a modifier glyph, a row's gap and key padding.
const CHARACTER_REM = 0.4;
const MODIFIER_GLYPH_REM = 0.7;
const ROW_CHROME_REM = 1.25;
const MODIFIER_GLYPHS = "\u2303\u2325\u21e7\u2318";

/** The narrowest area the panel is given beside the sidebar. */
export const QUICK_REFERENCE_MIN_WIDTH_REM = 24;

/** The room the panel may take, in rem. */
export interface QuickReferenceArea {
  readonly widthRem: number;
  readonly heightRem: number;
}

export interface QuickReferenceView {
  /** A group too long for one column appears in each column it fills, under its heading. */
  readonly columns: ReadonlyArray<ReadonlyArray<QuickReferenceGroup>>;
  /** Entries left out because the window is too small to show them without scrolling. */
  readonly hiddenCount: number;
}

function entryCount(groups: ReadonlyArray<QuickReferenceGroup>): number {
  return groups.reduce((count, group) => count + group.entries.length, 0);
}

function lineCount(groups: ReadonlyArray<QuickReferenceGroup>): number {
  return entryCount(groups) + groups.length * (1 + GROUP_GAP_LINES);
}

function entryWidthRem(entry: QuickReferenceEntry): number {
  let keys = 0;
  for (const character of entry.keys) {
    keys += MODIFIER_GLYPHS.includes(character) ? MODIFIER_GLYPH_REM : CHARACTER_REM;
  }
  return entry.label.length * CHARACTER_REM + keys + ROW_CHROME_REM;
}

/**
 * Columns are as wide as their widest row, so the panel's width is estimated
 * from its text. A wider font than the default only costs a shortened label:
 * the panel never grows past its area.
 */
function panelWidthRem(columns: QuickReferenceView["columns"]): number {
  const widths = columns.map((column) =>
    Math.max(...column.flatMap((group) => group.entries.map(entryWidthRem))),
  );
  return (
    widths.reduce((total, width) => total + width, 0) +
    (columns.length - 1) * COLUMN_GAP_REM +
    2 * PANEL_INSET_REM
  );
}

/** Keeps what fits in `lines` lines: dimmed entries drop first, then entries from the end. */
function trimToLines(
  groups: ReadonlyArray<QuickReferenceGroup>,
  lines: number,
): ReadonlyArray<QuickReferenceGroup> {
  let room = lines;
  const kept = groups.map(() => 0);
  for (const dimmed of [false, true]) {
    for (const [index, group] of groups.entries()) {
      const wanted = group.entries.filter((entry) => entry.dimmed === dimmed).length;
      const heading = kept[index] === 0 ? 1 + GROUP_GAP_LINES : 0;
      const taken = Math.min(wanted, Math.max(0, Math.floor(room - heading)));
      if (taken === 0) continue;
      kept[index] = (kept[index] ?? 0) + taken;
      room -= heading + taken;
    }
  }
  // Dimmed entries follow the others in a group, so a prefix keeps the right ones.
  return groups.flatMap((group, index) => {
    const entries = group.entries.slice(0, kept[index]);
    return entries.length > 0 ? [{ ...group, entries }] : [];
  });
}

/**
 * Fills columns of at most `lines` lines in reading order. With `whole`, a group
 * that fits a column is never split. A split group keeps two shortcuts under
 * its heading.
 */
function fillColumns(
  groups: ReadonlyArray<QuickReferenceGroup>,
  lines: number,
  whole: boolean,
): Array<Array<QuickReferenceGroup>> {
  const columns: Array<Array<QuickReferenceGroup>> = [[]];
  let used = 0;
  for (const group of groups) {
    let entries = group.entries;
    const unsplit = whole && 1 + entries.length <= lines;
    while (entries.length > 0) {
      const column = columns.at(-1) ?? [];
      const heading = 1 + (column.length > 0 ? GROUP_GAP_LINES : 0);
      const room = Math.floor(lines - used - heading);
      if (room < (unsplit ? entries.length : Math.min(2, entries.length)) && column.length > 0) {
        columns.push([]);
        used = 0;
        continue;
      }
      const taken = Math.max(1, Math.min(entries.length, room));
      column.push({ ...group, entries: entries.slice(0, taken) });
      used += heading + taken;
      entries = entries.slice(taken);
    }
  }
  return columns;
}

/**
 * The shortest columns that hold the groups in `count` of them, with groups
 * kept whole when that fits. `maxLines` is known to do with groups split.
 */
function balanceColumns(
  groups: ReadonlyArray<QuickReferenceGroup>,
  count: number,
  maxLines: number,
): QuickReferenceView["columns"] {
  const shortest = Math.ceil(lineCount(groups) / count);
  for (const whole of [true, false]) {
    for (let lines = shortest; lines <= maxLines; lines += 1) {
      const columns = fillColumns(groups, lines, whole);
      if (columns.length <= count) return columns;
    }
  }
  return fillColumns(groups, maxLines, false);
}

function layOut(
  groups: ReadonlyArray<QuickReferenceGroup>,
  count: number,
  maxLines: number,
): QuickReferenceView {
  if (fillColumns(groups, maxLines, false).length <= count) {
    return { columns: balanceColumns(groups, count, maxLines), hiddenCount: 0 };
  }
  // The count takes a line of its own below the columns.
  const columnLines = maxLines - 1;
  for (let lines = count * columnLines; lines > 0; lines -= 1) {
    const shown = trimToLines(groups, lines);
    if (fillColumns(shown, columnLines, false).length > count) continue;
    return {
      columns: balanceColumns(shown, count, columnLines),
      hiddenCount: entryCount(groups) - entryCount(shown),
    };
  }
  return { columns: [], hiddenCount: entryCount(groups) };
}

/**
 * Lays the list out in the columns it needs and `area` has room for. Nothing
 * scrolls: when the window is too small, dimmed entries drop first, then
 * entries from the end, and the view counts what it left out.
 */
export function fitQuickReference(
  groups: ReadonlyArray<QuickReferenceGroup>,
  area: QuickReferenceArea,
): QuickReferenceView {
  const maxLines = Math.max(
    4,
    Math.floor((area.heightRem - 2 * PANEL_INSET_REM) / LINE_HEIGHT_REM),
  );
  const preferred = Math.ceil(lineCount(groups) / Math.min(PREFERRED_COLUMN_LINES, maxLines));
  for (let count = Math.min(MAX_COLUMNS, preferred); count > 1; count -= 1) {
    const view = layOut(groups, count, maxLines);
    if (panelWidthRem(view.columns) <= area.widthRem) return view;
  }
  return layOut(groups, 1, maxLines);
}
