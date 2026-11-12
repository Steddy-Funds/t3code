import {
  DEFAULT_SNOOZE_REASONS,
  MAX_SHOWN_SNOOZE_REASONS,
  MIN_SHOWN_SNOOZE_REASONS,
  SNOOZE_REASON_OTHER_ID,
  type SnoozeReasonSetting,
  type ThreadSnoozePicker,
  type ThreadSnoozeReason,
} from "@t3tools/contracts";
import { create } from "zustand";

import { isGlintAvailable, presentGlint } from "../lib/glint";

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
  /** Glint's native dialog is asking, so the popover stays hidden unless it falls back. */
  readonly native: boolean;
  /** Opens the popover straight at this reason's note step. */
  readonly noteFor?: SnoozeReasonSetting;
}

/** A multi-select snooze asks once: requests this soon after a prompt opened share its answer. */
export const JOIN_OPEN_PROMPT_MS = 1_500;

export const useSnoozeReasonPrompt = create<{ open: OpenPrompt | null }>(() => ({ open: null }));

const SNOOZE_REASON_SYMBOLS: Readonly<Record<string, string>> = {
  "not-now": "hand.raised",
  later: "clock",
  "blocked-irl": "figure.walk",
  [SNOOZE_REASON_OTHER_ID]: "ellipsis",
};
const CUSTOM_SNOOZE_REASON_SYMBOL = "tag";

/** Glint's `choice` dialog for these reasons, or null when it takes only 2–4 and this is not. */
export function glintSnoozeReasonParams(reasons: ReadonlyArray<SnoozeReasonSetting>) {
  if (reasons.length < MIN_SHOWN_SNOOZE_REASONS || reasons.length > MAX_SHOWN_SNOOZE_REASONS) {
    return null;
  }
  return {
    title: "Why snooze?",
    options: reasons.map((reason) => ({
      id: reason.id,
      label: reason.label,
      symbol: SNOOZE_REASON_SYMBOLS[reason.id] ?? CUSTOM_SNOOZE_REASON_SYMBOL,
    })),
  };
}

/**
 * Asks why a thread was snoozed: in Glint's native dialog when the helper runs and the prompt has
 * an anchor, else in the popover. Resolves null when dismissed (Esc, a click outside, or a newer
 * snooze replacing it); never blocks the snooze itself.
 */
export function requestSnoozeReason(
  request: SnoozeReasonRequest,
  nowMs: number = Date.now(),
): Promise<ThreadSnoozeReason | null> {
  const open = useSnoozeReasonPrompt.getState().open;
  if (open && nowMs - open.openedAtMs < JOIN_OPEN_PROMPT_MS) return open.answer;
  open?.resolve(null);
  let resolve!: (reason: ThreadSnoozeReason | null) => void;
  const answer = new Promise<ThreadSnoozeReason | null>((settle) => {
    resolve = settle;
  });
  const glint =
    request.anchor && isGlintAvailable() ? glintSnoozeReasonParams(request.reasons) : null;
  useSnoozeReasonPrompt.setState({
    open: { ...request, openedAtMs: nowMs, answer, resolve, native: glint !== null },
  });
  if (glint && request.anchor) void askGlint(answer, request.anchor, glint);
  return answer;
}

async function askGlint(
  answer: Promise<ThreadSnoozeReason | null>,
  anchor: SnoozeReasonAnchor,
  params: NonNullable<ReturnType<typeof glintSnoozeReasonParams>>,
): Promise<void> {
  const outcome = await presentGlint("choice", anchor, params);
  const open = useSnoozeReasonPrompt.getState().open;
  if (open?.answer !== answer) return;
  if (outcome.type === "cancelled") return answerSnoozeReason(null);
  const reason =
    outcome.type === "result"
      ? open.reasons.find((candidate) => candidate.id === outcome.value.id)
      : undefined;
  if (reason && reason.id !== SNOOZE_REASON_OTHER_ID) {
    return answerSnoozeReason(snoozeReasonAnswer(reason));
  }
  // Glint has no text field: Other's note, like any helper failure, goes to the popover.
  useSnoozeReasonPrompt.setState({
    open: { ...open, native: false, ...(reason ? { noteFor: reason } : {}) },
  });
}

export function answerSnoozeReason(reason: ThreadSnoozeReason | null): void {
  const open = useSnoozeReasonPrompt.getState().open;
  useSnoozeReasonPrompt.setState({ open: null });
  open?.resolve(reason);
}
