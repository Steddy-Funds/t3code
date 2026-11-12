import {
  formatSnoozeDuration,
  snoozeLogEntryAsOf,
  snoozeLogToCsv,
  summarizeSnoozeLog,
  SNOOZE_END_LABELS,
} from "@t3tools/contracts";
import { AlarmClockIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { type EnvironmentSnoozeLogEntry, useSnoozeLogs } from "../../lib/snoozeLogState";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

const RANGE_DAYS = {
  "7": "Last 7 days",
  "30": "Last 30 days",
  "90": "Last 90 days",
  all: "All time",
};
type Range = keyof typeof RANGE_DAYS;
const isRange = (value: unknown): value is Range =>
  typeof value === "string" && Object.hasOwn(RANGE_DAYS, value);

const SHOWN_ENTRIES = 200;

function download(filename: string, type: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function entryDescription(entry: EnvironmentSnoozeLogEntry, nowMs: number) {
  const spent = entry.snoozedMs ?? nowMs - Date.parse(entry.snoozedAt);
  const asked = formatSnoozeDuration(entry.requestedMs);
  return (
    <>
      <RelativeTime timestamp={entry.snoozedAt} />
      {` · ${formatSnoozeDuration(spent)} of ${asked}`}
      {entry.endKind ? ` · ${SNOOZE_END_LABELS[entry.endKind]}` : " · still snoozed"}
      {entry.presetLabel ? ` · ${entry.presetLabel}` : null}
    </>
  );
}

export function SnoozeHistoryPanel() {
  const { scope } = useSettingsScope();
  const { entries: allEntries, error, isLoading } = useSnoozeLogs(scope.environmentIds);
  const [range, setRange] = useState<Range>("30");
  const nowMs = Date.parse(`${useNowMinute()}Z`);
  const selectedProjectKeys =
    scope.kind === "project" || scope.kind === "checkout"
      ? new Set(scope.members.map((member) => `${member.environmentId}:${member.id}`))
      : null;
  const sinceMs = range === "all" ? null : nowMs - Number(range) * 24 * 60 * 60 * 1000;
  const entries = allEntries
    .filter(
      (entry) =>
        (sinceMs === null || Date.parse(entry.snoozedAt) >= sinceMs) &&
        (selectedProjectKeys === null ||
          selectedProjectKeys.has(`${entry.environmentId}:${entry.projectId}`)),
    )
    .map((entry) => ({ ...entry, ...snoozeLogEntryAsOf(entry, nowMs) }));
  const summary = summarizeSnoozeLog(entries, nowMs);
  const { id, title } = searchableSetting("snooze-history");
  const filename = `snoozes-${range === "all" ? "all" : `${range}d`}`;

  return (
    <SettingsPageContainer>
      <SettingsSection
        id={isLoading ? undefined : id}
        title={title}
        headerAction={
          <div className="flex items-center gap-2">
            <Select
              value={range}
              items={RANGE_DAYS}
              onValueChange={(value) => {
                if (isRange(value)) setRange(value);
              }}
            >
              <SelectTrigger size="sm" className="w-36" aria-label="Time range">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {Object.entries(RANGE_DAYS).map(([value, label]) => (
                  <SelectItem hideIndicator key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={entries.length === 0}
              onClick={() => download(`${filename}.csv`, "text/csv", snoozeLogToCsv(entries))}
            >
              CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={entries.length === 0}
              onClick={() =>
                download(
                  `${filename}.json`,
                  "application/json",
                  `${JSON.stringify({ summary, entries }, null, 2)}\n`,
                )
              }
            >
              JSON
            </Button>
          </div>
        }
      >
        {summary.length === 0 ? (
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoading ? (
                  <Spinner size="sm" tone="muted" />
                ) : (
                  <AlarmClockIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoading ? "Loading snoozes" : error ? "Could not load snoozes" : "No snoozes"}
              </span>
            }
            description={
              isLoading
                ? "Checking connected environments."
                : (error ?? "Snoozes from now on show here, with the reason you gave.")
            }
          />
        ) : (
          summary.map((group) => (
            <SettingsRow
              key={group.reasonId ?? ""}
              title={group.label}
              description={`${group.count} ${group.count === 1 ? "snooze" : "snoozes"} · ${formatSnoozeDuration(group.totalSnoozedMs)} snoozed`}
            />
          ))
        )}
      </SettingsSection>
      {entries.length > 0 ? (
        <SettingsSection title="Snoozes">
          {entries.slice(0, SHOWN_ENTRIES).map((entry) => (
            <SettingsRow
              key={`${entry.environmentId}:${entry.snoozeId}`}
              title={entry.threadTitle ?? "Untitled thread"}
              description={entryDescription(entry, nowMs)}
              status={
                entry.reasonLabel
                  ? [entry.reasonLabel, entry.reasonNote].filter(Boolean).join(": ")
                  : null
              }
            />
          ))}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
