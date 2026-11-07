import type { ServerProcessSignal } from "@t3tools/contracts";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";

export interface ProcessSignalTarget {
  readonly pid: number;
  readonly startTimeMs: number;
  readonly name: string;
  readonly command: string;
  /** Live values at the moment Kill was pressed, such as "0.2% CPU · 120 MB". */
  readonly summary?: string;
  readonly childCount?: number;
}

type ProcessKillPhase = "confirm" | "sending" | "changed";

export interface ProcessKillRequest {
  readonly target: ProcessSignalTarget;
  readonly phase: ProcessKillPhase;
}

/**
 * Confirms a kill: "Kill" sends the polite signal (the first choice), "Force kill" sends SIGKILL
 * when it is a separate choice. After a refused recheck, says nothing was sent.
 */
export function ProcessKillDialog({
  request,
  choices,
  onConfirm,
  onClose,
}: {
  readonly request: ProcessKillRequest | null;
  readonly choices: ReadonlyArray<ServerProcessSignal>;
  readonly onConfirm: (signal: ServerProcessSignal) => void;
  readonly onClose: () => void;
}) {
  const [kill, forceKill] = choices;
  const target = request?.target;
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogPopup>
        {request === null || target === undefined ? null : request.phase === "changed" ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Process changed</AlertDialogTitle>
              <AlertDialogDescription>
                PID {target.pid} no longer belongs to <code>{target.name}</code>. Nothing was sent.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Close</AlertDialogClose>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Kill <code>{target.name}</code> (PID {target.pid})?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Only this process is signalled.
                {target.childCount ? ` It has ${childCountLabel(target.childCount)}.` : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex min-w-0 flex-col gap-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <span className="truncate font-mono text-muted-foreground">{target.command}</span>
              {target.summary ? <span className="tabular-nums">{target.summary}</span> : null}
            </div>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              {forceKill ? (
                <Button
                  variant="destructive-outline"
                  disabled={request.phase === "sending"}
                  onClick={() => onConfirm(forceKill)}
                >
                  Force kill
                </Button>
              ) : null}
              {kill ? (
                <Button
                  variant="destructive"
                  disabled={request.phase === "sending"}
                  onClick={() => onConfirm(kill)}
                >
                  Kill
                </Button>
              ) : null}
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function childCountLabel(count: number): string {
  return count === 1
    ? "1 child process, which usually ends with it"
    : `${count} child processes, which usually end with it`;
}
