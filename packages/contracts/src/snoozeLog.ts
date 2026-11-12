import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** How the wake time was chosen. Null for snoozes from clients that do not say (mobile, agents). */
export const ThreadSnoozePicker = Schema.Literals(["preset", "custom", "limit-reset"]);
export type ThreadSnoozePicker = typeof ThreadSnoozePicker.Type;

/** `expired` is also read for a snooze still open past its wake time; nothing marks the moment. */
export const ThreadSnoozeEndKind = Schema.Literals([
  "unsnoozed",
  "expired",
  "resnoozed",
  "settled",
  "pinned",
]);
export type ThreadSnoozeEndKind = typeof ThreadSnoozeEndKind.Type;

export const MAX_SNOOZE_REASON_NOTE_LENGTH = 500;
export const MAX_SNOOZE_REASONS = 8;
export const MIN_SHOWN_SNOOZE_REASONS = 2;
export const MAX_SHOWN_SNOOZE_REASONS = 4;

/** A reason the snooze prompt offers. Ids are stored with each snooze, so never reuse one. */
export const SnoozeReasonSetting = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  shown: Schema.Boolean,
});
export type SnoozeReasonSetting = typeof SnoozeReasonSetting.Type;
export const SnoozeReasonSettings = Schema.Array(SnoozeReasonSetting).check(
  Schema.isMaxLength(MAX_SNOOZE_REASONS),
);
export const SNOOZE_REASON_OTHER_ID = "other";
export const DEFAULT_SNOOZE_REASONS: ReadonlyArray<SnoozeReasonSetting> = [
  { id: "not-now", label: "Not now", shown: true },
  { id: "later", label: "Later", shown: true },
  { id: "blocked-irl", label: "Blocked IRL", shown: true },
  { id: SNOOZE_REASON_OTHER_ID, label: "Other", shown: true },
];

export const ThreadSnoozeReason = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_SNOOZE_REASON_NOTE_LENGTH))),
});
export type ThreadSnoozeReason = typeof ThreadSnoozeReason.Type;

export const ThreadSnoozeLogEntry = Schema.Struct({
  /** The command that started the snooze, so a client knows it before the server answers. */
  snoozeId: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: ProjectId,
  threadTitle: Schema.NullOr(Schema.String),
  snoozedAt: IsoDateTime,
  snoozedUntil: IsoDateTime,
  requestedMs: NonNegativeInt,
  picker: Schema.NullOr(ThreadSnoozePicker),
  presetLabel: Schema.NullOr(Schema.String),
  reasonId: Schema.NullOr(Schema.String),
  reasonLabel: Schema.NullOr(Schema.String),
  reasonNote: Schema.NullOr(Schema.String),
  /** Set once the prompt answered; a null reason with this set means the prompt was skipped. */
  reasonRecordedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  endKind: Schema.NullOr(ThreadSnoozeEndKind),
  /** Time actually spent snoozed; null while the snooze runs. */
  snoozedMs: Schema.NullOr(NonNegativeInt),
});
export type ThreadSnoozeLogEntry = typeof ThreadSnoozeLogEntry.Type;

export const MAX_SNOOZE_LOG_ENTRIES = 5_000;

export const ThreadSnoozeLogListInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  /** Snoozes started at or after this time. */
  since: Schema.optional(IsoDateTime),
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_SNOOZE_LOG_ENTRIES })),
  ),
});
export type ThreadSnoozeLogListInput = typeof ThreadSnoozeLogListInput.Type;

export const ThreadSnoozeLogListResult = Schema.Struct({
  entries: Schema.Array(ThreadSnoozeLogEntry),
});
export type ThreadSnoozeLogListResult = typeof ThreadSnoozeLogListResult.Type;

