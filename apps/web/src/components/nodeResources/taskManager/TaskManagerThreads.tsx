import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "~/state/threads";

import { MachineSection } from "../primitives/MachineSection";

type RunningThread = Pick<OrchestrationV2ThreadShell, "id" | "title" | "status">;

const STATUS_LABELS: Partial<Record<OrchestrationV2ThreadShell["status"], string>> = {
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

// Shell updates arrive for every thread change; only a change to this list renders the tab.
const runningThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<RunningThread> =>
    get(environmentThreadShells.environmentThreadsAtom(environmentId)).flatMap((thread) =>
      STATUS_LABELS[thread.status] === undefined
        ? []
        : [{ id: thread.id, title: thread.title, status: thread.status }],
    ),
  ).pipe(
    Atom.withEquality(sameThreads),
    Atom.withLabel(`task-manager-running-threads:${environmentId}`),
  ),
);

/** The T3 threads running on this machine; a row opens the thread. */
export function TaskManagerThreads({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const threads = useAtomValue(runningThreadsAtom(environmentId));
  return (
    <MachineSection title="Threads on this machine" detail={`${threads.length} running`}>
      {threads.length === 0 ? null : (
        <ul className="flex min-w-0 flex-col divide-y text-xs">
          {threads.map((thread) => (
            <li key={thread.id}>
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId, threadId: thread.id }}
                className="flex min-w-0 items-baseline gap-2 py-1.5 hover:text-foreground focus-visible:underline focus-visible:outline-none"
              >
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                <span className="shrink-0 text-muted-foreground">
                  {STATUS_LABELS[thread.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </MachineSection>
  );
}
