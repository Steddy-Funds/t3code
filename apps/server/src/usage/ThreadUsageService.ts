import {
  type ThreadId,
  type ThreadUsage,
  type ThreadUsageModel,
  type ThreadUsageScope,
  type TurnTokenUsage,
  UsageReadError,
  type UsageTokenTotals,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type ProjectionLineageUsageRecords,
  ProjectionStoreV2,
} from "../orchestration-v2/ProjectionStore.ts";
import { type UsagePricer, UsageService } from "./UsageService.ts";

const UNKNOWN_MODEL = "unknown";

const emptyTotals = (): UsageTokenTotals => ({
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

const addTotals = (a: UsageTokenTotals, b: UsageTokenTotals): UsageTokenTotals => ({
  uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
  cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
  cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
});

/**
 * Turn input includes cache reads and writes. Provider-ledger work beyond the main agent
 * (native subagents, compaction) reports only input and output, so it takes the main agent's
 * cache mix: those calls mostly re-read the same cached prefix.
 */
export function turnUsageTotals(usage: TurnTokenUsage): UsageTokenTotals | null {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return null;
  const input = usage.inputTokens ?? 0;
  const cached = Math.min(usage.cachedInputTokens ?? 0, input);
  const creation = Math.min(usage.cacheCreationTokens ?? 0, input - cached);
  const otherInput = usage.otherUsage?.inputTokens ?? 0;
  const otherCached = input > 0 ? Math.round((otherInput * cached) / input) : 0;
  const otherCreation = input > 0 ? Math.round((otherInput * creation) / input) : 0;
  return {
    uncachedInputTokens: input - cached - creation + (otherInput - otherCached - otherCreation),
    cachedInputTokens: cached + otherCached,
    cacheCreationTokens: creation + otherCreation,
    outputTokens: (usage.outputTokens ?? 0) + (usage.otherUsage?.outputTokens ?? 0),
    reasoningTokens: usage.reasoningTokens ?? 0,
  };
}

/**
 * Sums one set of threads' provider turns. A turn is priced at its first reported model, or the
 * thread's selected model when the turn predates model reporting.
 */
export function summarizeThreadUsage(
  records: ProjectionLineageUsageRecords,
  threadIds: ReadonlySet<ThreadId>,
  pricer: Pick<UsagePricer, "price">,
): ThreadUsageScope {
  const byModel = new Map<string, UsageTokenTotals>();
  let providerTurns = 0;
  let unmeasuredTurns = 0;
  let unpricedTurns = 0;
  let costUsd = 0;
  let activeMs = 0;
  let first: { readonly ms: number; readonly at: string } | null = null;
  let last: { readonly ms: number; readonly at: string } | null = null;
  const unpricedModels = new Set<string>();

  for (const turn of records.providerTurns) {
    if (!threadIds.has(turn.threadId)) continue;
    providerTurns += 1;
    const startedMs = turn.startedAt === null ? Number.NaN : Date.parse(turn.startedAt);
    const completedMs = turn.completedAt === null ? Number.NaN : Date.parse(turn.completedAt);
    if (turn.startedAt !== null && Number.isFinite(startedMs)) {
      if (first === null || startedMs < first.ms) first = { ms: startedMs, at: turn.startedAt };
      if (last === null || startedMs > last.ms) last = { ms: startedMs, at: turn.startedAt };
      if (Number.isFinite(completedMs)) activeMs += Math.max(0, completedMs - startedMs);
    }
    if (turn.completedAt !== null && Number.isFinite(completedMs)) {
      if (last === null || completedMs > last.ms) last = { ms: completedMs, at: turn.completedAt };
    }

    const totals = turn.usage === null ? null : turnUsageTotals(turn.usage);
    if (totals === null) {
      unmeasuredTurns += 1;
      continue;
    }
    const model =
      turn.usage?.models?.[0] ?? records.threadModels.get(turn.threadId) ?? UNKNOWN_MODEL;
    byModel.set(model, addTotals(byModel.get(model) ?? emptyTotals(), totals));
    if (model === UNKNOWN_MODEL || pricer.price(model, totals) === null) {
      unpricedTurns += 1;
      unpricedModels.add(model);
    }
  }

  const models: ThreadUsageModel[] = [];
  let totals = emptyTotals();
  for (const [model, modelTotals] of byModel) {
    const modelCost = unpricedModels.has(model) ? null : pricer.price(model, modelTotals);
    if (modelCost !== null) costUsd += modelCost;
    totals = addTotals(totals, modelTotals);
    models.push({ model, totals: modelTotals, costUsd: modelCost });
  }
  models.sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0));

  let toolCalls = 0;
  for (const threadId of threadIds) toolCalls += records.toolCalls.get(threadId) ?? 0;

  return {
    threads: threadIds.size,
    totals,
    costUsd,
    models,
    providerTurns,
    unmeasuredTurns,
    unpricedTurns,
    toolCalls,
    activeMs,
    firstActivityAt: first?.at ?? null,
    lastActivityAt: last?.at ?? null,
  };
}

export class ThreadUsageService extends Context.Service<
  ThreadUsageService,
  {
    readonly read: (threadId: ThreadId) => Effect.Effect<ThreadUsage, UsageReadError>;
  }
>()("t3/usage/ThreadUsageService") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const usage = yield* UsageService;

  const read = Effect.fn("ThreadUsageService.read")(function* (threadId: ThreadId) {
    const [records, pricer] = yield* Effect.all(
      [
        projections.getLineageUsageRecords(threadId).pipe(
          Effect.mapError(
            (cause) =>
              new UsageReadError({
                reason: "scanFailed",
                detail: "Thread usage could not be read.",
                cause,
              }),
          ),
        ),
        usage.pricer,
      ],
      { concurrency: 2 },
    );
    if (records === null) {
      return yield* new UsageReadError({
        reason: "threadNotFound",
        detail: `Thread '${threadId}' was not found.`,
      });
    }
    return {
      thread: summarizeThreadUsage(records, new Set([threadId]), pricer),
      lineage: summarizeThreadUsage(records, new Set(records.threadIds), pricer),
      pricing: pricer.pricing,
    } satisfies ThreadUsage;
  });

  return { read } as const;
});

export const layer = Layer.effect(ThreadUsageService, make);