export const ThreadSnoozeLogRecordInput = Schema.Struct({
  threadId: ThreadId,
  snoozeId: TrimmedNonEmptyString,
  picker: Schema.optional(ThreadSnoozePicker),
  presetLabel: Schema.optional(Schema.String),
  /** Omit when no prompt was shown; null records a skipped prompt. */
  reason: Schema.optional(Schema.NullOr(ThreadSnoozeReason)),
});
export type ThreadSnoozeLogRecordInput = typeof ThreadSnoozeLogRecordInput.Type;

export class ThreadSnoozeLogError extends Schema.TaggedError<ThreadSnoozeLogError>()(
  "ThreadSnoozeLogError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface SnoozeReasonSummary {
  /** Null for snoozes with no reason: the prompt was skipped, off, or not shown on that client. */
  readonly reasonId: string | null;
  readonly label: string;
  readonly count: number;
  readonly totalSnoozedMs: number;
}

/** Groups by reason id, most used first; a running snooze counts the time so far. */
/** An entry read while running reads as expired once its wake time passes, as the server reports it. */
export function snoozeLogEntryAsOf(
  entry: ThreadSnoozeLogEntry,
  nowMs: number,
): ThreadSnoozeLogEntry {
  if (entry.endKind !== null || Date.parse(entry.snoozedUntil) > nowMs) return entry;
  return {
    ...entry,
    endedAt: entry.snoozedUntil,
    endKind: "expired",
    snoozedMs: entry.requestedMs,
  };
}

export function summarizeSnoozeLog(
  entries: ReadonlyArray<ThreadSnoozeLogEntry>,
  nowMs: number,
): ReadonlyArray<SnoozeReasonSummary> {
  const groups = new Map<string | null, { label: string; count: number; totalSnoozedMs: number }>();
  for (const entry of entries) {
    const spent = entry.snoozedMs ?? Math.max(0, nowMs - Date.parse(entry.snoozedAt));
    const group = groups.get(entry.reasonId);
    if (group) {
      group.count += 1;
      group.totalSnoozedMs += spent;
    } else {
      groups.set(entry.reasonId, {
        // Entries come newest first, so a renamed reason shows its latest label.
        label: entry.reasonLabel ?? "No reason",
        count: 1,
        totalSnoozedMs: spent,
      });
    }
  }
  return [...groups]
    .map(([reasonId, group]) => ({ reasonId, ...group }))
    .sort((left, right) => right.count - left.count || right.totalSnoozedMs - left.totalSnoozedMs);
}

export const SNOOZE_END_LABELS: Readonly<Record<ThreadSnoozeEndKind, string>> = {
  unsnoozed: "woken early",
  expired: "woke on time",
  resnoozed: "snoozed again",
  settled: "settled",
  pinned: "pinned",
};

/** Minutes under an hour, hours and minutes under two days, then days and hours. */
export function formatSnoozeDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const [big, bigUnit, small, smallUnit] =
    hours < 48 ? [hours, "h", minutes % 60, "m"] : [Math.floor(hours / 24), "d", hours % 24, "h"];
  return small === 0 ? `${big}${bigUnit}` : `${big}${bigUnit} ${small}${smallUnit}`;
}

const CSV_COLUMNS = [
  "snoozeId",
  "threadId",
  "projectId",
  "threadTitle",
  "snoozedAt",
  "snoozedUntil",
  "requestedMs",
  "picker",
  "presetLabel",
  "reasonId",
  "reasonLabel",
  "reasonNote",
  "reasonRecordedAt",
  "endedAt",
  "endKind",
  "snoozedMs",
] as const satisfies ReadonlyArray<keyof ThreadSnoozeLogEntry>;

const csvCell = (value: string | number | null) => {
  if (value === null) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function snoozeLogToCsv(entries: ReadonlyArray<ThreadSnoozeLogEntry>): string {
  return [
    CSV_COLUMNS.join(","),
    ...entries.map((entry) => CSV_COLUMNS.map((column) => csvCell(entry[column])).join(",")),
  ].join("\n");
}
