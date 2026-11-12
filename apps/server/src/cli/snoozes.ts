// @effect-diagnostics nodeBuiltinImport:off - reads the database read-only while the server may hold it.
import * as NodeSqlite from "node:sqlite";

import {
  formatSnoozeDuration,
  SNOOZE_END_LABELS,
  summarizeSnoozeLog,
  ThreadSnoozeLogEntry,
  type ThreadSnoozeLogEntry as SnoozeLogEntry,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag } from "effect/cli";

import { snoozeLogEntryFields } from "../orchestration-v2/ThreadSnoozeLog.ts";
import { DurationFromString, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const decodeEntries = Schema.decodeUnknownSync(Schema.Array(ThreadSnoozeLogEntry));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Snoozes newest first. A database without the log yet has none. */
function readSnoozeLog(
  databasePath: string,
  input: { readonly sinceIso: string; readonly threadId: string | null; readonly nowMs: number },
): ReadonlyArray<SnoozeLogEntry> {
  const db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_snooze_log'")
      .get();
    if (table === undefined) return [];
    const rows = db
      .prepare(
        `SELECT * FROM thread_snooze_log
         WHERE snoozed_at >= ? AND (? IS NULL OR thread_id = ?)
         ORDER BY snoozed_at DESC`,
      )
      .all(input.sinceIso, input.threadId, input.threadId);
    return decodeEntries(rows.map((row) => snoozeLogEntryFields(row as never, input.nowMs)));
  } finally {
    db.close();
  }
}

export const threadSnoozesCommand = Command.make("snoozes", {
  ...projectLocationFlags,
  since: Flag.String("since").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("How far back to look, such as 7d or 30d."),
    Flag.withDefault(Duration.days(30)),
  ),
  thread: Flag.String("thread").pipe(
    Flag.withDescription("Only this thread's snoozes."),
    Flag.optional,
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDescription("Print every snooze as JSON instead of the summary."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Snoozes and their reasons, grouped by reason: a retrospective of what you put off.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
        quietLogs: true,
      });
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const entries = readSnoozeLog(config.dbPath, {
        sinceIso: DateTime.formatIso(DateTime.subtractDuration(now, flags.since)),
        threadId: Option.getOrNull(flags.thread),
        nowMs,
      });
      if (flags.json) return yield* Console.log(encodeJson(entries));
      if (entries.length === 0) return yield* Console.log("No snoozes in that time.");
      for (const group of summarizeSnoozeLog(entries, nowMs)) {
        yield* Console.log(
          `${String(group.count).padStart(4)}  ${formatSnoozeDuration(group.totalSnoozedMs).padStart(8)}  ${group.label}`,
        );
      }
      yield* Console.log("");
      for (const entry of entries) {
        const why = [entry.reasonLabel, entry.reasonNote].filter(Boolean).join(": ") || "-";
        const spent = entry.snoozedMs === null ? "running" : formatSnoozeDuration(entry.snoozedMs);
        yield* Console.log(
          `${entry.snoozedAt}  ${spent.padStart(8)}  ${(entry.endKind ? SNOOZE_END_LABELS[entry.endKind] : "still snoozed").padEnd(13)}  ${why}  ${entry.threadTitle ?? entry.threadId}`,
        );
      }
    }),
  ),
);
