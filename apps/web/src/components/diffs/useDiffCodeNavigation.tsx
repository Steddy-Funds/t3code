import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { CodeLocation, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { fileContentRevision } from "@t3tools/shared/fileContentRevision";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
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
import { useStableCallback } from "~/hooks/useStableCallback";
import { resolveFileDiffPath } from "~/lib/diffRendering";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { codeIntelEnvironment } from "~/state/codeIntel";

import type { DiffCodeViewTokenActivate } from "./useCodeViewTokenNavigation";

const WAITING_HINT_DELAY_MS = 500;

export const NOT_CURRENT_VERSION = "Navigation works on the current version of this file";
export const OUTSIDE_PROJECT = "Navigation works on files in this project";

export interface DiffCodeNavigationContext {
  readonly environmentId: EnvironmentId;
  /** The workspace the language servers run in. */
  readonly cwd: string;
  readonly repositoryRoot: string | undefined;
  readonly threadRef: ScopedThreadRef;
}

/** A Cmd- or Ctrl-click on a token of a diff, or Go to Declaration's key at its caret. */
export interface DiffTokenActivation {
  readonly side: "deletions" | "additions";
  /** File line number, 1-based. */
  readonly line: number;
  /** Zero-based UTF-16 column in that line. */
  readonly character: number;
  /**
   * The content revision of the side's text; null when it is not a whole file. A promise while
   * the whole file is still being read.
   */
  readonly revision: string | null | Promise<string | null>;
  /** The token, or the caret's line, for a popup to point at. */
  readonly anchor: Element;
}

type DiffNavigationPopup =
  | CodePopup
  | {
      readonly kind: "notCurrent";
      readonly anchor: CodePopupAnchor;
      readonly filePath: string;
      readonly line: number | undefined;
    };

/** Rows leave the DOM as the view scrolls; the popup stays where the token was. */
function anchorOf(element: Element): CodePopupAnchor {
  let last: DOMRect | null = null;
  return {
    getBoundingClientRect: () => {
      if (element.isConnected) last = element.getBoundingClientRect();
      return last ?? new DOMRect();
    },
  };
}

const wholeFileRevisions = new WeakMap<
  FileDiffMetadata,
  Promise<{ readonly deletions: string; readonly additions: string } | null>
>();

/**
 * The revision of a diff side's text as a whole file, for the server to compare with the file on
 * disk. A patch's hunks have one once the whole files are read, which is done once per diff.
 */
export function diffSideRevision(
  fileDiff: FileDiffMetadata,
  side: DiffTokenActivation["side"],
  loadWholeFiles: FileDiffContentsLoader | undefined,
): string | null | Promise<string | null> {
  if (!fileDiff.isPartial) {
    return fileContentRevision(
      (side === "deletions" ? fileDiff.deletionLines : fileDiff.additionLines).join(""),
    );
  }
  if (loadWholeFiles === undefined) return null;
  let revisions = wholeFileRevisions.get(fileDiff);
  if (revisions === undefined) {
    revisions = loadWholeFiles(fileDiff).then(
      (files) => ({
        deletions: fileContentRevision((files.oldFile ?? files.newFile).contents),
        additions: fileContentRevision(files.newFile.contents),
      }),
      () => null,
    );
    wholeFileRevisions.set(fileDiff, revisions);
  }
  return revisions.then((revision) => revision?.[side] ?? null);
}

/**
 * Go to Declaration from a diff, through the file viewer's navigation. Only a side whose text is
 * the file on disk now is asked about; any other offers the file instead. A lookup lasts as long
 * as `scope`, what the view shows (null when it is gone).
 */
export function useDiffCodeNavigation(
  context: DiffCodeNavigationContext | null,
  scope: string | null,
  onOpenFile: (filePath: string, line?: number) => void,
  loadWholeFiles?: FileDiffContentsLoader,
) {
  const [popup, setPopup] = useState<DiffNavigationPopup | null>(null);
  const request = useRef<{ seq: number; controller: AbortController | null }>({
    seq: 0,
    controller: null,
  });

  const cancel = useStableCallback(() => {
    request.current.seq += 1;
    request.current.controller?.abort();
    request.current.controller = null;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a lookup still in flight when its file or the diff goes is aborted
  useEffect(
    () => () => {
      cancel();
      setPopup(null);
    },
    [
      // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Another file or diff in the view ends the lookup asked from the one before.
      scope,
      cancel,
    ],
  );

  const activate = async (
    { environmentId, cwd, repositoryRoot, threadRef }: DiffCodeNavigationContext,
    activation: DiffTokenActivation,
    filePath: string,
  ) => {
    cancel();
    const seq = request.current.seq;
    const isCurrent = () => request.current.seq === seq;
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
    const waiting = window.setTimeout(() => {
      if (isCurrent()) hint(waitingMessage(null));
    }, WAITING_HINT_DELAY_MS);
    const revision = await activation.revision;
    if (!isCurrent()) return window.clearTimeout(waiting);
    if (revision === null) {
      window.clearTimeout(waiting);
      return notCurrent();
    }
    const controller = new AbortController();
    request.current.controller = controller;
    const result = await executeAtomQuery(
      appAtomRegistry,
      codeIntelEnvironment.definition({
        environmentId,
        input: {
          document: { cwd, path, ifRevision: revision },
          position: { line: activation.line - 1, character: activation.character },
          kind: "definition",
        },
      }),
      { refresh: true, reportFailure: false, reportDefect: false, signal: controller.signal },
    );
    window.clearTimeout(waiting);
    if (!isCurrent()) return;
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
        const { locations } = outcome.value;
        if (outcome.value.revision !== revision) return notCurrent();
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

  const onCodeViewTokenActivate: DiffCodeViewTokenActivate = (target, fileDiff) => {
    if (context === null) return;
    const revision = diffSideRevision(fileDiff, target.side, loadWholeFiles);
    void activate(context, { ...target, revision }, resolveFileDiffPath(fileDiff));
  };

  return {
    onTokenActivate:
      context === null
        ? undefined
        : (activation: DiffTokenActivation, filePath: string) =>
            void activate(context, activation, filePath),
    onCodeViewTokenActivate: context === null ? undefined : onCodeViewTokenActivate,
    popup: popupNode,
  };
}
