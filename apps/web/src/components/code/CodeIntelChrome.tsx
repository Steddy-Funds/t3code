import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type CodeLibraryRoot,
  type CodeServerStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { codeIntelEnvironment } from "~/state/codeIntel";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

const SHOWN_LIBRARY_ROOTS = 4;

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

/** The virtualenv or interpreter set for this workspace; empty finds one from the files. */
function PythonEnvironmentField(props: {
  readonly saved: string;
  readonly detected: string | undefined;
  readonly busy: boolean;
  readonly applying: boolean;
  readonly onApply: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.saved);
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        props.onApply(draft.trim());
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">Python environment</span>
        <Input
          size="compact"
          className="font-mono"
          value={draft}
          placeholder={
            props.saved ? "Find one from the project's files" : (props.detected ?? "None found")
          }
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-2xs text-muted-foreground">
          {props.saved
            ? "Set here. Clear it to find one again."
            : "Found from the project's files."}
        </span>
        <Button
          type="submit"
          variant="outline"
          size="xs"
          disabled={props.busy || draft.trim() === props.saved}
        >
          {props.applying ? "Applying…" : "Apply"}
        </Button>
      </div>
    </form>
  );
}

/** The language server behind the viewer: its state, and the way to fix it when it is down. */
export function CodeIntelStatusChip(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly server: CodeServerStatus;
  /** Turned off in the environment's settings. */
  readonly turnedOff: boolean;
  readonly onChanged: () => void;
}) {
  const { server, turnedOff } = props;
  const restart = useAtomCommand(codeIntelEnvironment.restart);
  const install = useAtomCommand(codeIntelEnvironment.installServer);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const canRestart = useAtomValue(codeIntelEnvironment.restart.permissionAtom(props.environmentId));
  const canInstall = useAtomValue(
    codeIntelEnvironment.installServer.permissionAtom(props.environmentId),
  );
  const canWriteSettings = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const savedEnvironment =
    useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId))?.codeIntel
      .pythonEnvironments[props.cwd] ?? "";
  const [pending, setPending] = useState<"restart" | "install" | "turnOn" | "environment" | null>(
    null,
  );
  const [allLibraries, setAllLibraries] = useState(false);
  const stateLabel = turnedOff ? "off" : STATE_LABEL[server.state];
  const libraryRoots = allLibraries
    ? server.libraryRoots
    : server.libraryRoots.slice(0, SHOWN_LIBRARY_ROOTS);

  const actions = {
    restart: () =>
      restart({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, languageId: server.languageId },
      }),
    install: () =>
      install({ environmentId: props.environmentId, input: { languageId: server.languageId } }),
    turnOn: () =>
      updateSettings({
        environmentId: props.environmentId,
        input: { patch: { codeIntel: { enabled: true } } },
      }),
  };
  const run = async (action: keyof typeof actions) => {
    setPending(action);
    await actions[action]();
    setPending(null);
    props.onChanged();
  };
  // A running server keeps the environment it started with; a restart locates it again.
  const applyEnvironment = async (environment: string) => {
    setPending("environment");
    const saved = await updateSettings({
      environmentId: props.environmentId,
      input: { patch: { codeIntel: { pythonEnvironments: { [props.cwd]: environment } } } },
    });
    if (saved._tag === "Success" && canRestart) await actions.restart();
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
        <span
          className={cn("size-1.5 rounded-full", STATE_DOT[turnedOff ? "stopped" : server.state])}
          aria-hidden
        />
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
          {turnedOff ? (
            <div className="flex items-center gap-2">
              <p className="flex-1 text-muted-foreground">
                {canWriteSettings
                  ? "Code intelligence is turned off in this environment's settings."
                  : "Code intelligence is turned off in this environment's settings, and this connection can't change them."}
              </p>
              {canWriteSettings ? (
                <Button
                  type="button"
                  size="xs"
                  className="shrink-0"
                  disabled={pending !== null}
                  onClick={() => void run("turnOn")}
                >
                  {pending === "turnOn" ? "Turning on…" : "Turn on"}
                </Button>
              ) : null}
            </div>
          ) : server.message ? (
            <p className="text-muted-foreground">{server.message}</p>
          ) : null}
          {server.interpreter ? (
            <p className="break-all text-muted-foreground">
              Interpreter{" "}
              <code className="font-mono text-foreground">{server.interpreter.path}</code>
              {server.interpreter.version ? ` (${server.interpreter.version})` : null}
            </p>
          ) : null}
          {server.languageId === "python" && canWriteSettings && !turnedOff ? (
            <PythonEnvironmentField
              saved={savedEnvironment}
              detected={server.interpreter?.path}
              busy={pending !== null}
              applying={pending === "environment"}
              onApply={(environment) => void applyEnvironment(environment)}
            />
          ) : null}
          {server.libraryRoots.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground">Libraries</span>
              {libraryRoots.map((root) => (
                <span key={root.path} className="truncate font-mono text-2xs">
                  {root.label}
                </span>
              ))}
              {libraryRoots.length < server.libraryRoots.length ? (
                <button
                  type="button"
                  className="self-start text-2xs text-muted-foreground hover:text-foreground"
                  onClick={() => setAllLibraries(true)}
                >
                  {server.libraryRoots.length - libraryRoots.length} more
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            {server.state === "unavailable" && !turnedOff && canInstall ? (
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
