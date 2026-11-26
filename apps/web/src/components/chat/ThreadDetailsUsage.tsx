import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  ThreadId,
  ThreadUsageScope,
  UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  formatCompactUsd,
  formatCount,
  formatTokens,
  formatUsd,
} from "@t3tools/shared/usageFormat";
import {
  type LimitPace,
  type LimitPoolWindow,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { formatDuration, limitsNotice } from "@t3tools/shared/usageLimitsCopy";
import { Link } from "@tanstack/react-router";
import { msg, useGT, useLocale, useMessages } from "gt-react";
import { MessagesSquareIcon } from "lucide-react";
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
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { readCachedThreadUsage, saveCachedThreadUsage } from "./threadUsageCache";
import {
  nextPoolReset,
  poolSources,
  resolveThreadDetailsLimits,
  resolveThreadHttpQuotas,
} from "./ThreadDetailsUsage.logic";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: msg("Ahead of pace"),
  on: msg("On pace"),
  under: msg("Under pace"),
};

export interface ThreadDetailsUsageInput {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly model: string | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
}

type UsageTone = "error" | "warning" | null;

function limitTone(left: number): UsageTone {
  if (left <= 10) return "error";
  if (left <= 20) return "warning";
  return null;
}

/** The selected provider's limit windows. Each row reads as room left and opens the usage page. */
export function ThreadDetailsUsage({
  providerInstanceId,
  model,
  providers,
  sources,
}: Omit<ThreadDetailsUsageInput, "contextWindow">) {
  const gt = useGT();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const resolved = resolveThreadDetailsLimits(providerInstanceId, model, providers, sources, now);
  const quotas = resolveThreadHttpQuotas(providerInstanceId, sources);
  if (!resolved && quotas.length === 0) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title={gt("Usage limits")}
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {resolved?.kind === "pool"
          ? resolved.windows.map((window) => <PoolRow key={window.id} window={window} now={now} />)
          : resolved &&
            (quotas.length === 0 || limitsNotice(resolved.limits) === null) && (
              <InstanceRows limits={resolved.limits} now={now} />
            )}
        {quotas.map(({ key, accountLabel, window }) => (
          <LimitRow key={key} window={window} now={now} accountLabel={accountLabel} />
        ))}
      </div>
    </ThreadDetailsSection>
  );
}

