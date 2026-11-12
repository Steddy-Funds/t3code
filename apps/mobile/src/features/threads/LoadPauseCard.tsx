import {
  loadPauseDeadlineMs,
  loadPauseDescription,
  loadPauseResumeShown,
  loadPriorityControlsShown,
} from "@t3tools/client-runtime/state/loadPause";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { effectiveThreadPriority, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** The mobile sibling of the web load-pause banner; no timeline item, like the usage-limit card. */
export function LoadPauseCard({
  thread,
  environmentId,
  serverConfig,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
  serverConfig: ServerConfig | null;
}) {
  const resumeLoadPause = useAtomCommand(threadEnvironment.resumeLoadPause, {
    reportFailure: false,
  });
  const setPriority = useAtomCommand(threadEnvironment.setPriority, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pause = thread.loadPause;
  if (!loadPauseResumeShown(serverConfig, pause)) return null;
  const offerNormal =
    loadPriorityControlsShown(serverConfig) && effectiveThreadPriority(thread.source) === "low";

  const resume = () => resumeLoadPause({ environmentId, input: { threadId: thread.id } });
  async function run(fallback: string, steps: ReadonlyArray<() => ReturnType<typeof resume>>) {
    setPending(true);
    setError(null);
    for (const step of steps) {
      const result = await step();
      if (AsyncResult.isFailure(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : fallback);
        break;
      }
    }
    setPending(false);
  }

  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      <View className="gap-1">
        <Text className="text-sm font-t3-medium text-foreground">Paused for load</Text>
        <Text className="text-sm text-foreground-muted">
          {loadPauseDescription({
            pause,
            deadline: new Date(loadPauseDeadlineMs(pause)).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            }),
            heldRuns: 0,
          })}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Resume now"
          tone="secondary"
          disabled={pending}
          onPress={() => void run("Could not resume the thread.", [resume])}
        />
        {offerNormal ? (
          <Button
            label="Set priority Normal"
            tone="secondary"
            disabled={pending}
            onPress={() =>
              void run("Could not set priority.", [
                () =>
                  setPriority({
                    environmentId,
                    input: { threadId: thread.id, priority: "normal" },
                  }),
                resume,
              ])
            }
          />
        ) : null}
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
