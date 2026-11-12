import {
  parseDiffFromFile,
  type FileDiffContentsLoader,
  type FileDiffLoadedFiles,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useEffect, useState, type ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  classifyDiffFileContentsFailure,
  type DiffFileContentsFailure,
} from "~/lib/diffFileContents";

import { DiffFilePathCopyButton } from "../../DiffFilePathCopyButton";
import { fileContentRevision } from "@t3tools/shared/fileContentRevision";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { DiffPanelLoadingState } from "../../DiffPanelShell";
import { StartTruncatedPath } from "../../StartTruncatedPath";
import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { SbsBar } from "./SbsToolbar";
import {
  type SbsTokenActivation,
  SideBySideDiffView,
  type SideBySideDiffViewProps,
} from "./SideBySideDiffView";
import type { SbsNavigationDirection } from "./sbsNavigation";

const COLLAPSE_UNCHANGED_STORAGE_KEY = "t3code.sbsDiff.collapseUnchanged";
const HIGHLIGHT_MODE_STORAGE_KEY = "t3code.sbsDiff.highlightMode";
const HighlightMode = Schema.Literals(["words", "lines", "none"]);

/** Narrower than this, two panes and their divider leave too little of each line to read. */
export const SIDE_BY_SIDE_MIN_WIDTH = 520;

export interface SbsFileEntry {
  readonly fileKey: string;
  readonly filePath: string;
  /** The file as its patch describes it: its name, its kind of change and its hunks. */
  readonly fileDiff: FileDiffMetadata;
}

export interface SbsPatchState {
  /** The file's own patch has not arrived, so its kind of change is not known yet. */
  readonly pending: boolean;
  readonly error: boolean;
  readonly truncated: boolean;
}

export interface SideBySideDiffPanelProps {
  /** The changed files, in the order stepping between files follows. */
  readonly files: ReadonlyArray<SbsFileEntry>;
  /** The file shown; the first one when this names none of them. */
  readonly selectedFileKey: string | null;
  readonly onSelectFile: (fileKey: string) => void;
  /** Reads both sides of a file whole. Absent where this selection or connection cannot. */
  readonly loadFileContents?: FileDiffContentsLoader | undefined;
  /** Names the selection the files belong to: a file of another one is never shown. */
  readonly scopeKey: string;
  /** Names the state of that selection's diff: when it changes, the file is read again. */
  readonly contentsKey: string;
  readonly ignoreWhitespace: boolean;
  readonly patchState: (filePath: string) => SbsPatchState;
  readonly onRequestPatch: (filePath: string) => void;
  readonly onRetryPatch: (filePath: string) => void;
  /** Absent where the files are not on this machine to open. */
  readonly onOpenFile?: ((filePath: string, line?: number) => void) | undefined;
  /** The project's root: a path under it shows relative to it, as an agent's edit records it absolute. */
  readonly workspaceRoot?: string | undefined;
  /** Go to Declaration in the file shown: a Cmd+click on a token, or its key at the caret. */
  readonly onTokenActivate?:
    | ((activation: SbsTokenActivation, filePath: string) => void)
    | undefined;
  /**
   * Renders the view. A caller that adds comments or navigation wraps `SideBySideDiffView`
   * here and passes its annotation and selection props; nothing else reaches inside the view.
   * `entry` is the file shown; `props.fileDiff` is that file as the view has it.
   */
  readonly renderView?: (props: SideBySideDiffViewProps, entry: SbsFileEntry) => ReactNode;
}

type LoadOutcome =
  | {
      readonly kind: "loaded";
      readonly files: FileDiffLoadedFiles;
      /** Names both texts: a reload that brings the same ones keeps the view as it is. */
      readonly revision: string;
    }
  | { readonly kind: "failed"; readonly failure: DiffFileContentsFailure };

interface LoadedFile {
  /** The selection and file the outcome is of. */
  readonly fileId: string;
  /** The load that produced it; an older one stays on screen while a newer one runs. */
  readonly loadKey: string;
  readonly outcome: LoadOutcome;
}

interface WholeFileDiff {
  readonly fileDiff: FileDiffMetadata;
  /** Why there is nothing to step through, when there is not. */
  readonly sameness: "identical" | "ignored" | null;
}

const wholeFileDiffs = new WeakMap<FileDiffLoadedFiles, Map<string, WholeFileDiff | null>>();

