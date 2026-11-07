import type { ExecutionEnvironmentPlatformOs, ServerProcessSignal } from "@t3tools/contracts";

const KILL_ONLY: ReadonlyArray<ServerProcessSignal> = ["SIGKILL"];
const TERM_OR_KILL: ReadonlyArray<ServerProcessSignal> = ["SIGTERM", "SIGKILL"];
const INT_OR_KILL: ReadonlyArray<ServerProcessSignal> = ["SIGINT", "SIGKILL"];

/**
 * The signals Kill offers, the default first. Servers that advertise `processSigterm` take
 * SIGTERM; older ones only INT and KILL. On Windows every signal is TerminateProcess, so there is
 * one Kill.
 */
export function processSignalChoices(input: {
  readonly os: ExecutionEnvironmentPlatformOs | null;
  readonly processSigterm: boolean;
}): ReadonlyArray<ServerProcessSignal> {
  if (input.os === "windows") return KILL_ONLY;
  return input.processSigterm ? TERM_OR_KILL : INT_OR_KILL;
}

// The server rechecks pid plus start time right before signalling and refuses with one of these.
// "stale identity" is left out: it means the recheck itself failed, not that the pid moved on.
const PROCESS_CHANGED = /no longer matches|not a live descendant/;

/** Whether a refusal means the pid no longer names the process the user picked. */
export function isProcessChangedRefusal(message: string | null): boolean {
  return message !== null && PROCESS_CHANGED.test(message);
}
