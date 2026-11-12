import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { CodeLocation, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { fileExtension } from "~/components/code/codeLanguages";
import {
  codeIntelFailureMessage,
  noResultMessage,
  waitingMessage,
} from "~/components/code/codeNavigationMessages";
import { codeIntelOutcome } from "~/components/code/codeNavigationModel";
import {
  type CodePopup,
  type CodePopupAnchor,
  CodeNavigationPopup,
} from "~/components/code/CodeNavigationPopup";
import { navigateToCodeLocation } from "~/components/code/navigation";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { resolveDiffPathForWorkspace } from "~/diffFileActions";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { codeIntelEnvironment } from "~/state/codeIntel";

import type { SbsTokenActivation } from "./SideBySideDiffView";

const WAITING_HINT_DELAY_MS = 500;

export const NOT_CURRENT_VERSION = "Navigation works on the current version of this file";
export const OUTSIDE_PROJECT = "Navigation works on files in this project";

export interface SbsCodeNavigationContext {
  readonly environmentId: EnvironmentId;
  /** The workspace the language servers run in. */
  readonly cwd: string;
  readonly repositoryRoot: string | undefined;
  readonly threadRef: ScopedThreadRef;
}

type SbsNavigationPopup =
  | CodePopup
  | {
      readonly kind: "notCurrent";
      readonly anchor: CodePopupAnchor;
      readonly filePath: string;
      readonly line: number | undefined;
    };

/** Rows leave the DOM as the panes scroll; the popup stays where the token was. */
function anchorOf(element: Element): CodePopupAnchor {
  let last: DOMRect | null = null;
  return {
    getBoundingClientRect: () => {
      if (element.isConnected) last = element.getBoundingClientRect();
      return last ?? new DOMRect();
    },
  };
}

/**
 * Go to Declaration from a side-by-side pane, through the file viewer's navigation. A pane's text
 * is asked about only when it is the file on disk now: an older version, or a patch's hunks, says
 * so and offers the file instead. A lookup lasts as long as `shownFile`, the file the panes show
 * (null when they are gone).
 */
export function useSbsCodeNavigation(
  context: SbsCodeNavigationContext | null,
  shownFile: string | null,
  onOpenFile: (filePath: string, line?: number) => void,
) {
  const [popup, setPopup] = useState<SbsNavigationPopup | null>(null);
  const request = useRef<{ seq: number; controller: AbortController | null }>({
    seq: 0,
    controller: null,
  });

  const cancel = () => {
    request.current.seq += 1;
    request.current.controller?.abort();
    request.current.controller = null;
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a lookup still in flight when its file or the diff goes is aborted
  useEffect(
    () => () => {
      cancel();
      setPopup(null);
    },
    [shownFile],
  );

  const activate = async (
    { environmentId, cwd, repositoryRoot, threadRef }: SbsCodeNavigationContext,
    activation: SbsTokenActivation,
    filePath: string,
  ) => {
    cancel();
    const seq = request.current.seq;
    const anchor = anchorOf(activation.anchor);
    const hint = (message: string) => setPopup({ kind: "hint", anchor, message });
    const notCurrent = () =>
      setPopup({
        kind: "notCurrent",
        anchor,
        filePath,
        // The old side's lines are not the file's lines on disk.
        line: activation.side === "additions" ? activation.line : undefined,
      });
    const path = resolveDiffPathForWorkspace({ filePath, workspaceRoot: cwd, repositoryRoot });
    if (path === null) return hint(OUTSIDE_PROJECT);
    if (activation.revision === null) return notCurrent();
    const controller = new AbortController();
    request.current.controller = controller;
    const waiting = window.setTimeout(() => {
      if (request.current.seq === seq) hint(waitingMessage(null));
    }, WAITING_HINT_DELAY_MS);
    const result = await executeAtomQuery(
      appAtomRegistry,
      codeIntelEnvironment.definition({
        environmentId,
        input: {
          document: { cwd, path, ifRevision: activation.revision },
          position: { line: activation.line - 1, character: activation.character },
          kind: "definition",
        },
      }),
      { refresh: true, reportFailure: false, reportDefect: false, signal: controller.signal },
    );
    window.clearTimeout(waiting);
    if (request.current.seq !== seq) return;
    request.current.controller = null;
    const outcome = codeIntelOutcome(result);
    switch (outcome._tag) {
      case "interrupted":
        return;
      case "unsupported":
        return setPopup(null);
      case "defect":
        return hint(outcome.message);
      case "failed":
        if (outcome.reason === "stale_document") return notCurrent();
        return hint(
          codeIntelFailureMessage(outcome.reason, outcome.message, {
            extension: fileExtension(path),
            server: null,
          }),
        );
      case "answer": {
        const { locations, revision } = outcome.value;
        if (revision !== activation.revision) return notCurrent();
        if (locations.length === 0) return hint(noResultMessage("declaration"));
        if (locations.length === 1) {
          setPopup(null);
          return navigateToCodeLocation(threadRef, locations[0]!);
        }
        return setPopup({
          kind: "locations",
          anchor,
          title: "Choose a target",
          note: null,
          locations,
        });
      }
    }
  };

  const close = () => {
    cancel();
    setPopup(null);
  };

  const openLocation = (location: CodeLocation) => {
    setPopup(null);
    if (context) navigateToCodeLocation(context.threadRef, location);
  };

  const popupNode: ReactNode =
    popup === null || context === null ? null : popup.kind === "notCurrent" ? (
      <Popover
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <PopoverPopup
          anchor={popup.anchor}
          side="bottom"
          align="start"
          padding="none"
          initialFocus={false}
          finalFocus={false}
        >
          <div className="flex max-w-96 items-center gap-3 px-3 py-2 text-xs">
            <p role="status">{NOT_CURRENT_VERSION}</p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                close();
                onOpenFile(popup.filePath, popup.line);
              }}
            >
              Open file
            </Button>
          </div>
        </PopoverPopup>
      </Popover>
    ) : (
      <CodeNavigationPopup
        popup={popup}
        cwd={context.cwd}
        onClose={close}
        onOpenLocation={openLocation}
        onGoToPosition={close}
      />
    );

  return {
    onTokenActivate:
      context === null
        ? undefined
        : (activation: SbsTokenActivation, filePath: string) =>
            void activate(context, activation, filePath),
    popup: popupNode,
  };
}
