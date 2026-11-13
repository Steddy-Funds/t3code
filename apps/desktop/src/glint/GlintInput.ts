import type { GlintInputMessage } from "./GlintHelper.ts";

/** The parts of Electron's `before-input-event` input the lock reads. */
export interface GlintKeyInput {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly isAutoRepeat: boolean;
}

const NAMED_KEYS: { readonly [key: string]: string } = {
  Enter: "return",
  Escape: "escape",
  Tab: "tab",
  " ": "space",
  Backspace: "backspace",
  Delete: "delete",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  PageUp: "pageUp",
  PageDown: "pageDown",
  Home: "home",
  End: "end",
};

// A held key repeats; repeating these would accept, close or toggle the dialog again.
const NO_REPEAT: ReadonlySet<string> = new Set(["return", "escape", "tab", "space"]);

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * App shortcuts that still reach T3 while a dialog holds the keyboard, so a stuck dialog can be
 * escaped: quit (Cmd+Q), close the window or tab (Cmd+W) and the dev tools (Option+Cmd+I).
 * Ctrl stands in for Cmd off macOS.
 */
function isGlintPassThroughKey(input: GlintKeyInput, platform: NodeJS.Platform): boolean {
  const command = platform === "darwin" ? input.meta : input.control;
  if (!command) return false;
  const key = input.key.toLowerCase();
  if ((key === "q" || key === "w") && !input.alt && !input.shift) return true;
  return input.code === "KeyI" && (platform === "darwin" ? input.alt : input.shift);
}

/** The `key` message for a keyDown, or null for keys the protocol has no name for. */
export function glintKeyMessage(id: string, input: GlintKeyInput): GlintInputMessage | null {
  const named = NAMED_KEYS[input.key];
  let key: string;
  let text: string | undefined;
  if (named) {
    key = named;
  } else {
    const segments = [...graphemes.segment(input.key)];
    // Named keys such as Shift, F5 or Dead are words, not one grapheme.
    if (segments.length !== 1 || /\p{Cc}/u.test(input.key)) return null;
    key = "char";
    text = input.key;
  }
  if (input.isAutoRepeat && NO_REPEAT.has(key)) return null;
  const modifiers = [
    ...(input.shift ? ["shift"] : []),
    ...(input.alt ? ["option"] : []),
    ...(input.meta ? ["command"] : []),
    ...(input.control ? ["control"] : []),
  ];
  return {
    type: "key",
    id,
    key,
    ...(text === undefined ? {} : { text }),
    ...(modifiers.length > 0 ? { modifiers } : {}),
  };
}

/**
 * One window's keyboard while a Glint dialog is up: every key event is kept from the page, and
 * keyDowns go to the helper. A key pressed while the dialog was up keeps its keyUp from the page
 * after it closes, so a Space that accepted the dial cannot click the button focus returns to.
 */
export function makeGlintKeyLock(platform: NodeJS.Platform) {
  let openId: string | null = null;
  const held = new Set<string>();
  return {
    get openId() {
      return openId;
    },
    open: (id: string) => {
      openId = id;
    },
    close: (id: string) => {
      if (openId === id) openId = null;
    },
    /** Whether to `preventDefault`, and what to send the helper. */
    handle: (input: GlintKeyInput): { prevent: boolean; forward: GlintInputMessage | null } => {
      const down = input.type === "keyDown";
      if (!down && held.delete(input.code)) return { prevent: true, forward: null };
      if (openId === null || isGlintPassThroughKey(input, platform)) {
        return { prevent: false, forward: null };
      }
      if (!down) return { prevent: true, forward: null };
      held.add(input.code);
      return { prevent: true, forward: glintKeyMessage(openId, input) };
    },
  };
}
