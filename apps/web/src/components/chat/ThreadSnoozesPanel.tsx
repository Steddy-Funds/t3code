import {
  type EnvironmentId,
  formatSnoozeDuration,
  snoozeLogEntryAsOf,
  type ThreadId,
  SNOOZE_END_LABELS,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlarmClockIcon, HistoryIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { orchestrationEnvironment } from "../../state/orchestration";
import { RelativeTime } from "../RelativeTime";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

/** When, how long, and why this thread was snoozed. Hidden until it has been. */
export function ThreadSnoozesPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const nowMs = Date.parse(`${useNowMinute()}Z`);
  // A server without the snooze log fails this read; the section then stays hidden.
  const { data, refresh } = useEnvironmentQuery(
    orchestrationEnvironment.snoozeLog({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const snoozedUntil =
    useThreadShell({ environmentId: props.environmentId, threadId: props.threadId })
      ?.snoozedUntil ?? null;
  const readUnder = useRef(snoozedUntil);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the log lives on the server; reread it when this thread's snooze starts or ends, from any client.
  useEffect(() => {
    if (readUnder.current === snoozedUntil) return;
    readUnder.current = snoozedUntil;
    refresh();
  }, [refresh, snoozedUntil]);
  const entries = (data?.entries ?? []).map((entry) => snoozeLogEntryAsOf(entry, nowMs));
  if (entries.length === 0) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-snoozes-heading"
      title="Snoozes"
      actions={
        <Tooltip>
          <TooltipTrigger
            render={
              <ThreadDetailsControl
                size="icon-xs"
                variant="ghost"
                part="icon"
                aria-label="Snooze history"
                onClick={() => void navigate({ to: "/settings/snoozes" })}
              >
                <HistoryIcon className="size-3.5" />
              </ThreadDetailsControl>
            }
          />
          <TooltipPopup>Snooze history</TooltipPopup>
        </Tooltip>
      }
    >
      <ul className="m-0 max-h-[13.5rem] list-none overflow-y-auto p-0">
        {entries.map((entry) => {
          const spent = entry.snoozedMs ?? nowMs - Date.parse(entry.snoozedAt);
          return (
            <li
              key={entry.snoozeId}
              className={cn(
                "flex items-center rounded-lg py-1.5",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
              )}
            >
              <AlarmClockIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground/80">
                  {entry.reasonLabel ?? "No reason"}
                  {entry.reasonNote ? (
                    <span className="font-normal text-muted-foreground">
                      {` · ${entry.reasonNote}`}
                    </span>
                  ) : null}
                </span>
                <p className="truncate text-2xs text-muted-foreground">
                  <RelativeTime timestamp={entry.snoozedAt} />
                  {` · ${formatSnoozeDuration(spent)} of ${formatSnoozeDuration(entry.requestedMs)}`}
                  {entry.endKind ? ` · ${SNOOZE_END_LABELS[entry.endKind]}` : " · still snoozed"}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </ThreadDetailsSection>
  );
}