function InstanceRows({
  limits,
  now,
}: {
  readonly limits: ServerProviderUsageLimits;
  readonly now: number;
}) {
  const gt = useGT();
  const m = useMessages();
  const notice = limitsNotice(limits, m);
  if (notice) {
    return (
      <UsageRow
        label={gt("Limits", { $context: "usage limits row label" })}
        fill={null}
        tone={null}
        value={gt("Unavailable")}
        tooltip={<span className="text-foreground">{notice}</span>}
        opensUsage
      />
    );
  }
  return limits.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />);
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
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title={gt("Context window")}
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label={gt("Context", { $context: "context window row label" })}
          fill={used}
          tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
          tick={tick}
          muted
          value={
            maxTokens !== null
              ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}`
              : usedTokens
          }
          ariaValue={
            used !== null
              ? gt("{used}% used", { used })
              : gt("{usedTokens} tokens used", { usedTokens })
          }
          tooltip={
            <>
              <span className="text-foreground">
                {used !== null
                  ? gt("Context: {used}% used", { used })
                  : gt("Context: {usedTokens} tokens used", { usedTokens })}
              </span>
              {maxTokens !== null ? (
                <span className="text-muted-foreground">
                  {gt("{used} of {max} tokens", {
                    used: usage.usedTokens.toLocaleString(locale),
                    max: maxTokens.toLocaleString(locale),
                  })}
                </span>
              ) : null}
              {threshold !== null && threshold > 0 ? (
                <span className="text-muted-foreground">
                  {formatContextWindowCompactionMessage(threshold, m)}
                </span>
              ) : null}
            </>
          }
        />
      </div>
    </ThreadDetailsSection>
  );
}

/** List-price cost, tokens, and activity summed over the thread's whole lineage, root included. */
export function ThreadDetailsCost({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    serverEnvironment.threadUsage({ environmentId, input: { threadId } }),
  );
  const completedAt = useQuietThreadShell({ environmentId, threadId })?.latestRun?.completedAt;
  const { refresh } = query;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetch server totals when a run settles
  useEffect(() => {
    if (completedAt) refresh();
  }, [completedAt, refresh]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- write each fresh pull to localStorage
  useEffect(() => {
    if (query.data) saveCachedThreadUsage(environmentId, threadId, query.data);
  }, [environmentId, threadId, query.data]);
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  // The last pull paints at once; the live query replaces it when it answers.
  const usage = query.data ?? readCachedThreadUsage(environmentId, threadId);
  if (!usage || usage.lineage.providerTurns === 0) return null;
  const scope = usage.lineage;
  const pricingKnown = usage.pricing.status !== "unavailable";
  const title =
    scope.threads > 1
      ? gt("Lineage, {threads} threads", { threads: formatCount(scope.threads) })
      : gt("This thread");
  const tokens = formatTokens(inputTokens(scope) + scope.totals.outputTokens);
  const turns = formatCount(scope.providerTurns);
  const active = formatActive(scope.activeMs);
  const activity = <ActivityLines scope={scope} now={now} title={title} />;

  return (
    <ThreadDetailsSection
      headingId="thread-details-cost-heading"
      title={gt("Cost and activity")}
      showHeading={false}
    >
      <div className="flex min-h-6 flex-wrap items-center px-1 text-xs font-medium text-muted-foreground tabular-nums">
        <CostSegment
          label={gt("Cost", { $context: "thread cost at API list prices" })}
          scope={scope}
          pricingKnown={pricingKnown}
        />
        <Separator />
        <Segment
          label={gt("Tokens")}
          value={tokens}
          ariaValue={gt("{tokens} tokens", { tokens })}
          tooltip={<TokenBreakdown scope={scope} title={title} />}
        />
        <Separator />
        <Segment
          label={gt("Turns", { $context: "agent turns in a thread" })}
          value={
            <>
              <MessagesSquareIcon aria-hidden className="size-3.5" />
              {turns}
            </>
          }
          ariaValue={turns}
          tooltip={activity}
        />
        <Separator />
        <Segment
          label={gt("Active", { $context: "time an agent spent working" })}
          value={active}
          ariaValue={active}
          tooltip={activity}
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
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : formatDuration(ms);
}

function CostSegment({
  label,
  scope,
  pricingKnown,
}: {
  readonly label: string;
  readonly scope: ThreadUsageScope;
  readonly pricingKnown: boolean;
}) {
  const gt = useGT();
  const measured = scope.providerTurns - scope.unmeasuredTurns;
  const priced = pricingKnown && measured > scope.unpricedTurns;
  const cost = formatUsd(scope.costUsd);
  return (
    <Segment
      label={label}
      value={priced ? formatCompactUsd(scope.costUsd) : gt("Unpriced")}
      ariaValue={priced ? gt("about {cost}", { cost }) : gt("no price available")}
      tooltip={
        <>
          <span className="text-foreground">
            {priced
              ? gt("{label}: about {cost} at API list prices", { label, cost })
              : gt("{label}: no price", { label })}
          </span>
          {scope.threads > 1 ? (
            <span className="text-muted-foreground">
              {gt("{threads} threads: forks, side chats, and delegated tasks", {
                threads: formatCount(scope.threads),
              })}
            </span>
          ) : null}
          {scope.models.map((model) => (
            <span key={model.model} className="text-muted-foreground tabular-nums">
              {model.model}: {model.costUsd === null ? gt("unpriced") : formatUsd(model.costUsd)}
            </span>
          ))}
          {scope.unpricedTurns > 0 ? (
            <span className="text-muted-foreground">
              {gt("{turns} turns from unpriced models are not counted", {
                turns: formatCount(scope.unpricedTurns),
              })}
            </span>
          ) : null}
          {scope.unmeasuredTurns > 0 ? (
            <span className="text-muted-foreground">
              {gt("{turns} turns reported no token counts", {
                turns: formatCount(scope.unmeasuredTurns),
              })}
            </span>
          ) : null}
          <span className="text-muted-foreground">
            {gt("Subscriptions bill differently; this is what the tokens would cost on the API.")}
          </span>
        </>
      }
    />
  );
}

/** One hoverable value in the single-line cost strip; its label lives in the tooltip. */
function Segment({
  label,
  value,
  ariaValue,
  tooltip,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly ariaValue: string;
  readonly tooltip: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={`${label}: ${ariaValue}`}
            className="flex h-6 cursor-default items-center gap-1 whitespace-nowrap rounded-lg px-1.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]"
          />
        }
      >
        {value}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}

function Separator() {
  return (
    <span aria-hidden className="text-muted-foreground/50">
      ·
    </span>
  );
}

function TokenBreakdown({
  scope,
  title,
}: {
  readonly scope: ThreadUsageScope;
  readonly title: string;
}) {
  const gt = useGT();
  const { totals } = scope;
  return (
    <>
      <span className="text-foreground">
        {gt("{title}: {tokens} tokens", {
          title,
          tokens: formatTokens(inputTokens(scope) + totals.outputTokens),
        })}
      </span>
      <span className="text-muted-foreground tabular-nums">
        {gt("Input {count}", { count: formatCount(totals.uncachedInputTokens) })}
      </span>
      <span className="text-muted-foreground tabular-nums">
        {gt("Cache read {count}", { count: formatCount(totals.cachedInputTokens) })}
      </span>
      <span className="text-muted-foreground tabular-nums">
        {gt("Cache write {count}", { count: formatCount(totals.cacheCreationTokens) })}
      </span>
      <span className="text-muted-foreground tabular-nums">
        {totals.reasoningTokens > 0
          ? gt("Output {count} ({reasoning} reasoning)", {
              count: formatCount(totals.outputTokens),
              reasoning: formatCount(totals.reasoningTokens),
            })
          : gt("Output {count}", { count: formatCount(totals.outputTokens) })}
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
  const gt = useGT();
  return (
    <>
      <span className="text-foreground">
        {gt("{title}: {turns} turns, {toolCalls} tool calls", {
          title,
          turns: formatCount(scope.providerTurns),
          toolCalls: formatCount(scope.toolCalls),
        })}
      </span>
      <span className="text-muted-foreground">
        {gt("{active} active in total", { active: formatActive(scope.activeMs) })}
      </span>
      {scope.firstActivityAt ? (
        <span className="text-muted-foreground">
          {scope.lastActivityAt
            ? gt("First turn {first}, last {last}", {
                first: formatRelativeTimeLabel(scope.firstActivityAt, now),
                last: formatRelativeTimeLabel(scope.lastActivityAt, now),
              })
            : gt("First turn {first}", {
                first: formatRelativeTimeLabel(scope.firstActivityAt, now),
              })}
        </span>
      ) : null}
    </>
  );
}

function LimitRow({
  window,
  now,
  accountLabel,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
  readonly accountLabel?: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return (
    <UsageRow
      label={window.label}
      fill={left}
      tone={limitTone(left)}
      tick={timeLeft}
      value={`${left}%`}
      ariaValue={gt("{left}% left", { left })}
      opensUsage
      tooltip={
        <>
          <span className="text-foreground">
            {gt("{label}: {left}% left", { label: window.label, left })}
          </span>
          {accountLabel ? <span className="text-muted-foreground">{accountLabel}</span> : null}
          {pace && timeLeft !== null ? (
            <span className="text-muted-foreground">
              {m(PACE_LABEL[pace])} · {gt("{timeLeft}% of the window left", { timeLeft })}
            </span>
          ) : null}
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              {gt("Resets in {duration} · {time}", {
                duration: formatDuration(resetsAt - now, m),
                time: formatUpcomingTimestamp(window.resetsAt, timestampFormat, now, undefined, m),
              })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

function PoolRow({ window, now }: { readonly window: LimitPoolWindow; readonly now: number }) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = window.remainingPercent;
  const accounts = window.members.length;
  const from = poolSources(window);
  const sourceLabels = [...from.hubs, ...(from.signedIn ? [gt("Signed-in accounts")] : [])];
  const next = nextPoolReset(window, now);
  const resetsAt = next?.member.window.resetsAt;
  const reset =
    next && resetsAt
      ? {
          duration: formatDuration(next.at - now, m),
          time: formatUpcomingTimestamp(resetsAt, timestampFormat, now, undefined, m),
        }
      : null;
  return (
    <UsageRow
      label={window.label}
      fill={left}
      tone={limitTone(left)}
      value={`${left}%`}
      ariaValue={gt("{left}% left", { left })}
      opensUsage
      tooltip={
        <>
          <span className="text-foreground">
            {accounts > 1
              ? gt("{label}: {left}% left across {accounts} accounts", {
                  label: window.label,
                  left,
                  accounts,
                })
              : gt("{label}: {left}% left", { label: window.label, left })}
          </span>
          {window.pace ? (
            <span className="text-muted-foreground">{m(PACE_LABEL[window.pace])}</span>
          ) : null}
          {next && reset ? (
            <span className="text-muted-foreground">
              {accounts > 1
                ? gt("+{percent}% in {duration} · {time}", {
                    percent: next.restoresPercent,
                    ...reset,
                  })
                : gt("Resets in {duration} · {time}", reset)}
            </span>
          ) : null}
          {sourceLabels.length > 0 ? (
            <span className="text-muted-foreground">
              {gt("From {sources}", { sources: sourceLabels.join(", ") })}
            </span>
          ) : null}
        </>
      }
    />
  );
}

/** One label, hairline, and value row; the whole row opens the details tooltip. With `opensUsage` it links to the usage page. */
function UsageRow({
  label,
  fill,
  tone,
  tick = null,
  value,
  ariaValue = value,
  tooltip,
  muted = false,
  opensUsage = false,
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
  readonly opensUsage?: boolean;
}) {
  const gt = useGT();
  const rowProps = {
    "aria-label": gt("{label}: {value}", { label, value: ariaValue }),
    className: cn(
      "col-span-3 grid h-6 grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]",
      opensUsage
        ? "group cursor-pointer active:bg-black/[0.06] dark:active:bg-white/[0.12]"
        : "cursor-default",
    ),
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          opensUsage ? <Link to="/usage" {...rowProps} /> : <div tabIndex={0} {...rowProps} />
        }
      >
        <span className="max-w-28 truncate text-muted-foreground group-hover:text-foreground">
          {label}
        </span>
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
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/75"
                style={{ left: `clamp(0.5px, ${tick}%, calc(100% - 0.5px))` }}
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
        <div className="flex flex-col gap-0.5">
          {tooltip}
          {opensUsage ? <span className="text-muted-foreground">{gt("Open usage")}</span> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
