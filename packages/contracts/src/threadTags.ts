import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Tags match by exact spelling and case after trimming. */
export const ThreadTag = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value) =>
    /[\p{Cc}]/u.test(value) ? "A thread tag must be a single line of text." : true,
  ),
);
export type ThreadTag = typeof ThreadTag.Type;

/** Tags read back from storage or a peer. Lenient so a later tag rule never fails a whole thread. */
export const StoredThreadTags = Schema.Array(Schema.String).pipe(
  Schema.catchDecoding(() => Effect.succeedSome([])),
);

/** Threads with this tag run autonomous agents; clients that opt in list them in a Backgrounded shelf. */
export const BACKGROUNDED_THREAD_TAG = "backgrounded";

export function isBackgroundedThread(thread: {
  readonly tags?: ReadonlyArray<string> | undefined;
}): boolean {
  return thread.tags?.includes(BACKGROUNDED_THREAD_TAG) === true;
}

/** Threads with this tag coordinate other agents; load management never pauses them. */
export const ORCHESTRATOR_THREAD_TAG = "orchestrator";
export const LOW_PRIORITY_THREAD_TAG = "priority:low";
export const NORMAL_PRIORITY_THREAD_TAG = "priority:normal";

export type ThreadPriority = "low" | "normal";

/** Load management may pause only low-priority threads. */
export function effectiveThreadPriority(thread: {
  readonly tags?: ReadonlyArray<string> | undefined;
}): ThreadPriority {
  if (thread.tags?.includes(NORMAL_PRIORITY_THREAD_TAG)) return "normal";
  if (thread.tags?.includes(LOW_PRIORITY_THREAD_TAG)) return "low";
  return isBackgroundedThread(thread) ? "low" : "normal";
}

/** Experimental per-thread autonomy override; child threads inherit it with the rest of the tags. */
export const AUTONOMY_ON_THREAD_TAG = "autonomy:on";
export const AUTONOMY_OFF_THREAD_TAG = "autonomy:off";

export type ThreadAutonomy = "on" | "off" | "default";

export function threadAutonomy(thread: {
  readonly tags?: ReadonlyArray<string> | undefined;
}): ThreadAutonomy {
  if (thread.tags?.includes(AUTONOMY_OFF_THREAD_TAG)) return "off";
  if (thread.tags?.includes(AUTONOMY_ON_THREAD_TAG)) return "on";
  return "default";
}

/** Bucket writes from a thread with this tag are `auto`: they never change a bucket someone else edited. */
export const MACHINE_BUCKETS_THREAD_TAG = "machine-buckets";
