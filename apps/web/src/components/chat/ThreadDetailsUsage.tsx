import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageWindow,
  ThreadId,
  ThreadUsageScope,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import { formatCount, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import {
  collectProviderUsageLimits,
  formatDuration,
  type LimitPace,
  limitsNotice,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { useEffect, type ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel, formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

export interface ThreadDetailsUsageInput {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
}

type UsageTone = "error" | "warning" | null;

/** The selected provider's limit windows. Each row reads as room left. */
export function ThreadDetailsUsage({
  providerInstanceId,
  providers,
  sources,
}: Omit<ThreadDetailsUsageInput, "contextWindow">) {
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const report =
    providerInstanceId !== null
      ? collectProviderUsageLimits(providerInstanceId, providers, sources, now)
      : null;
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  const limits =
    report?.accounts.find((entry) => entry.instanceId === providerInstanceId)?.limits ??
    providers.find((provider) => provider.instanceId === providerInstanceId)?.usageLimits;
  if (!limits) return null;
  const notice = limitsNotice(limits);

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title="Usage limits"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {notice ? (
          <UsageRow
            label="Limits"
            fill={null}
            tone={null}
            value="Unavailable"
            tooltip={<span className="text-foreground">{notice}</span>}
          />
        ) : (
          limits.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />)
        )}
      </div>
    </ThreadDetailsSection>
  );
}

/** The thread's context window. The bar fills as context is used; the tick marks auto-compaction. */
export function ThreadDetailsContext({ usage }: { readonly usage: ContextWindowSnapshot }) {
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used =
    maxTokens !== null && usage.usedPercentage !== null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const threshold = usage.autoCompactThreshold ?? null;
  const tick =
    maxTokens !== null && threshold !== null && threshold > 0 && threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title="Context window"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label="Context"
          fill={used}
          tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
          tick={tick}
          muted
          value={
            maxTokens !== null
              ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}`
              : usedTokens
          }
          ariaValue={used !== null ? `${used}% used` : `${usedTokens} tokens used`}
          tooltip={
            <>
              <span className="text-foreground">
                {used !== null ? `Context: ${used}% used` : `Context: ${usedTokens} tokens used`}
              </span>
              {maxTokens !== null ? (
                <span className="text-muted-foreground">
                  {usage.usedTokens.toLocaleString("en-US")} of {maxTokens.toLocaleString("en-US")}{" "}
                  tokens
                </span>
              ) : null}
              {threshold !== null && threshold > 0 ? (
                <span className="text-muted-foreground">
                  {formatContextWindowCompactionMessage(null, threshold)}
                </span>
              ) : null}
            </>
          }
        />
      </div>
    </ThreadDetailsSection>
  );
}

/** List-price cost, tokens, and activity for the thread and, when it has relatives, its lineage. */
export function ThreadDetailsCost({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.threadUsage({ environmentId, input: { threadId } }),
  );
  const completedAt = useQuietThreadShell({ environmentId, threadId })?.latestRun?.completedAt;
  const { refresh } = query;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetch server totals when a run settles
  useEffect(() => {
    if (completedAt) refresh();
  }, [completedAt, refresh]);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const usage = query.data;
  if (!usage || usage.thread.providerTurns === 0) return null;
  const pricingKnown = usage.pricing.status !== "unavailable";
  const showLineage = usage.lineage.threads > 1;

  return (
    <ThreadDetailsSection
      headingId="thread-details-cost-heading"
      title="Cost and activity"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <CostRow label="Thread cost" scope={usage.thread} pricingKnown={pricingKnown} />
        {showLineage ? (
          <CostRow
            label={`Lineage · ${usage.lineage.threads}`}
            scope={usage.lineage}
            pricingKnown={pricingKnown}
          />
        ) : null}
        <UsageRow
          label="Tokens"
          fill={null}
          tone={null}
          value={`${formatTokens(inputTokens(usage.thread))} in · ${formatTokens(usage.thread.totals.outputTokens)} out`}
          tooltip={<TokenBreakdown scope={usage.thread} title="This thread" />}
        />
        <UsageRow
          label="Activity"
          fill={null}
          tone={null}
          value={`${formatCount(usage.thread.providerTurns)} turns · ${formatActive(usage.thread.activeMs)}`}
          tooltip={
            <>
              <ActivityLines scope={usage.thread} now={now} title="This thread" />
              {showLineage ? (
                <ActivityLines scope={usage.lineage} now={now} title="Lineage" />
              ) : null}
            </>
          }
        />
      </div>
    </ThreadDetailsSection>
  );
}

const inputTokens = (scope: ThreadUsageScope) =>
  scope.totals.uncachedInputTokens +
  scope.totals.cachedInputTokens +
  scope.totals.cacheCreationTokens;

function formatActive(ms: number) {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s active` : `${formatDuration(ms)} active`;
}

function CostRow({
  label,
  scope,
  pricingKnown,
}: {
  readonly label: string;
  readonly scope: ThreadUsageScope;
  readonly pricingKnown: boolean;
}) {
  const measured = scope.providerTurns - scope.unmeasuredTurns;
  const priced = pricingKnown && measured > scope.unpricedTurns;
  return (
    <UsageRow
      label={label}
      fill={null}
      tone={null}
      value={priced ? `~${formatUsd(scope.costUsd)}` : "Unpriced"}
      ariaValue={priced ? `about ${formatUsd(scope.costUsd)}` : "no price available"}
      tooltip={
        <>
          <span className="text-foreground">
            {priced ? `About ${formatUsd(scope.costUsd)} at API list prices` : "No price available"}
          </span>
          {scope.threads > 1 ? (
            <span className="text-muted-foreground">
              {formatCount(scope.threads)} threads: forks, side chats, and delegated tasks
            </span>
          ) : null}
          {scope.models.map((model) => (
            <span key={model.model} className="text-muted-foreground tabular-nums">
              {model.model}: {model.costUsd === null ? "unpriced" : formatUsd(model.costUsd)}
            </span>
          ))}
          {scope.unpricedTurns > 0 ? (
            <span className="text-muted-foreground">
              {formatCount(scope.unpricedTurns)} turns from unpriced models are not counted
            </span>
          ) : null}
          {scope.unmeasuredTurns > 0 ? (
            <span className="text-muted-foreground">
              {formatCount(scope.unmeasuredTurns)} turns reported no token counts
            </span>
          ) : null}
          <span className="text-muted-foreground">
            Subscriptions bill differently; this is what the tokens would cost on the API.
          </span>
        </>
      }
    />
  );
}

function TokenBreakdown({
  scope,
  title,
}: {
  readonly scope: ThreadUsageScope;
  readonly title: string;
}) {
  const { totals } = scope;
  return (
    <>
      <span className="text-foreground">
        {title}: {formatTokens(inputTokens(scope) + totals.outputTokens)} tokens
      </span>
      <span className="text-muted-foreground tabular-nums">
        Input {formatCount(totals.uncachedInputTokens)}
      </span>
      <span className="text-muted-foreground tabular-nums">
        Cache read {formatCount(totals.cachedInputTokens)}
      </span>
      <span className="text-muted-foreground tabular-nums">
        Cache write {formatCount(totals.cacheCreationTokens)}
      </span>
      <span className="text-muted-foreground tabular-nums">
        Output {formatCount(totals.outputTokens)}
        {totals.reasoningTokens > 0 ? ` (${formatCount(totals.reasoningTokens)} reasoning)` : ""}
      </span>
    </>
  );
}

function ActivityLines({
  scope,
  now,
  title,
}: {
  readonly scope: ThreadUsageScope;
  readonly now: number;
  readonly title: string;
}) {
  return (
    <>
      <span className="text-foreground">
        {title}: {formatCount(scope.providerTurns)} turns, {formatCount(scope.toolCalls)} tool calls
      </span>
      <span className="text-muted-foreground">{formatActive(scope.activeMs)} in total</span>
      {scope.firstActivityAt ? (
        <span className="text-muted-foreground">
          First turn {formatRelativeTimeLabel(scope.firstActivityAt, now)}
          {scope.lastActivityAt
            ? `, last ${formatRelativeTimeLabel(scope.lastActivityAt, now)}`
            : ""}
        </span>
      ) : null}
    </>
  );
}

function LimitRow({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return (
    <UsageRow
      label={window.label}
      fill={left}
      tone={left <= 10 ? "error" : left <= 20 ? "warning" : null}
      value={`${left}%`}
      ariaValue={`${left}% left`}
      tooltip={
        <>
          <span className="text-foreground">
            {window.label}: {left}% left
          </span>
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              Resets in {formatDuration(resetsAt - now)} ·{" "}
              {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            </span>
          ) : null}
          {pace ? <span className="text-muted-foreground">{PACE_LABEL[pace]}</span> : null}
        </>
      }
    />
  );
}

/** One label, hairline, and value row; the whole row opens the details tooltip. */
function UsageRow({
  label,
  fill,
  tone,
  tick = null,
  value,
  ariaValue = value,
  tooltip,
  muted = false,
}: {
  readonly label: string;
  /** Bar fill from 0 to 100. Null hides the bar. */
  readonly fill: number | null;
  readonly tone: UsageTone;
  /** A marker on the bar, from 0 to 100. */
  readonly tick?: number | null;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
  readonly muted?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            aria-label={`${label}: ${ariaValue}`}
            className="col-span-3 grid h-6 cursor-default grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]"
          />
        }
      >
        <span className="max-w-28 truncate text-muted-foreground">{label}</span>
        {fill !== null ? (
          <span className="relative h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
            {fill > 0 ? (
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  tone === "error"
                    ? "bg-error"
                    : tone === "warning"
                      ? "bg-warning"
                      : muted
                        ? "bg-muted-foreground"
                        : "bg-foreground/80",
                )}
                style={{ width: `max(${fill}%, 6px)` }}
              />
            ) : null}
            {tick !== null ? (
              <span
                aria-hidden
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/60"
                style={{ left: `${tick}%` }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            // Text-only rows span the bar column so they never widen the shared value column.
            "text-end font-medium tabular-nums",
            fill === null && "col-span-2",
            tone === "error"
              ? "text-error-foreground"
              : tone === "warning"
                ? "text-warning-foreground"
                : fill === null
                  ? "text-muted-foreground"
                  : "text-foreground/80",
          )}
        >
          {value}
        </span>
      </TooltipTrigger>
      {/* Rows sit 8px inside the card; clear its edge instead of overlapping it. */}
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}
