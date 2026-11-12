import { EnvironmentId, ThreadId, type ThreadUsage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { readCachedThreadUsage, saveCachedThreadUsage } from "./threadUsageCache";

const environmentId = EnvironmentId.make("env");
const thread = (index: number) => ThreadId.make(`thread-${index}`);

const usageWithCost = (costUsd: number): ThreadUsage => {
  const scope = {
    threads: 1,
    totals: {
      uncachedInputTokens: 1,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    },
    costUsd,
    models: [],
    providerTurns: 1,
    unmeasuredTurns: 0,
    unpricedTurns: 0,
    toolCalls: 0,
    activeMs: 1_000,
    firstActivityAt: null,
    lastActivityAt: null,
  };
  return {
    thread: scope,
    lineage: scope,
    pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
  };
};

describe("thread usage cache", () => {
  it("keeps the last pull for the 100 most recently saved threads", () => {
    for (let index = 0; index < 100; index++) {
      saveCachedThreadUsage(environmentId, thread(index), usageWithCost(index));
    }
    // Saving thread 0 again makes it the newest, so thread 1 is the one trimmed next.
    saveCachedThreadUsage(environmentId, thread(0), usageWithCost(500));
    saveCachedThreadUsage(environmentId, thread(100), usageWithCost(100));

    expect(readCachedThreadUsage(environmentId, thread(0))?.lineage.costUsd).toBe(500);
    expect(readCachedThreadUsage(environmentId, thread(1))).toBeNull();
    expect(readCachedThreadUsage(environmentId, thread(2))?.lineage.costUsd).toBe(2);
    expect(readCachedThreadUsage(environmentId, thread(100))?.lineage.costUsd).toBe(100);
    expect(readCachedThreadUsage(EnvironmentId.make("other"), thread(0))).toBeNull();
  });
});