/** The diff of two whole files, kept per loaded pair so its identity holds across renders. */
function wholeFileDiffOf(
  files: FileDiffLoadedFiles,
  patch: FileDiffMetadata,
  ignoreWhitespace: boolean,
): WholeFileDiff | null {
  const key = `${patch.type}:${ignoreWhitespace}`;
  let cache = wholeFileDiffs.get(files);
  if (!cache) wholeFileDiffs.set(files, (cache = new Map()));
  if (cache.has(key)) return cache.get(key) ?? null;
  // A pure rename loads one file: both sides hold the same text.
  const oldFile = files.oldFile ?? { ...files.newFile, name: patch.prevName ?? files.newFile.name };
  let result: WholeFileDiff | null;
  try {
    const fileDiff = parseDiffFromFile(
      patch.type === "new" ? null : oldFile,
      patch.type === "deleted" ? null : files.newFile,
      { ignoreWhitespace },
    );
    result = {
      // Pierre names both sides alike; the patch knows a rename.
      fileDiff: patch.prevName ? { ...fileDiff, prevName: patch.prevName } : fileDiff,
      sameness:
        fileDiff.hunks.length > 0
          ? null
          : oldFile.contents === files.newFile.contents
            ? "identical"
            : "ignored",
    };
  } catch {
    result = null;
  }
  cache.set(key, result);
  return result;
}

export function SbsNotice({ children }: { children: ReactNode }) {
  return (
    <p className="flex shrink-0 items-center gap-2 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
      {children}
    </p>
  );
}

function Message({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 text-center text-xs text-muted-foreground/70">
      {children}
    </div>
  );
}

