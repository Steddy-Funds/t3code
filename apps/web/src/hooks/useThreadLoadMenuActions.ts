import {
  loadPauseResumeShown,
  loadPriorityControlsShown,
  threadPriorityChoice,
} from "@t3tools/client-runtime/state/loadPause";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  effectiveThreadPriority,
  type OrchestrationV2LoadPause,
  type ScopedThreadRef,
  type ServerConfig,
  type ThreadPriority,
} from "@t3tools/contracts";

import type {
  ThreadActionMenuId,
  ThreadActionMenuState,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

const PRIORITY_BY_ACTION: Partial<Record<ThreadActionMenuId, ThreadPriority | "default">> = {
  "priority:low": "low",
  "priority:normal": "normal",
  "priority:default": "default",
};

/** The Priority and Resume now inputs of a thread action menu. */
export function threadLoadMenuState(
  serverConfig: Pick<ServerConfig, "environment" | "settings"> | null | undefined,
  thread: {
    readonly source: { readonly tags?: ReadonlyArray<string> | undefined };
    readonly loadPause?: OrchestrationV2LoadPause | null | undefined;
  },
): Pick<ThreadActionMenuState, "priority" | "loadPaused"> {
  return {
    priority: loadPriorityControlsShown(serverConfig)
      ? {
          choice: threadPriorityChoice(thread.source),
          effective: effectiveThreadPriority(thread.source),
        }
      : undefined,
    loadPaused: loadPauseResumeShown(serverConfig, thread.loadPause),
  };
}

/** Runs a Priority or Resume now menu action; false when `action` is neither. */
export function useThreadLoadMenuActions() {
  const setThreadPriority = useOrchestrationCommand(threadEnvironment.setPriority, {
    reportFailure: false,
  });
  const resumeLoadPause = useOrchestrationCommand(threadEnvironment.resumeLoadPause, {
    reportFailure: false,
  });
  return async (action: ThreadActionMenuId, threadRef: ScopedThreadRef): Promise<boolean> => {
    const priority = PRIORITY_BY_ACTION[action];
    if (priority === undefined && action !== "resume-load-pause") return false;
    const input = { threadId: threadRef.threadId };
    const result =
      priority === undefined
        ? await resumeLoadPause({ environmentId: threadRef.environmentId, input })
        : await setThreadPriority({
            environmentId: threadRef.environmentId,
            input: { ...input, priority },
          });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: priority === undefined ? "Failed to resume thread" : "Failed to set priority",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
    return true;
  };
}
