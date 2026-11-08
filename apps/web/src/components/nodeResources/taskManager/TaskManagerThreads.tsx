import { useAtomValue } from "@effect/atom-react";
import { loadPriorityControlsShown } from "@t3tools/client-runtime/state/loadPause";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { serverEnvironment } from "~/state/server";
import { MachineSection } from "../primitives/MachineSection";
import { LOAD_PAUSED_LABEL, RUNNING_STATUS_LABELS, runningThreadsAtom } from "../runningThreads";

/** The T3 threads running on this machine; a row opens the thread. */
export function TaskManagerThreads({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const threads = useAtomValue(runningThreadsAtom(environmentId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const showPriority = loadPriorityControlsShown(config);
  const running = threads.filter((thread) => !thread.loadPaused).length;
  const paused = threads.length - running;
  return (
    <MachineSection
      title="Threads on this machine"
      detail={paused === 0 ? `${running} running` : `${running} running, ${paused} paused`}
    >
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
                {showPriority ? (
                  <span className="w-14 shrink-0 text-muted-foreground" aria-label="Priority">
                    {thread.priority === "low" ? "Low" : "Normal"}
                  </span>
                ) : null}
                <span
                  className={
                    thread.loadPaused
                      ? "shrink-0 text-warning-foreground"
                      : "shrink-0 text-muted-foreground"
                  }
                >
                  {thread.loadPaused ? LOAD_PAUSED_LABEL : RUNNING_STATUS_LABELS[thread.status]}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </MachineSection>
  );
}
