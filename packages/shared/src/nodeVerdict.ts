import type {
  MachineThresholds,
  MachineVerdict,
  MachineVerdictReason,
  MachineVerdictRule,
} from "@t3tools/contracts";

import type { HostTotals } from "./hostTotals.ts";

export interface VerdictState {
  readonly verdict: MachineVerdict;
  /** When the current verdict began. */
  readonly since: number;
  readonly reason: MachineVerdictReason | null;
  /** When each rule began to sit continuously at or above its threshold. */
  readonly overSince: Partial<Record<MachineVerdictRule, number>>;
  /** While stressed: when every rule fell below its exit level. */
  readonly clearSince: number | null;
}

export function initialVerdictState(now: number): VerdictState {
  return { verdict: "unknown", since: now, reason: null, overSince: {}, clearSince: null };
}

interface RuleReading {
  readonly rule: MachineVerdictRule;
  /** In the rule's unit: load per core, percent, or the macOS pressure level. */
  readonly value: number;
  readonly threshold: number;
  readonly enterHoldMs: number;
}

const CRITICAL_PRESSURE_LEVEL = 4;
const PRESSURE_LEVEL = { normal: 1, warn: 2, critical: CRITICAL_PRESSURE_LEVEL } as const;

function readRules(totals: HostTotals, th: MachineThresholds): ReadonlyArray<RuleReading> {
  const rules: Array<RuleReading> = [];
  if (totals.platform === "win32") {
    if (totals.cpuUtilization !== null) {
      rules.push({
        rule: "cpu",
        value: totals.cpuUtilization * 100,
        threshold: th.windowsCpuPercent,
        enterHoldMs: th.windowsCpuHoldMs,
      });
    }
  } else if (totals.load !== null && totals.cpuCount > 0) {
    rules.push({
      rule: "load",
      value: totals.load.five / totals.cpuCount,
      threshold: th.loadPerCore,
      enterHoldMs: th.enterHoldMs,
    });
  }
  // macOS counts compressed and cached memory as used, so only the pressure level speaks for RAM.
  if (totals.platform === "darwin") {
    if (totals.memoryPressure !== null) {
      rules.push({
        rule: "memoryPressure",
        value: PRESSURE_LEVEL[totals.memoryPressure],
        threshold: CRITICAL_PRESSURE_LEVEL,
        enterHoldMs: th.enterHoldMs,
      });
    }
  } else if (totals.memoryTotalBytes > 0) {
    rules.push({
      rule: "memory",
      value:
        ((totals.memoryTotalBytes - totals.memoryAvailableBytes) / totals.memoryTotalBytes) * 100,
      threshold: th.memoryUsedPercent,
      enterHoldMs: th.enterHoldMs,
    });
  }
  return rules;
}

function toReason(reading: RuleReading, heldForMs: number): MachineVerdictReason {
  return {
    rule: reading.rule,
    value: reading.value,
    threshold: reading.threshold,
    heldForMs: Math.max(0, Math.round(heldForMs)),
  };
}

function worst(readings: ReadonlyArray<RuleReading>): RuleReading | undefined {
  let pick: RuleReading | undefined;
  for (const reading of readings) {
    if (pick === undefined || reading.value / reading.threshold > pick.value / pick.threshold) {
      pick = reading;
    }
  }
  return pick;
}

/**
 * One step of the locked verdict: enter stressed after a rule holds at its threshold for its
 * hold, leave only after every rule stays below `exitFactor` × its threshold for `exitHoldMs`.
 */
export function stepVerdict(
  prev: VerdictState,
  totals: HostTotals | null,
  th: MachineThresholds,
  now: number,
): VerdictState {
  const readings = totals === null ? [] : readRules(totals, th);
  if (readings.length === 0) {
    return prev.verdict === "unknown" ? prev : initialVerdictState(now);
  }

  const overSince: Partial<Record<MachineVerdictRule, number>> = {};
  for (const reading of readings) {
    if (reading.value >= reading.threshold) {
      overSince[reading.rule] = prev.overSince[reading.rule] ?? now;
    }
  }
  const heldFor = (reading: RuleReading) => now - (overSince[reading.rule] ?? now);

  if (prev.verdict !== "stressed") {
    const entering = worst(
      readings.filter(
        (reading) =>
          overSince[reading.rule] !== undefined && heldFor(reading) >= reading.enterHoldMs,
      ),
    );
    if (entering === undefined) {
      return {
        verdict: "ok",
        since: prev.verdict === "ok" ? prev.since : now,
        reason: null,
        overSince,
        clearSince: null,
      };
    }
    return {
      verdict: "stressed",
      since: now,
      reason: toReason(entering, heldFor(entering)),
      overSince,
      clearSince: null,
    };
  }

  const aboveExit = readings.filter(
    (reading) => reading.value >= reading.threshold * th.exitFactor,
  );
  if (aboveExit.length > 0) {
    // Keep the current rule while it still holds, so the reason does not flip between rules.
    const current =
      aboveExit.find((reading) => reading.rule === prev.reason?.rule) ?? worst(aboveExit)!;
    return {
      verdict: "stressed",
      since: prev.since,
      reason: toReason(current, now - (overSince[current.rule] ?? prev.since)),
      overSince,
      clearSince: null,
    };
  }

  const clearSince = prev.clearSince ?? now;
  if (now - clearSince >= th.exitHoldMs) {
    return { verdict: "ok", since: now, reason: null, overSince, clearSince: null };
  }
  return { ...prev, overSince, clearSince };
}

/** True when a client should hear about the step: the verdict or the reason's rule changed. */
export function verdictChanged(prev: VerdictState, next: VerdictState): boolean {
  return (
    prev.verdict !== next.verdict ||
    prev.reason?.rule !== next.reason?.rule ||
    prev.reason?.deviceId !== next.reason?.deviceId
  );
}
