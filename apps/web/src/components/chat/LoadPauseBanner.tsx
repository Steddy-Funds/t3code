import { loadPauseDeadlineMs, loadPauseDescription } from "@t3tools/client-runtime/state/loadPause";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2LoadPause, ThreadId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { PauseIcon } from "lucide-react";
import { useState } from "react";

import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export const LOAD_PAUSE_TITLE = "Paused for load";

/** Resume now, and "Set priority Normal" (which also resumes) for a low-priority thread. */
export function useLoadPauseActions(environmentId: EnvironmentId, threadId: ThreadId) {
  const resumeLoadPause = useOrchestrationCommand(threadEnvironment.resumeLoadPause, {
    reportFailure: false,
  });
  const setPriority = useOrchestrationCommand(threadEnvironment.setPriority, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const run = async (
    title: string,
    steps: ReadonlyArray<() => ReturnType<typeof resumeLoadPause>>,
  ) => {
    setPending(true);
    for (const step of steps) {
      const result = await step();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title,
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        break;
      }
    }
    setPending(false);
  };
  const resume = () => resumeLoadPause({ environmentId, input: { threadId } });
  return {
    pending,
    resume: () => run("Could not resume thread", [resume]),
    // A normal-priority thread is never paused, so it would otherwise wait out the pause.
    setNormal: () =>
      run("Could not set priority", [
        () => setPriority({ environmentId, input: { threadId, priority: "normal" } }),
        resume,
      ]),
  };
}

export function LoadPauseActions(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  offerNormal: boolean;
}) {
  const { pending, resume, setNormal } = useLoadPauseActions(props.environmentId, props.threadId);
  return (
    <>
      {props.offerNormal ? (
        <Button size="xs" variant="ghost" disabled={pending} onClick={() => void setNormal()}>
          Set priority Normal
        </Button>
      ) : null}
      <Button size="xs" variant="ghost" disabled={pending} onClick={() => void resume()}>
        Resume now
      </Button>
    </>
  );
}

export function loadPauseBannerItem(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  pause: OrchestrationV2LoadPause;
  heldRuns: number;
  offerNormal: boolean;
  timestampFormat: TimestampFormat;
}): ComposerBannerStackItem {
  const { pause } = props;
  return {
    id: `load-pause:${pause.episodeId}:${pause.runId}`,
    variant: "warning",
    icon: <PauseIcon />,
    title: LOAD_PAUSE_TITLE,
    description: loadPauseDescription({
      pause,
      deadline: formatUpcomingTimestamp(
        new Date(loadPauseDeadlineMs(pause)).toISOString(),
        props.timestampFormat,
      ),
      heldRuns: props.heldRuns,
    }),
    actions: (
      <LoadPauseActions
        environmentId={props.environmentId}
        threadId={props.threadId}
        offerNormal={props.offerNormal}
      />
    ),
  };
}
