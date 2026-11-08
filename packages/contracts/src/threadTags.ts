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

/** Bucket writes from a thread with this tag are `auto`: they never change a bucket someone else edited. */
export const MACHINE_BUCKETS_THREAD_TAG = "machine-buckets";
