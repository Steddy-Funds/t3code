import { useAtomValue } from "@effect/atom-react";
import type { CodeLibraryRoot, CodeServerStatus, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { codeIntelEnvironment } from "~/state/codeIntel";
import { useAtomCommand } from "~/state/use-atom-command";

const STATE_LABEL: Record<CodeServerStatus["state"], string | null> = {
  ready: null,
  stopped: null,
  starting: "starting",
  indexing: "indexing",
  failed: "failed",
  unavailable: "not installed",
};

const STATE_DOT: Record<CodeServerStatus["state"], string> = {
  ready: "bg-success",
  stopped: "bg-muted-foreground/40",
  starting: "bg-warning",
  indexing: "bg-warning",
  failed: "bg-destructive",
  unavailable: "bg-destructive",
};

/** The language server behind the viewer: its state, and the way to fix it when it is down. */
export function CodeIntelStatusChip(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly server: CodeServerStatus;
  readonly onChanged: () => void;
}) {
  const { server } = props;
  const restart = useAtomCommand(codeIntelEnvironment.restart);
  const install = useAtomCommand(codeIntelEnvironment.installServer);
  const canRestart = useAtomValue(codeIntelEnvironment.restart.permissionAtom(props.environmentId));
  const canInstall = useAtomValue(
    codeIntelEnvironment.installServer.permissionAtom(props.environmentId),
  );
  const [pending, setPending] = useState<"restart" | "install" | null>(null);
  const stateLabel = STATE_LABEL[server.state];

  const run = async (action: "restart" | "install") => {
    setPending(action);
    await (action === "restart"
      ? restart({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, languageId: server.languageId },
        })
      : install({ environmentId: props.environmentId, input: { languageId: server.languageId } }));
    setPending(null);
    props.onChanged();
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="shrink-0"
            aria-label={`${server.name}${stateLabel ? `, ${stateLabel}` : ""}`}
          />
        }
      >
        <span className={cn("size-1.5 rounded-full", STATE_DOT[server.state])} aria-hidden />
        <span>{server.name}</span>
        {stateLabel ? <span className="text-muted-foreground">{stateLabel}</span> : null}
      </PopoverTrigger>
      <PopoverPopup align="end" width="md" padding="compact">
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex items-baseline gap-2">
            <span className="font-medium">{server.name}</span>
            {server.version ? (
              <span className="text-muted-foreground">{server.version}</span>
            ) : null}
            <span className="ms-auto text-muted-foreground">{stateLabel ?? server.state}</span>
          </div>
          {server.message ? <p className="text-muted-foreground">{server.message}</p> : null}
          {server.interpreter ? (
            <p className="break-all text-muted-foreground">
              Interpreter{" "}
              <code className="font-mono text-foreground">{server.interpreter.path}</code>
              {server.interpreter.version ? ` (${server.interpreter.version})` : null}
            </p>
          ) : null}
          {server.libraryRoots.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">Libraries</span>
              {server.libraryRoots.map((root) => (
                <span key={root.path} className="truncate font-mono text-2xs">
                  {root.label}
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            {server.state === "unavailable" && canInstall ? (
              <Button
                type="button"
                size="xs"
                disabled={pending !== null}
                onClick={() => void run("install")}
              >
                {pending === "install" ? "Installing…" : `Install ${server.name}`}
              </Button>
            ) : null}
            {server.state !== "unavailable" && server.state !== "stopped" && canRestart ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={pending !== null}
                onClick={() => void run("restart")}
              >
                {pending === "restart" ? "Restarting…" : "Restart"}
              </Button>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function LibraryCodeNotice(props: { readonly root: CodeLibraryRoot | null }) {
  return (
    <div className="shrink-0 border-b px-3 py-1.5 text-2xs text-muted-foreground">
      {props.root === null ? "Library code" : `Library code from ${props.root.label}`}. Read-only.
    </div>
  );
}
