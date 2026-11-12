/** Cmd+Shift+Enter (Ctrl off macOS): docks the composer, and sends from the docked composer. */
export function isComposerDockChord(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
  readonly repeat?: boolean;
}): boolean {
  return (
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.isComposing !== true &&
    event.repeat !== true
  );
}

const LONG_PROMPT_LINES = 8;
const LONG_PROMPT_CHARACTERS = 600;

/** A prompt long enough that the docked editor is worth offering. */
export function isLongComposerPrompt(prompt: string): boolean {
  if (prompt.length >= LONG_PROMPT_CHARACTERS) return true;
  let lines = 1;
  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt.charCodeAt(index) === 10 && ++lines >= LONG_PROMPT_LINES) return true;
  }
  return false;
}
