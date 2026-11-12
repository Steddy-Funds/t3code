import type { MachineProcessRow } from "@t3tools/client-runtime/state/machineProcessFrames";
import type { ThreadId, ThreadResources } from "@t3tools/contracts";

import { ownerThreadId } from "./ownership/processOwners";

/** The focused thread's lineage on this machine; servers before lineage send only the thread. */
export function focusLineage(
  threadId: ThreadId,
  resources: Pick<ThreadResources, "threadIds"> | null,
): ReadonlySet<ThreadId> {
  return new Set(resources?.threadIds ?? [threadId]);
}

/** A process the lineage owns, its own or claimed. Shared roots belong to no one thread. */
export function processInFocus(row: MachineProcessRow, lineage: ReadonlySet<ThreadId>): boolean {
  const threadId = ownerThreadId(row.owner);
  return threadId !== null && lineage.has(threadId);
}

/** Lineage threads first, each part in its original order. */
export function threadsFocusedFirst<Thread extends { readonly id: ThreadId }>(
  threads: ReadonlyArray<Thread>,
  lineage: ReadonlySet<ThreadId>,
): ReadonlyArray<Thread> {
  return [
    ...threads.filter((thread) => lineage.has(thread.id)),
    ...threads.filter((thread) => !lineage.has(thread.id)),
  ];
}
