import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

interface ThreadTally {
  /** The last run seen completed, or null when none has been. */
  readonly completedRunId: string | null;
  readonly nativeSubagentsCompleted: number;
}

export type TurnTallies = ReadonlyMap<string, ThreadTally>;

/**
 * Agent turns that completed since the last observation: thread runs, delegated children's runs
 * (their own threads), and provider-native subagents (counted on their parent). `previous` null,
 * on first sight or a reconnect, only records the baseline, so a snapshot never pays out for old turns.
 */
export function countFinishedTurns(
  previous: TurnTallies | null,
  threads: ReadonlyArray<
    Pick<OrchestrationV2ThreadShell, "id" | "status" | "latestRunId" | "nativeSubagentsCompleted">
  >,
): { readonly tallies: TurnTallies; readonly coins: number } {
  const tallies = new Map<string, ThreadTally>();
  let coins = 0;
  for (const thread of threads) {
    const prior = previous?.get(thread.id);
    const completedRunId =
      thread.status === "completed" && thread.latestRunId !== null
        ? thread.latestRunId
        : (prior?.completedRunId ?? null);
    const nativeSubagentsCompleted = thread.nativeSubagentsCompleted ?? 0;
    if (prior !== undefined) {
      if (completedRunId !== prior.completedRunId) coins += 1;
      coins += Math.max(0, nativeSubagentsCompleted - prior.nativeSubagentsCompleted);
    }
    tallies.set(thread.id, { completedRunId, nativeSubagentsCompleted });
  }
  return { tallies, coins };
}
