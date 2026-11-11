export type SbsKeyAction = "nextChange" | "previousChange" | "jumpToSource";

interface KeyChord {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
}

/**
 * JetBrains' keys for this view: F7 and Shift+F7 step between differences, F4 and
 * Cmd/Ctrl+Down open the file. The one place they are read, so the keymap's `diff.nextChange`,
 * `diff.previousChange` and `diff.jumpToSource` commands can take its place.
 */
export function sbsKeyAction(event: KeyChord): SbsKeyAction | null {
  if (event.altKey) return null;
  const mod = event.metaKey || event.ctrlKey;
  if (event.key === "F7" && !mod) return event.shiftKey ? "previousChange" : "nextChange";
  if (event.shiftKey) return null;
  if (event.key === "F4" && !mod) return "jumpToSource";
  return event.key === "ArrowDown" && mod ? "jumpToSource" : null;
}
