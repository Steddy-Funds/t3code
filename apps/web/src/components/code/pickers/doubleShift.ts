import {
  type ClientSettings,
  isModifierPairShortcut,
  snapShotShortcutModifierPair,
} from "@t3tools/contracts";

import { isEditableFocused } from "~/lib/editableFocus";
import { readFocusScopes } from "~/lib/focusScopes";

const DOUBLE_SHIFT_INTERVAL_MS = 300;

export interface DoubleShiftKey {
  readonly type: "keydown" | "keyup";
  readonly key: string;
  readonly repeat: boolean;
  /** Ctrl, Alt or Meta held. */
  readonly otherModifier: boolean;
  readonly timeStamp: number;
}

type DoubleShiftState =
  | { readonly phase: "idle" }
  | { readonly phase: "down" | "tapped"; readonly firstDownAt: number };

const IDLE: DoubleShiftState = { phase: "idle" };

/**
 * Two Shift taps, the second pressed within the interval of the first, with no other key, click
 * or modifier between. Shift held through another key (Shift+click, shift-selection) never counts.
 */
export function createDoubleShiftDetector(intervalMs = DOUBLE_SHIFT_INTERVAL_MS) {
  let state = IDLE;
  return {
    /** True on the keydown that completes a double Shift. */
    key(event: DoubleShiftKey): boolean {
      if (event.key !== "Shift") {
        if (event.type === "keydown") state = IDLE;
        return false;
      }
      if (event.type === "keyup") {
        state = state.phase === "down" ? { phase: "tapped", firstDownAt: state.firstDownAt } : IDLE;
        return false;
      }
      if (event.repeat) return false;
      if (event.otherModifier) {
        state = IDLE;
        return false;
      }
      if (state.phase === "tapped" && event.timeStamp - state.firstDownAt <= intervalMs) {
        state = IDLE;
        return true;
      }
      state = { phase: "down", firstDownAt: event.timeStamp };
      return false;
    },
    reset(): void {
      state = IDLE;
    },
  };
}

/** Off by setting, and off while the desktop SnapShot trigger is both Shift keys. */
export function isDoubleShiftSearchOn(
  settings: Pick<
    ClientSettings,
    "doubleShiftSearchEnabled" | "snapShotEnabled" | "snapShotShortcut"
  >,
): boolean {
  return settings.doubleShiftSearchEnabled && !snapShotUsesShiftPair(settings);
}

export function snapShotUsesShiftPair(
  settings: Pick<ClientSettings, "snapShotEnabled" | "snapShotShortcut">,
): boolean {
  const shortcut = settings.snapShotShortcut;
  return (
    settings.snapShotEnabled &&
    isModifierPairShortcut(shortcut) &&
    snapShotShortcutModifierPair(shortcut) === "shift"
  );
}

/**
 * Listens on the window and calls `onDoubleShift` while `isOn` holds. Text fields keep their
 * Shift taps, a comment box or filter inside the code viewer too; the code editor does not.
 */
export function installDoubleShift(options: {
  readonly isOn: () => boolean;
  readonly onDoubleShift: () => void;
}): () => void {
  const detector = createDoubleShiftDetector();
  const onKey = (event: KeyboardEvent) => {
    const inTextField = isEditableFocused(event.target) && !readFocusScopes(event.target).codeFocus;
    if (event.isComposing || inTextField || !options.isOn()) {
      detector.reset();
      return;
    }
    const completed = detector.key({
      type: event.type === "keyup" ? "keyup" : "keydown",
      key: event.key,
      repeat: event.repeat,
      otherModifier: event.ctrlKey || event.altKey || event.metaKey,
      timeStamp: event.timeStamp,
    });
    if (completed) options.onDoubleShift();
  };
  const reset = () => detector.reset();
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  window.addEventListener("pointerdown", reset, true);
  window.addEventListener("blur", reset);
  return () => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    window.removeEventListener("pointerdown", reset, true);
    window.removeEventListener("blur", reset);
  };
}
