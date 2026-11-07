import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Schema } from "effect";
import { XIcon } from "lucide-react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "~/appearanceFonts";
import { Button } from "~/components/ui/button";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { serverEnvironment } from "~/state/server";
import { terminalEnvironment } from "~/state/terminal";
import { useAtomCommand } from "~/state/use-atom-command";

import { TerminalViewport } from "../../ThreadTerminalDrawer";
import { MachineSection } from "../primitives/MachineSection";

/** Not a real thread: the server keys PTYs by thread, so the machine terminal gets its own id. */
export const MACHINE_TERMINAL_THREAD_ID = ThreadId.make("machine-terminal");
export const MACHINE_TERMINAL_ID = "default";

/**
 * A shell in the server user's home directory. Hide only detaches: the PTY keeps running and the
 * next visit attaches again. End session closes the PTY.
 */
export function TaskManagerTerminal({
  environmentId,
  autoFocus,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  /** Only when the user opened it; a shell reattached on a visit leaves focus alone. */
  readonly autoFocus: boolean;
  readonly onClose: () => void;
}) {
  const closeTerminal = useAtomCommand(terminalEnvironment.close, "terminal close");
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const cwd = config?.homeDirectory ?? config?.cwd ?? null;
  if (config === null || cwd === null) return null;
  return (
    <MachineSection
      title="Terminal"
      detail={cwd}
      actions={
        <>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              void closeTerminal({
                environmentId,
                input: {
                  threadId: MACHINE_TERMINAL_THREAD_ID,
                  terminalId: MACHINE_TERMINAL_ID,
                  deleteHistory: true,
                },
              });
              onClose();
            }}
          >
            End session
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Hide terminal" onClick={onClose}>
            <XIcon />
          </Button>
        </>
      }
    >
      <div className="h-72">
        <TerminalViewport
          threadRef={{ environmentId, threadId: MACHINE_TERMINAL_THREAD_ID }}
          threadId={MACHINE_TERMINAL_THREAD_ID}
          terminalId={MACHINE_TERMINAL_ID}
          terminalLabel="Machine terminal"
          cwd={cwd}
          advancedTypography={advancedTypography}
          onSessionExited={onClose}
          autoFocus={autoFocus}
          visible
          keybindings={config.keybindings}
        />
      </div>
    </MachineSection>
  );
}
