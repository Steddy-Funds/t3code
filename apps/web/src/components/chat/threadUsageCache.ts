import { type EnvironmentId, type ThreadId, ThreadUsage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:thread-usage-cache:v1";
const MAX_ENTRIES = 100;

/** Insertion-ordered, oldest first, so trimming drops the threads viewed longest ago. */
const ThreadUsageCache = Schema.Record(Schema.String, ThreadUsage);

const cacheKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}:${threadId}`;

function readCache() {
  try {
    return getLocalStorageItem(STORAGE_KEY, ThreadUsageCache) ?? {};
  } catch {
    return {};
  }
}

export function readCachedThreadUsage(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadUsage | null {
  return readCache()[cacheKey(environmentId, threadId)] ?? null;
}

export function saveCachedThreadUsage(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  usage: ThreadUsage,
) {
  const key = cacheKey(environmentId, threadId);
  const { [key]: _previous, ...rest } = readCache();
  const entries = Object.entries(rest);
  const kept = entries.slice(Math.max(0, entries.length - (MAX_ENTRIES - 1)));
  try {
    setLocalStorageItem(
      STORAGE_KEY,
      { ...Object.fromEntries(kept), [key]: usage },
      ThreadUsageCache,
    );
  } catch {
    // A full or unavailable store only costs the instant first paint.
  }
}
