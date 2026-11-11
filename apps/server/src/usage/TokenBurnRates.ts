import {
  type OrchestrationV2ProviderTurn,
  type ThreadId,
  type ThreadTokenBurnRate,
  type TokenBurnRates,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";

export const TOKEN_BURN_SAMPLE_INTERVAL_MS = 60_000;
/** Five one-minute intervals: the newest sample plus the five before it. */
const TOKEN_BURN_WINDOW_SAMPLES = 6;

interface RequestCursor {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

interface Sample {
  readonly atMs: number;
  readonly totals: ReadonlyMap<ThreadId, number>;
}

/**
 * Tokens each thread processes, input (cache reads included) plus output, averaged per minute
 * over the last five one-minute samples. Adapters report the latest model request's usage on
 * the running provider turn: its input is fixed when the request starts and its output grows,
 * so a new input means a new request.
 */
export function makeTokenBurnMeter() {
  const totals = new Map<ThreadId, number>();
  const cursors = new Map<string, RequestCursor>();
  const samples: Sample[] = [];

  const record = (threadId: ThreadId, turn: OrchestrationV2ProviderTurn) => {
    const usage = turn.tokenUsage;
    const running = turn.status === "pending" || turn.status === "running";
    if (!running) cursors.delete(turn.id);
    if (usage?.inputTokens === undefined) return;
    const next = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens ?? 0 };
    const previous = cursors.get(turn.id);
    const added =
      previous === undefined ||
      previous.inputTokens !== next.inputTokens ||
      next.outputTokens < previous.outputTokens
        ? next.inputTokens + next.outputTokens
        : next.outputTokens - previous.outputTokens;
    if (running) cursors.set(turn.id, next);
    if (added > 0) totals.set(threadId, (totals.get(threadId) ?? 0) + added);
  };

  const sample = (atMs: number): ReadonlyArray<ThreadTokenBurnRate> => {
    samples.push({ atMs, totals: new Map(totals) });
    if (samples.length > TOKEN_BURN_WINDOW_SAMPLES) samples.shift();
    const oldest = samples[0]!;
    const minutes = (atMs - oldest.atMs) / TOKEN_BURN_SAMPLE_INTERVAL_MS;
    const rates: ThreadTokenBurnRate[] = [];
    for (const [threadId, total] of totals) {
      const burned = total - (oldest.totals.get(threadId) ?? 0);
      if (burned <= 0) {
        // Idle through the whole window: forget it, and read it as zero if it starts again.
        totals.delete(threadId);
        for (const old of samples) (old.totals as Map<ThreadId, number>).delete(threadId);
        continue;
      }
      if (minutes <= 0) continue;
      rates.push({ threadId, tokensPerMinute: Math.round(burned / minutes) });
    }
    return rates.toSorted((a, b) => b.tokensPerMinute - a.tokensPerMinute);
  };

  return { record, sample } as const;
}

export class TokenBurnRatesService extends Context.Service<
  TokenBurnRatesService,
  {
    /** The latest rates, then each minute's. */
    readonly changes: Stream.Stream<TokenBurnRates>;
  }
>()("t3/usage/TokenBurnRates/TokenBurnRatesService") {}

const make = Effect.gen(function* () {
  const eventSink = yield* EventSinkV2;
  const meter = makeTokenBurnMeter();
  const latest = yield* SubscriptionRef.make<TokenBurnRates>({
    sampledAt: DateTime.formatIso(yield* DateTime.now),
    threads: [],
  });

  const afterSequence = yield* eventSink.latestSequence();
  yield* eventSink.stream({ afterSequence, eventType: "provider-turn.updated" }).pipe(
    Stream.runForEach((stored) =>
      Effect.sync(() => {
        if (stored.event.type === "provider-turn.updated") {
          meter.record(stored.event.threadId, stored.event.payload);
        }
      }),
    ),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  yield* Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* SubscriptionRef.set(latest, {
      sampledAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      threads: meter.sample(nowMs),
    });
  }).pipe(
    Effect.repeat(Schedule.spaced(TOKEN_BURN_SAMPLE_INTERVAL_MS)),
    Effect.forkScoped,
  );

  return { changes: SubscriptionRef.changes(latest) } as const;
});

export const layer = Layer.effect(TokenBurnRatesService, make);
