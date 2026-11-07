import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { MachineSection } from "../primitives/MachineSection";
import { RUNNING_STATUS_LABELS, runningThreadsAtom } from "../runningThreads";

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
                  {RUNNING_STATUS_LABELS[thread.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </MachineSection>
  );
}
