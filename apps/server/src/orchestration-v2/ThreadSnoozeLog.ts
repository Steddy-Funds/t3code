import {
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type ThreadSnoozeEndKind,
  ThreadSnoozeLogEntry,
  ThreadSnoozeLogError,
  type ThreadSnoozeLogListInput,
  type ThreadSnoozeLogRecordInput,
  type ThreadSnoozePicker,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// Fork-only table: a numbered migration would collide with main's next migration id.
export const ensureThreadSnoozeLogTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_snooze_log (
      snooze_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_title TEXT,
      snoozed_at TEXT NOT NULL,
      snoozed_until TEXT NOT NULL,
      picker TEXT,
      preset_label TEXT,
      reason_id TEXT,
      reason_label TEXT,
      reason_note TEXT,
      reason_recorded_at TEXT,
      ended_at TEXT,
      end_kind TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS thread_snooze_log_thread_idx
    ON thread_snooze_log(thread_id, snoozed_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS thread_snooze_log_snoozed_at_idx
    ON thread_snooze_log(snoozed_at)
  `;
});

export interface OpenSnooze {
  readonly snoozeId: string;
  readonly snoozedUntil: string;
}

export type SnoozeLogWrite =
  | {
      readonly type: "close";
      readonly snoozeId: string;
      readonly endedAt: string;
      readonly endKind: ThreadSnoozeEndKind;
    }
  | {
      readonly type: "open";
      readonly snoozeId: string;
      readonly threadId: string;
      readonly projectId: string;
      readonly threadTitle: string | null;
      readonly snoozedAt: string;
      readonly snoozedUntil: string;
      readonly picker: ThreadSnoozePicker | null;
    };

type ThreadPayloadEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly payload: OrchestrationV2AppThread }
>;

// Every event that can start or end a snooze; the rest never touch snoozedUntil.
const SNOOZE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.settled",
  "thread.pinned",
  "thread.marked-unread",
  "thread.metadata-updated",
]);

const isSnoozeLogEvent = (event: OrchestrationV2DomainEvent): event is ThreadPayloadEvent =>
  SNOOZE_EVENT_TYPES.has(event.type);

const iso = (value: DateTime.DateTime) => DateTime.formatIso(DateTime.toUtc(value));

/** What one committed thread event does to the thread's snooze log, given its open snooze. */
function snoozeLogWrites(
  event: ThreadPayloadEvent,
  snoozeId: string,
  open: OpenSnooze | null,
): ReadonlyArray<SnoozeLogWrite> {
  const thread = event.payload;
  const occurredAt = iso(event.occurredAt);
  const until = thread.snoozedUntil == null ? null : iso(thread.snoozedUntil);
  // A limit-recovery update re-stamps snoozedAt for the same reset; only a new wake time is a new snooze.
  const starts =
    until !== null &&
    (open === null || event.type === "thread.snoozed" || open.snoozedUntil !== until);
  const ends = open !== null && (until === null || starts);
  const writes: Array<SnoozeLogWrite> = [];
  if (ends) {
    const expired = Date.parse(open.snoozedUntil) <= Date.parse(occurredAt);
    writes.push({
      type: "close",
      snoozeId: open.snoozeId,
      endedAt: expired ? open.snoozedUntil : occurredAt,
      endKind: expired
        ? "expired"
        : starts
          ? "resnoozed"
          : event.type === "thread.settled"
            ? "settled"
            : event.type === "thread.pinned"
              ? "pinned"
              : "unsnoozed",
    });
  }
  if (starts) {
    writes.push({
      type: "open",
      snoozeId,
      threadId: thread.id,
      projectId: thread.projectId,
      threadTitle: thread.title ?? null,
      snoozedAt: thread.snoozedAt == null ? occurredAt : iso(thread.snoozedAt),
      snoozedUntil: until,
      picker: event.type === "thread.metadata-updated" ? "limit-reset" : null,
    });
  }
  return writes;
}

/** Runs inside the event sink's transaction, so the log commits with the events. */
export const recordThreadSnoozeTransitions = Effect.fnUntraced(function* (
  storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const stored of storedEvents) {
    const event = stored.event;
    if (!isSnoozeLogEvent(event)) continue;
    const rows = yield* sql<{ readonly snooze_id: string; readonly snoozed_until: string }>`
      SELECT snooze_id, snoozed_until
      FROM thread_snooze_log
      WHERE thread_id = ${event.threadId} AND ended_at IS NULL
      ORDER BY snoozed_at DESC
      LIMIT 1
    `;
    const row = rows[0];
    const open = row ? { snoozeId: row.snooze_id, snoozedUntil: row.snoozed_until } : null;
    for (const write of snoozeLogWrites(event, stored.commandId ?? event.id, open)) {
      if (write.type === "close") {
        yield* sql`
          UPDATE thread_snooze_log
          SET ended_at = ${write.endedAt}, end_kind = ${write.endKind}
          WHERE snooze_id = ${write.snoozeId}
        `;
      } else {
        yield* sql`
          INSERT OR IGNORE INTO thread_snooze_log (
            snooze_id, thread_id, project_id, thread_title, snoozed_at, snoozed_until, picker
          )
          VALUES (
            ${write.snoozeId}, ${write.threadId}, ${write.projectId}, ${write.threadTitle},
            ${write.snoozedAt}, ${write.snoozedUntil}, ${write.picker}
          )
        `;
      }
    }
  }
});

interface SnoozeLogRow {
  readonly snooze_id: string;
  readonly thread_id: string;
  readonly project_id: string;
  readonly thread_title: string | null;
  readonly snoozed_at: string;
  readonly snoozed_until: string;
  readonly picker: string | null;
  readonly preset_label: string | null;
  readonly reason_id: string | null;
  readonly reason_label: string | null;
  readonly reason_note: string | null;
  readonly reason_recorded_at: string | null;
  readonly ended_at: string | null;
  readonly end_kind: string | null;
}

/** A snooze still open past its wake time reads as expired then; nothing marks that moment. */
export function snoozeLogEntryFields(row: SnoozeLogRow, nowMs: number) {
  const snoozedAtMs = Date.parse(row.snoozed_at);
  const untilMs = Date.parse(row.snoozed_until);
  const lapsed = row.ended_at === null && untilMs <= nowMs;
  const endedAt = lapsed ? row.snoozed_until : row.ended_at;
  return {
    snoozeId: row.snooze_id,
    threadId: row.thread_id,
    projectId: row.project_id,
    threadTitle: row.thread_title,
    snoozedAt: row.snoozed_at,
    snoozedUntil: row.snoozed_until,
    requestedMs: Math.max(0, untilMs - snoozedAtMs),
    picker: row.picker,
    presetLabel: row.preset_label,
    reasonId: row.reason_id,
    reasonLabel: row.reason_label,
    reasonNote: row.reason_note,
    reasonRecordedAt: row.reason_recorded_at,
    endedAt,
    endKind: lapsed ? "expired" : row.end_kind,
    snoozedMs: endedAt === null ? null : Math.max(0, Date.parse(endedAt) - snoozedAtMs),
  };
}

const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(ThreadSnoozeLogEntry));
const DEFAULT_LIST_LIMIT = 1_000;

const logError = (message: string) => (cause: unknown) =>
  new ThreadSnoozeLogError({ message, cause });

export class ThreadSnoozeLog extends Context.Service<
  ThreadSnoozeLog,
  {
    readonly list: (
      input: ThreadSnoozeLogListInput,
    ) => Effect.Effect<ReadonlyArray<ThreadSnoozeLogEntry>, ThreadSnoozeLogError>;
    readonly record: (
      input: ThreadSnoozeLogRecordInput,
    ) => Effect.Effect<void, ThreadSnoozeLogError>;
  }
>()("t3/orchestration-v2/ThreadSnoozeLog") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureThreadSnoozeLogTable.pipe(Effect.orDie);

  const list = Effect.fn("ThreadSnoozeLog.list")(function* (input: ThreadSnoozeLogListInput) {
    const rows = yield* sql<SnoozeLogRow>`
      SELECT *
      FROM thread_snooze_log
      WHERE ${sql.and([
        ...(input.threadId === undefined ? [] : [sql`thread_id = ${input.threadId}`]),
        ...(input.since === undefined ? [] : [sql`snoozed_at >= ${input.since}`]),
        sql`1 = 1`,
      ])}
      ORDER BY snoozed_at DESC
      LIMIT ${input.limit ?? DEFAULT_LIST_LIMIT}
    `.pipe(Effect.mapError(logError("Failed to read the snooze log.")));
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    return yield* decodeEntries(rows.map((row) => snoozeLogEntryFields(row, nowMs))).pipe(
      Effect.mapError(logError("The snooze log has an unreadable entry.")),
    );
  });

  const record = Effect.fn("ThreadSnoozeLog.record")(function* (input: ThreadSnoozeLogRecordInput) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const reason = input.reason;
    const updated = yield* sql<{ readonly snooze_id: string }>`
      UPDATE thread_snooze_log
      SET
        picker = COALESCE(${input.picker ?? null}, picker),
        preset_label = COALESCE(${input.presetLabel ?? null}, preset_label),
        reason_id = ${reason === undefined ? sql`reason_id` : (reason?.id ?? null)},
        reason_label = ${reason === undefined ? sql`reason_label` : (reason?.label ?? null)},
        reason_note = ${reason === undefined ? sql`reason_note` : reason?.note?.trim() || null},
        reason_recorded_at = ${reason === undefined ? sql`reason_recorded_at` : now}
      WHERE snooze_id = ${input.snoozeId} AND thread_id = ${input.threadId}
      RETURNING snooze_id
    `.pipe(Effect.mapError(logError("Failed to record the snooze.")));
    if (updated.length === 0) {
      return yield* new ThreadSnoozeLogError({
        message: `No snooze ${input.snoozeId} on thread ${input.threadId}.`,
      });
    }
  });

  return ThreadSnoozeLog.of({ list, record });
});

export const layer = Layer.effect(ThreadSnoozeLog, make);
