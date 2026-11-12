import { describe, expect, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2ProviderTurn,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";

import { makeTokenBurnMeter, TOKEN_BURN_SAMPLE_INTERVAL_MS } from "./TokenBurnRates.ts";

const MINUTE = TOKEN_BURN_SAMPLE_INTERVAL_MS;
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const subagent = ThreadId.make("subagent");

const turn = (
  id: string,
  usage: { readonly input: number; readonly output: number } | null,
  status: OrchestrationV2ProviderTurn["status"] = "running",
): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(id),
  providerThreadId: ProviderThreadId.make("provider-thread"),
  nodeId: NodeId.make("node"),
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status,
  startedAt: null,
  completedAt: null,
  ...(usage === null
    ? {}
    : {
        tokenUsage: {
          usedTokens: usage.input + usage.output,
          inputTokens: usage.input,
          outputTokens: usage.output,
          updatedAt: "2026-11-11T00:00:00.000Z",
        },
      }),
});

describe("token burn meter", () => {
  it("counts each request once as its output streams in, a subagent's too", () => {
    const meter = makeTokenBurnMeter();
    meter.sample(0);
    // Request 1 starts, streams, and is reported again unchanged.
    meter.record(threadA, turn("t1", { input: 1_000, output: 5 }));
    meter.record(threadA, turn("t1", { input: 1_000, output: 200 }));
    meter.record(threadA, turn("t1", { input: 1_000, output: 200 }));
    // Request 2 re-reads a larger context.
    meter.record(threadA, turn("t1", { input: 1_300, output: 8 }));
    meter.record(threadA, turn("t1", { input: 1_300, output: 100 }));
    // The terminal update carries no request usage.
    meter.record(threadA, turn("t1", null, "completed"));
    // Another turn's requests count separately.
    meter.record(threadB, turn("t2", { input: 500, output: 50 }));
    // A subagent's request snapshots fill its input in late, then repeat it.
    const request = (requestId: string, inputTokens: number, outputTokens: number) =>
      meter.recordSubagentRequest(subagent, { requestId, inputTokens, outputTokens });
    request("m1", 0, 5);
    request("m1", 2_000, 40);
    request("m1", 2_000, 40);
    request("m2", 2_100, 10);

    expect(meter.sample(MINUTE)).toEqual([
      { threadId: subagent, tokensPerMinute: 2_040 + 2_110 },
      { threadId: threadA, tokensPerMinute: 1_200 + 1_400 },
      { threadId: threadB, tokensPerMinute: 550 },
    ]);
  });

  it("averages over the last five one-minute samples and drops idle threads", () => {
    const meter = makeTokenBurnMeter();
    meter.sample(0);
    meter.record(threadA, turn("t1", { input: 6_000, output: 0 }));
    for (let minute = 1; minute <= 5; minute++) {
      expect(meter.sample(minute * MINUTE)).toEqual([
        { threadId: threadA, tokensPerMinute: 6_000 / minute },
      ]);
    }
    // The burst leaves the window once the zero-minute sample ages out.
    expect(meter.sample(6 * MINUTE)).toEqual([]);
    meter.record(threadA, turn("t1", { input: 9_000, output: 1_000 }));
    expect(meter.sample(7 * MINUTE)).toEqual([{ threadId: threadA, tokensPerMinute: 2_000 }]);
  });
});
