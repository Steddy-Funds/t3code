import type { EnvironmentId, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "~/state/threads";

export type RunningThread = Pick<OrchestrationV2ThreadShell, "id" | "title" | "status">;

export const RUNNING_STATUS_LABELS: Partial<Record<OrchestrationV2ThreadShell["status"], string>> =
  {
    preparing: "Preparing",
    queued: "Queued",
    starting: "Starting",
    running: "Running",
  };

const sameThreads = (a: ReadonlyArray<RunningThread>, b: ReadonlyArray<RunningThread>) =>
  a.length === b.length &&
  a.every(
    (thread, index) =>
      thread.id === b[index]?.id &&
      thread.title === b[index]?.title &&
      thread.status === b[index]?.status,
  );

// Shell updates arrive for every thread change; readers render only when this list changes.
export const runningThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<RunningThread> =>
    get(environmentThreadShells.environmentThreadsAtom(environmentId)).flatMap((thread) =>
      RUNNING_STATUS_LABELS[thread.status] === undefined
        ? []
        : [{ id: thread.id, title: thread.title, status: thread.status }],
    ),
  ).pipe(Atom.withEquality(sameThreads), Atom.withLabel(`running-threads:${environmentId}`)),
);

export const runningThreadCountAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => get(runningThreadsAtom(environmentId)).length).pipe(
    Atom.withLabel(`running-thread-count:${environmentId}`),
  ),
);
