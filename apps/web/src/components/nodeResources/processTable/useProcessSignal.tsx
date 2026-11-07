import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { type ReactNode, useContext, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  type ProcessKillRequest,
  ProcessKillDialog,
  type ProcessSignalTarget,
} from "./ProcessKillDialog";
import { processIdentityKey } from "./processRows";
import { isProcessChangedRefusal, processSignalChoices } from "./processSignals";

interface ProcessSignal {
  /** Whether this connection may signal processes here; hide or disable Kill without it. */
  readonly canSignal: boolean;
  /** Identity keys with a signal in flight. */
  readonly signalingKeys: ReadonlySet<string>;
  /** Opens the confirm dialog for one process. */
  readonly requestKill: (target: ProcessSignalTarget) => void;
  /** Render once, anywhere under the view. */
  readonly dialog: ReactNode;
}

/**
 * The one kill flow: every signal is confirmed in a dialog, the scope is checked again right before
 * sending, a process is signalled at most once at a time, and failures become a toast. A pid the
 * server finds reused keeps the dialog open to say nothing was sent.
 */
export function useProcessSignal(
  environmentId: EnvironmentId | null,
  options: { readonly onSignaled?: () => void } = {},
): ProcessSignal {
  const registry = useContext(RegistryContext);
  const permissionAtom = serverEnvironment.signalProcess.permissionAtom;
  const canSignal = useAtomValue(permissionAtom(environmentId)) && environmentId !== null;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const choices = processSignalChoices({
    os: config?.environment.platform.os ?? null,
    processSigterm: config?.environment.capabilities.processSigterm === true,
  });
  const sendSignal = useAtomCommand(serverEnvironment.signalProcess, { reportFailure: false });
  const [request, setRequest] = useState<ProcessKillRequest | null>(null);
  const [signalingKeys, setSignalingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const signalingRef = useRef<ReadonlySet<string>>(signalingKeys);

  const setSignaling = (key: string, signaling: boolean) => {
    const next = new Set(signalingRef.current);
    if (signaling) next.add(key);
    else next.delete(key);
    signalingRef.current = next;
    setSignalingKeys(next);
  };

  const requestKill = (target: ProcessSignalTarget) => {
    if (!canSignal || signalingRef.current.has(processIdentityKey(target))) return;
    setRequest({ target, signal: choices[0]!, phase: "confirm" });
  };

  const confirm = () => {
    if (request === null || request.phase !== "confirm" || environmentId === null) return;
    const { target, signal } = request;
    const key = processIdentityKey(target);
    if (signalingRef.current.has(key) || !registry.get(permissionAtom(environmentId))) {
      setRequest(null);
      return;
    }
    setSignaling(key, true);
    setRequest({ ...request, phase: "sending" });
    const fail = (description: string) => {
      setRequest(null);
      toastManager.add({ type: "error", title: `Could not send ${signal}`, description });
    };
    void sendSignal({
      environmentId,
      input: { pid: target.pid, startTimeMs: target.startTimeMs, signal },
    })
      .then((result) => {
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return setRequest(null);
          const error = squashAtomCommandFailure(result);
          return fail(error instanceof Error ? error.message : `Failed to send ${signal}.`);
        }
        const message = Option.getOrNull(result.value.message);
        if (result.value.signaled) {
          setRequest(null);
        } else if (isProcessChangedRefusal(message)) {
          setRequest({ ...request, phase: "changed" });
        } else {
          fail(message ?? `Failed to send ${signal} to process ${target.pid}.`);
        }
        options.onSignaled?.();
      })
      .catch((error: unknown) =>
        fail(error instanceof Error ? error.message : `Failed to send ${signal}.`),
      )
      .finally(() => setSignaling(key, false));
  };

  return {
    canSignal,
    signalingKeys,
    requestKill,
    dialog: (
      <ProcessKillDialog
        request={request}
        choices={choices}
        onSignalChange={(signal) =>
          setRequest((current) => (current === null ? null : { ...current, signal }))
        }
        onConfirm={confirm}
        onClose={() => {
          if (request?.phase !== "sending") setRequest(null);
        }}
      />
    ),
  };
}
