import {
  LOAD_PAUSE_MAX_MS,
  LOW_PRIORITY_THREAD_TAG,
  MachineVerdictRule,
  NORMAL_PRIORITY_THREAD_TAG,
  type OrchestrationV2LoadPause,
  type OrchestrationV2LoadPauseReason,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { formatMachineReason, formatPercent } from "./machineFormat.ts";

const isKnownRule = Schema.is(MachineVerdictRule);

type LoadConfig = Pick<ServerConfig, "environment" | "settings">;

/** Priority and Resume need a server that pauses, with the lane on. */
export function loadPriorityControlsShown(config: LoadConfig | null | undefined): boolean {
  return (
    config?.environment.capabilities.loadPause === true &&
    config.settings.machineResources.loadManagement.enabled
  );
}

/** Resume needs only a server that pauses: a pause can outlive the lane switch by a moment. */
export function loadPauseResumeShown(
  config: LoadConfig | null | undefined,
  pause: OrchestrationV2LoadPause | null | undefined,
): pause is OrchestrationV2LoadPause {
  return pause != null && config?.environment.capabilities.loadPause === true;
}

/** What the thread's tags pick; "default" defers to `effectiveThreadPriority`. Normal wins over low. */
export type ThreadPriorityChoice = "low" | "normal" | "default";

export function threadPriorityChoice(thread: {
  readonly tags?: ReadonlyArray<string> | undefined;
}): ThreadPriorityChoice {
  if (thread.tags?.includes(NORMAL_PRIORITY_THREAD_TAG)) return "normal";
  if (thread.tags?.includes(LOW_PRIORITY_THREAD_TAG)) return "low";
  return "default";
}

export function loadPauseDeadlineMs(pause: OrchestrationV2LoadPause): number {
  return Date.parse(pause.pausedAt) + LOAD_PAUSE_MAX_MS;
}

export function formatLoadPauseReason(reason: OrchestrationV2LoadPauseReason): string {
  const rule = reason.rule;
  const text = isKnownRule(rule)
    ? formatMachineReason({ rule, value: reason.value, threshold: reason.threshold, heldForMs: 0 })
    : `${rule} ${reason.value} / ${reason.threshold}`;
  return `${text}; this thread is ${formatPercent(reason.shareOfLoad * 100)} of the load`;
}

/** Docker ids shorten to the 12 characters `docker ps` shows; names stay whole. */
export function loadPausedContainerNames(pause: OrchestrationV2LoadPause): ReadonlyArray<string> {
  return pause.containersPaused.map(({ id }) => (/^[0-9a-f]{64}$/.test(id) ? id.slice(0, 12) : id));
}

/** The banner and card body; `deadline` is the caller's formatted `loadPauseDeadlineMs`. */
export function loadPauseDescription(input: {
  readonly pause: OrchestrationV2LoadPause;
  readonly deadline: string;
  readonly heldRuns: number;
}): string {
  const containers = loadPausedContainerNames(input.pause);
  return [
    `Machine stressed: ${formatLoadPauseReason(input.pause.reason)}.`,
    `Continues when the machine clears, at the latest ${input.deadline}.`,
    containers.length === 0
      ? null
      : `${containers.length === 1 ? "Container" : "Containers"} ${containers.join(", ")} paused too.`,
    input.heldRuns === 0
      ? null
      : `${input.heldRuns} queued ${input.heldRuns === 1 ? "message sends" : "messages send"} after resume.`,
  ]
    .filter((line) => line !== null)
    .join(" ");
}