export function SideBySideDiffPanel(props: SideBySideDiffPanelProps) {
  const {
    files,
    loadFileContents,
    scopeKey,
    contentsKey,
    ignoreWhitespace,
    onOpenFile,
    onTokenActivate,
  } = props;
  const [collapseUnchanged, setCollapseUnchanged] = useLocalStorage(
    COLLAPSE_UNCHANGED_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const [highlightMode, setHighlightMode] = useLocalStorage(
    HIGHLIGHT_MODE_STORAGE_KEY,
    "words",
    HighlightMode,
  );
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Set when the file was reached by stepping, which says where to land and to keep the keys.
  const [arrival, setArrival] = useState<{ fileKey: string; from: SbsNavigationDirection } | null>(
    null,
  );
  // A file too large to compare whole, opened as its patch on request.
  const [patchOnlyKey, setPatchOnlyKey] = useState<string | null>(null);

  const index = Math.max(
    0,
    files.findIndex((file) => file.fileKey === props.selectedFileKey),
  );
  const entry = files[index];
  const filePath = entry?.filePath ?? "";
  const patch = entry?.fileDiff;
  const patchState = entry ? props.patchState(filePath) : null;
  const patchPending = patchState?.pending === true;
  const shownPath = (path: string) => {
    const relative = workspaceRelativeFilePath(path, props.workspaceRoot);
    return relative === null || relative === "." ? path : relative;
  };
  const fileId = entry ? `${scopeKey}:${entry.fileKey}` : null;
  const loadKey = fileId === null ? null : `${fileId}:${contentsKey}:${attempt}`;
  const canLoad = loadFileContents !== undefined && entry !== undefined && !patchPending;
  const requestPatch = props.onRequestPatch;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for the selected file's own patch, which a deferred diff only loads on request
  useEffect(() => {
    if (patchPending && filePath) requestPatch(filePath);
  }, [patchPending, filePath, requestPatch]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the selected file's two sides from the server and drops the answer when the file or the comparison changed meanwhile
  useEffect(() => {
    if (!canLoad || fileId === null || loadKey === null) return;
    if (patch === undefined || loadFileContents === undefined) return;
    let current = true;
    loadFileContents(patch).then(
      (loadedFiles) => {
        if (!current) return;
        const revision = `${fileContentRevision(loadedFiles.oldFile?.contents ?? "")}:${fileContentRevision(loadedFiles.newFile.contents)}`;
        setLoaded({ fileId, loadKey, outcome: { kind: "loaded", files: loadedFiles, revision } });
      },
      (error: unknown) => {
        if (!current) return;
        const failure = classifyDiffFileContentsFailure(error);
        setLoaded({ fileId, loadKey, outcome: { kind: "failed", failure } });
      },
    );
    return () => {
      current = false;
    };
  }, [canLoad, fileId, loadKey, patch, loadFileContents]);

  const selectFile = (direction: SbsNavigationDirection) => {
    const target = files[direction === "next" ? index + 1 : index - 1];
    if (!target) return;
    setArrival({ fileKey: target.fileKey, from: direction });
    props.onSelectFile(target.fileKey);
  };

  const title = (
    <>
      {patch?.prevName && patch.prevName !== patch.name ? (
        <>
          <StartTruncatedPath path={shownPath(patch.prevName)} className="text-muted-foreground" />
          <span className="shrink-0 text-muted-foreground">{"->"}</span>
        </>
      ) : null}
      <StartTruncatedPath path={shownPath(filePath)} />
    </>
  );

  const leading = entry ? (
    <>
      {files.length > 1 ? (
        <span className="flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label="Previous file"
                  disabled={index === 0}
                  onClick={() => selectFile("previous")}
                />
              }
            >
              <ChevronLeftIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Previous file</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label="Next file"
                  disabled={index === files.length - 1}
                  onClick={() => selectFile("next")}
                />
              }
            >
              <ChevronRightIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Next file</TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
      {onOpenFile ? (
        <button
          type="button"
          className="flex min-w-0 items-center gap-1 text-xs text-foreground hover:underline"
          onClick={() => onOpenFile(filePath)}
          data-sbs-file-title=""
        >
          {title}
        </button>
      ) : (
        <span
          className="flex min-w-0 items-center gap-1 text-xs text-foreground"
          data-sbs-file-title=""
        >
          {title}
        </span>
      )}
      <DiffFilePathCopyButton filePath={filePath} />
    </>
  ) : null;

  if (!entry || !patch || !patchState) {
    return <Message>No files changed in this selection.</Message>;
  }

  const shell = (body: ReactNode) => (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <SbsBar leading={leading} />
      {body}
    </div>
  );

  if (patchPending) {
    return shell(
      patchState.error ? (
        <Message>
          <p>This file's changes could not be loaded.</p>
          <Button size="xs" variant="outline" onClick={() => props.onRetryPatch(filePath)}>
            Retry
          </Button>
        </Message>
      ) : (
        <DiffPanelLoadingState label="Loading file..." />
      ),
    );
  }

  // A reload of the same file keeps what it showed until the new answer is in.
  const outcome = canLoad ? (loaded?.fileId === fileId ? loaded.outcome : null) : undefined;
  if (outcome === null) return shell(<DiffPanelLoadingState label="Loading file..." />);

  const whole =
    outcome?.kind === "loaded" ? wholeFileDiffOf(outcome.files, patch, ignoreWhitespace) : null;
  const failure: DiffFileContentsFailure | null =
    outcome === undefined
      ? null
      : outcome.kind === "failed"
        ? outcome.failure
        : whole
          ? null
          : "failed";
  const patchOnly = whole === null;

  if (patchOnly && failure === "binary") {
    return shell(<Message>Binary file. Its contents are not shown.</Message>);
  }
  if (patchOnly && failure === "too-large" && patchOnlyKey !== entry.fileKey) {
    return shell(
      <Message>
        <p>This file is over 1 MB, too large to show whole.</p>
        {patch.hunks.length > 0 ? (
          <Button size="xs" variant="outline" onClick={() => setPatchOnlyKey(entry.fileKey)}>
            Show changed lines only
          </Button>
        ) : null}
      </Message>,
    );
  }
  if (patchOnly && patch.hunks.length === 0) {
    return shell(
      failure === "failed" ? (
        <Message>
          <p>This file could not be loaded.</p>
          <Button size="xs" variant="outline" onClick={() => setAttempt((count) => count + 1)}>
            Retry
          </Button>
        </Message>
      ) : (
        <Message>No line changes to show for this file.</Message>
      ),
    );
  }

  const notice = patchOnly ? (
    <SbsNotice>
      {failure === "failed"
        ? patchState.truncated
          ? "The whole file could not be loaded, and its patch is cut off. The changes shown are incomplete."
          : "The whole file could not be loaded. Showing its changed lines only."
        : patchState.truncated
          ? "This file's patch is cut off. The changes shown are incomplete."
          : "Only the changed lines are available here."}
      {failure === "failed" ? (
        <Button size="micro" variant="outline" onClick={() => setAttempt((count) => count + 1)}>
          Retry
        </Button>
      ) : null}
    </SbsNotice>
  ) : whole.sameness === "identical" ? (
    <SbsNotice>Contents are identical</SbsNotice>
  ) : whole.sameness === "ignored" ? (
    <SbsNotice>Differences ignored: only whitespace changed</SbsNotice>
  ) : null;

  const viewProps: SideBySideDiffViewProps = {
    fileDiff: whole?.fileDiff ?? patch,
    leading,
    notice,
    collapseUnchanged,
    onCollapseUnchangedChange: setCollapseUnchanged,
    highlightMode,
    onHighlightModeChange: setHighlightMode,
    initialDifference:
      arrival?.fileKey === entry.fileKey && arrival.from === "previous" ? "last" : "first",
    focusOnOpen: arrival?.fileKey === entry.fileKey,
    adjacentFiles: { next: index < files.length - 1, previous: index > 0 },
    onOpenAdjacentFile: selectFile,
    ...(onOpenFile
      ? {
          onOpenSource: ({ side, line }) => {
            // The old side of a file is not on disk to open at a line.
            if (side === "additions") onOpenFile(filePath, line);
          },
        }
      : {}),
    ...(onTokenActivate
      ? { onTokenActivate: (activation) => onTokenActivate(activation, filePath) }
      : {}),
  };
  return (
    <div
      // One view per file, per text and per way of showing it: its scroll and folds belong to that.
      key={`${fileId}:${outcome?.kind === "loaded" ? outcome.revision : ""}:${patchOnly}:${ignoreWhitespace}`}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {props.renderView ? (
        props.renderView(viewProps, entry)
      ) : (
        <SideBySideDiffView {...viewProps} />
      )}
    </div>
  );
}
