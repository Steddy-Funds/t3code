import { describe, expect, it } from "vite-plus/test";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  formatSnoozeDuration,
  snoozeLogEntryAsOf,
  snoozeLogToCsv,
  summarizeSnoozeLog,
  type ThreadSnoozeLogEntry,
} from "./snoozeLog.ts";

const HOUR = 3_600_000;

const entry = (overrides: Partial<ThreadSnoozeLogEntry>): ThreadSnoozeLogEntry => ({
  snoozeId: "snooze",
  threadId: ThreadId.make("thread"),
  projectId: ProjectId.make("project"),
  threadTitle: "Thread",
  snoozedAt: "2026-11-01T00:00:00.000Z",
  snoozedUntil: "2026-11-01T02:00:00.000Z",
  requestedMs: 2 * HOUR,
  picker: "preset",
  presetLabel: "2 hours",
  reasonId: null,
  reasonLabel: null,
  reasonNote: null,
  reasonRecordedAt: null,
  endedAt: "2026-11-01T02:00:00.000Z",
  endKind: "expired",
  snoozedMs: 2 * HOUR,
  ...overrides,
});

describe("summarizeSnoozeLog", () => {
  it("groups by reason, counts a running snooze up to now, and keeps the newest label", () => {
    const now = Date.parse("2026-11-01T05:00:00.000Z");
    const summary = summarizeSnoozeLog(
      [
        entry({ reasonId: "later", reasonLabel: "Focus later", snoozedMs: null, endKind: null }),
        entry({ reasonId: "later", reasonLabel: "Later", snoozedMs: HOUR }),
        entry({ reasonId: null }),
      ],
      now,
    );
    expect(summary).toEqual([
      { reasonId: "later", label: "Focus later", count: 2, totalSnoozedMs: 6 * HOUR },
      { reasonId: null, label: "No reason", count: 1, totalSnoozedMs: 2 * HOUR },
    ]);
  });
});

describe("snoozeLogEntryAsOf", () => {
  it("ends a running snooze at its wake time once that has passed", () => {
    const running = entry({ endedAt: null, endKind: null, snoozedMs: null });
    expect(snoozeLogEntryAsOf(running, Date.parse("2026-11-01T01:00:00.000Z"))).toBe(running);
    expect(snoozeLogEntryAsOf(running, Date.parse("2026-11-01T03:00:00.000Z"))).toMatchObject({
      endedAt: "2026-11-01T02:00:00.000Z",
      endKind: "expired",
      snoozedMs: 2 * HOUR,
    });
  });
});

describe("snoozeLogToCsv", () => {
  it("quotes notes with commas, quotes, and newlines, and leaves nulls empty", () => {
    const [header, row] = snoozeLogToCsv([
      entry({ reasonId: "other", reasonLabel: "Other", reasonNote: 'waiting, "design"\nreview' }),
    ]).split(/\n(?=snooze,)/);
    expect(header!.split(",").slice(9, 12)).toEqual(["reasonId", "reasonLabel", "reasonNote"]);
    expect(row).toContain(',other,Other,"waiting, ""design""\nreview",,');
  });
});

describe("formatSnoozeDuration", () => {
  it.each([
    [45 * 60_000, "45m"],
    [90 * 60_000, "1h 30m"],
    [47 * HOUR, "47h"],
    [50 * HOUR, "2d 2h"],
  ])("formats %d ms as %s", (ms, label) => {
    expect(formatSnoozeDuration(ms)).toBe(label);
  });
});
