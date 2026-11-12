import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type TurnTokenUsage, type UsageTokenTotals } from "@t3tools/contracts";

import { summarizeThreadUsage, turnUsageTotals } from "./ThreadUsageService.ts";

const usage = (fields: {
  readonly usageStatus?: TurnTokenUsage["usageStatus"];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly reasoningTokens?: number;
  readonly models?: ReadonlyArray<string>;
  readonly otherUsage?: { readonly inputTokens: number; readonly outputTokens: number };
}): TurnTokenUsage => {
  const { usageStatus = "complete", ...rest } = fields;
  return usageStatus === "complete"
    ? {
        usageScope: "main_agent",
        hasSubagents: false,
        inputTokens: 0,
        outputTokens: 0,
        ...rest,
        usageStatus,
      }
    : { usageScope: "main_agent", hasSubagents: false, ...rest, usageStatus };
};

// Whole-dollar token rates keep the expected costs readable.
const pricer = {
  price: (model: string, totals: UsageTokenTotals) =>
    model === "priced"
      ? totals.uncachedInputTokens +
        totals.cachedInputTokens * 0.1 +
        totals.cacheCreationTokens * 1.25 +
        totals.outputTokens * 5
      : null,
};

describe("thread usage", () => {
  it("splits cache reads and writes out of input and gives other work the same cache mix", () => {
    expect(
      turnUsageTotals(
        usage({
          inputTokens: 100,
          cachedInputTokens: 80,
          cacheCreationTokens: 10,
          outputTokens: 7,
          reasoningTokens: 3,
          otherUsage: { inputTokens: 50, outputTokens: 2 },
        }),
      ),
    ).toEqual({
      uncachedInputTokens: 15,
      cachedInputTokens: 120,
      cacheCreationTokens: 15,
      outputTokens: 9,
      reasoningTokens: 3,
    });
    expect(turnUsageTotals(usage({ usageStatus: "unavailable" }))).toBeNull();
  });

  it("scopes to the given threads and keeps unpriced and unmeasured turns out of the cost", () => {
    const thread = ThreadId.make("thread:a");
    const fork = ThreadId.make("thread:b");
    const records = {
      threadIds: [thread, fork],
      threadModels: new Map([[fork, "priced"]]),
      toolCalls: new Map([
        [thread, 4],
        [fork, 1],
      ]),
      providerTurns: [
        {
          threadId: thread,
          startedAt: "2026-11-01T10:00:00.000Z",
          completedAt: "2026-11-01T10:01:00.000Z",
          usage: usage({ inputTokens: 10, outputTokens: 1, models: ["priced"] }),
        },
        {
          threadId: thread,
          startedAt: "2026-11-01T10:05:00.000Z",
          completedAt: null,
          usage: usage({ inputTokens: 3, outputTokens: 0, models: ["mystery"] }),
        },
        {
          threadId: fork,
          startedAt: "2026-11-01T11:00:00.000Z",
          completedAt: "2026-11-01T11:00:30.000Z",
          usage: null,
        },
        {
          threadId: fork,
          startedAt: "2026-11-01T11:01:00.000Z",
          completedAt: "2026-11-01T11:02:00.000Z",
          usage: usage({ inputTokens: 2, outputTokens: 2 }),
        },
      ],
    };

    const own = summarizeThreadUsage(records, new Set([thread]), pricer);
    expect(own).toMatchObject({
      threads: 1,
      costUsd: 15,
      providerTurns: 2,
      unmeasuredTurns: 0,
      unpricedTurns: 1,
      toolCalls: 4,
      activeMs: 60_000,
      firstActivityAt: "2026-11-01T10:00:00.000Z",
      lastActivityAt: "2026-11-01T10:05:00.000Z",
    });
    expect(own.totals.uncachedInputTokens).toBe(13);
    expect(own.models.map((model) => [model.model, model.costUsd])).toEqual([
      ["priced", 15],
      ["mystery", null],
    ]);

    const lineage = summarizeThreadUsage(records, new Set(records.threadIds), pricer);
    expect(lineage).toMatchObject({
      threads: 2,
      costUsd: 27,
      providerTurns: 4,
      unmeasuredTurns: 1,
      unpricedTurns: 1,
      toolCalls: 5,
      activeMs: 150_000,
      lastActivityAt: "2026-11-01T11:02:00.000Z",
    });
  });
});
