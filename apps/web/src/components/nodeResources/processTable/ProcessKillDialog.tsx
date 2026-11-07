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
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";

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
  readonly signal: ServerProcessSignal;
  readonly phase: ProcessKillPhase;
}

const SIGNAL_HINTS: Partial<Record<ServerProcessSignal, string>> = {
  SIGKILL: "SIGKILL can't be caught",
};

/** Confirms a kill, with the signal switch; after a refused recheck, says nothing was sent. */
export function ProcessKillDialog({
  request,
  choices,
  onSignalChange,
  onConfirm,
  onClose,
}: {
  readonly request: ProcessKillRequest | null;
  readonly choices: ReadonlyArray<ServerProcessSignal>;
  readonly onSignalChange: (signal: ServerProcessSignal) => void;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}) {
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
            {choices.length > 1 ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">Signal</span>
                <ToggleGroup
                  aria-label="Signal"
                  variant="segmented"
                  value={[request.signal]}
                  onValueChange={(next) => {
                    const picked = choices.find((signal) => signal === next[0]);
                    if (picked) onSignalChange(picked);
                  }}
                >
                  {choices.map((signal) => (
                    <ToggleGroupItem key={signal} value={signal}>
                      {signal}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                {SIGNAL_HINTS[request.signal] ? (
                  <span className="text-muted-foreground">{SIGNAL_HINTS[request.signal]}</span>
                ) : null}
              </div>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button
                variant="destructive"
                disabled={request.phase === "sending"}
                onClick={onConfirm}
              >
                Kill
              </Button>
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
