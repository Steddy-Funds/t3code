import {
  DEFAULT_SNOOZE_REASONS,
  MAX_SHOWN_SNOOZE_REASONS,
  MIN_SHOWN_SNOOZE_REASONS,
  type SnoozeReasonSetting,
  type ThreadSnoozePicker,
  type ThreadSnoozeReason,
} from "@t3tools/contracts";
import { create } from "zustand";

/** The first shown reasons, at most four. Fewer than two shown falls back to the defaults. */
export function promptSnoozeReasons(
  settings: ReadonlyArray<SnoozeReasonSetting>,
): ReadonlyArray<SnoozeReasonSetting> {
  const shown = settings.filter((reason) => reason.shown).slice(0, MAX_SHOWN_SNOOZE_REASONS);
  return shown.length >= MIN_SHOWN_SNOOZE_REASONS ? shown : DEFAULT_SNOOZE_REASONS;
}

/** A picked wake time: menu presets carry a label, the custom picker's choice does not. */
export interface SnoozeChoice {
  readonly snoozedUntil: string;
  readonly label?: string;
}

export function snoozeChoiceOrigin(choice: SnoozeChoice): {
  readonly picker: ThreadSnoozePicker;
  readonly presetLabel?: string;
} {
  return choice.label === undefined
    ? { picker: "custom" }
    : { picker: "preset", presetLabel: choice.label };
}

export function snoozeReasonAnswer(reason: SnoozeReasonSetting, note = ""): ThreadSnoozeReason {
  const trimmed = note.trim();
  return trimmed
    ? { id: reason.id, label: reason.label, note: trimmed }
    : { id: reason.id, label: reason.label };
}

export interface SnoozeReasonAnchor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SnoozeReasonRequest {
  readonly reasons: ReadonlyArray<SnoozeReasonSetting>;
  /** Where the snoozed thread's row was; null puts the prompt by the sidebar footer. */
  readonly anchor: SnoozeReasonAnchor | null;
}

interface OpenPrompt extends SnoozeReasonRequest {
  readonly openedAtMs: number;
  readonly answer: Promise<ThreadSnoozeReason | null>;
  readonly resolve: (reason: ThreadSnoozeReason | null) => void;
}

/** A multi-select snooze asks once: requests this soon after a prompt opened share its answer. */
export const JOIN_OPEN_PROMPT_MS = 1_500;

export const useSnoozeReasonPrompt = create<{ open: OpenPrompt | null }>(() => ({ open: null }));

/**
 * Asks why a thread was snoozed. Resolves null when the prompt is dismissed (Esc, a click
 * outside, or a newer snooze replacing it); never blocks the snooze itself.
 */
export function requestSnoozeReason(
  request: SnoozeReasonRequest,
  nowMs: number = Date.now(),
): Promise<ThreadSnoozeReason | null> {
  // TODO(glint): on macOS desktop, ask through `window.desktopBridge.glint`'s native Liquid Glass
  // "choice" dialog and keep this popover for every other client.
  // https://github.com/Steddy-Funds/t3code/tree/akiva/glint-native-dialogs
  const open = useSnoozeReasonPrompt.getState().open;
  if (open && nowMs - open.openedAtMs < JOIN_OPEN_PROMPT_MS) return open.answer;
  open?.resolve(null);
  let resolve!: (reason: ThreadSnoozeReason | null) => void;
  const answer = new Promise<ThreadSnoozeReason | null>((settle) => {
    resolve = settle;
  });
  useSnoozeReasonPrompt.setState({ open: { ...request, openedAtMs: nowMs, answer, resolve } });
  return answer;
}

export function answerSnoozeReason(reason: ThreadSnoozeReason | null): void {
  const open = useSnoozeReasonPrompt.getState().open;
  useSnoozeReasonPrompt.setState({ open: null });
  open?.resolve(reason);
}
