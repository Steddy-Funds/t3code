import {
  effectiveThreadPriority,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ThreadPriority,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "~/state/threads";

export type RunningThread = Pick<OrchestrationV2ThreadShell, "id" | "title" | "status"> & {
  readonly priority: ThreadPriority;
  readonly loadPaused: boolean;
};

export const RUNNING_STATUS_LABELS: Partial<Record<OrchestrationV2ThreadShell["status"], string>> =
  {
    preparing: "Preparing",
    queued: "Queued",
    starting: "Starting",
    running: "Running",
  };

export const LOAD_PAUSED_LABEL = "Paused for load";

const sameThreads = (a: ReadonlyArray<RunningThread>, b: ReadonlyArray<RunningThread>) =>
  a.length === b.length &&
  a.every(
    (thread, index) =>
      thread.id === b[index]?.id &&
      thread.title === b[index]?.title &&
      thread.status === b[index]?.status &&
      thread.priority === b[index]?.priority &&
      thread.loadPaused === b[index]?.loadPaused,
  );

// Shell updates arrive for every thread change; readers render only when this list changes.
// Load-paused threads stay listed: the machine view is where a user looks for them.
export const runningThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<RunningThread> =>
    get(environmentThreadShells.environmentThreadsAtom(environmentId)).flatMap((thread) => {
      const loadPaused = thread.loadPause != null;
      return RUNNING_STATUS_LABELS[thread.status] === undefined && !loadPaused
        ? []
        : [
            {
              id: thread.id,
              title: thread.title,
              status: thread.status,
              priority: effectiveThreadPriority(thread),
              loadPaused,
            },
          ];
    }),
  ).pipe(Atom.withEquality(sameThreads), Atom.withLabel(`running-threads:${environmentId}`)),
);

export const runningThreadCountAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(runningThreadsAtom(environmentId)).filter((thread) => !thread.loadPaused).length,
  ).pipe(Atom.withLabel(`running-thread-count:${environmentId}`)),
);
