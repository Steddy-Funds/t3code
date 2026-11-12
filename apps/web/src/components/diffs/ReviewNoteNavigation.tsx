import type { FileDiffMetadata } from "@pierre/diffs";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { type ReviewItem, reviewNoteRangeLabel } from "@t3tools/shared/reviewNote";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, EyeOffIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { diffPathForWorkspaceFile } from "~/diffFileActions";
import { useReviewNoteRevealStore, useThreadReviewNotes } from "~/reviewNotes";

import { ReviewNoteExcerpt } from "../chat/ReviewNoteCard";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { AnnotatableCodeViewHandle, DiffReviewNotes } from "./AnnotatableCodeView";
import {
  cachedReviewNoteAnchor,
  type PlacedReviewNote,
  placeReviewNotes,
  reviewItemDiffPath,
  type ReviewNoteShownLines,
  stepReviewNote,
} from "./reviewNoteAnchoring";
import { useReviewNoteDismissals } from "./reviewNoteDismissals";
import { ReviewItemText, ReviewNoteIconAction } from "./ReviewNoteAnnotation";

type NoteRevealViewer = Pick<AnnotatableCodeViewHandle, "getInstance" | "getItem" | "scrollTo">;

const isPendingFileDiff = (fileDiff: FileDiffMetadata) =>
  fileDiff.cacheKey?.endsWith(":pending") === true;

/**
 * Scrolls a code view to a note. Like the file reveal, `attach` is the viewer's ref and `flush`
 * runs after each render: a reveal waits until the viewer shows the note's file loaded and
 * unfolded, then places the note on that file.
 */
function createReviewNoteReveal(onUnplaced: () => void) {
  let viewer: NoteRevealViewer | null = null;
  let pending: {
    readonly fileKey: string;
    readonly note: ReviewItem;
    readonly diffPath: string;
  } | null = null;
  const flush = () => {
    if (pending === null || viewer === null || !viewer.getInstance()) return;
    const { fileKey, note, diffPath } = pending;
    const item = viewer.getItem(fileKey);
    if (item?.type !== "diff" || item.collapsed === true || isPendingFileDiff(item.fileDiff)) {
      return;
    }
    pending = null;
    const anchor = cachedReviewNoteAnchor(note, item.fileDiff, diffPath);
    if (anchor.kind === "unattached") {
      onUnplaced();
      return;
    }
    viewer.scrollTo({
      type: "line",
      id: fileKey,
      lineNumber: anchor.endLine,
      side: "additions",
      align: "center",
    });
  };
  return {
    attach(next: NoteRevealViewer | null) {
      if (viewer !== null && next !== viewer) pending = null;
      viewer = next;
      flush();
    },
    request(fileKey: string, note: ReviewItem, diffPath: string) {
      pending = { fileKey, note, diffPath };
      flush();
    },
    flush,
  };
}

/** The newest "Show in diff" request each thread's diff took; outlives a remounted panel. */
const takenRevealRequests = new Map<string, number>();

interface ShownFile {
  readonly fileDiff: FileDiffMetadata;
  readonly fileKey: string;
  readonly filePath: string;
  readonly collapsed: boolean;
}

/**
 * The thread's review notes on the shown diff: what the code view attaches, the toolbar's
 * stepping and list, and the timeline's "Show in diff" requests. Attach `reveal` to the code
 * view and flush it after each render.
 */
export function useDiffReviewNotes({
  threadRef,
  files,
  unfoldFile,
  requestFile,
  workspaceRoot,
  repositoryRoot,
  shownLines,
  onShowNote,
}: {
  threadRef: ScopedThreadRef | null;
  files: ReadonlyArray<ShownFile>;
  unfoldFile: (fileKey: string) => void;
  /** Loads a lazily loaded file's patch. */
  requestFile: (filePath: string) => void;
  workspaceRoot: string | undefined;
  /** Set when the diff names files from a repository root above the workspace. */
  repositoryRoot: string | undefined;
  /** Whole files where the shown view reads them whole, so a note on an unchanged line sits there. */
  shownLines: ReviewNoteShownLines;
  /**
   * Hears each note shown on its lines, for another view than the code view. True when that view
   * shows the diff now and takes the note there.
   */
  onShowNote?: ((placed: PlacedReviewNote) => boolean) | undefined;
}) {
  const { notes, threads, answeredIds, conversations, sentComments } =
    useThreadReviewNotes(threadRef);
  const { dismissedIds, dismiss, restore } = useReviewNoteDismissals(threadRef);
  const [listOpen, setListOpen] = useState(false);
  const [currentNoteId, setCurrentNoteId] = useState<string | null>(null);
  // The note last asked for that the view showing it lacks the lines for (a whole file that could
  // not load shows only its patch), though its anchor says it sits there.
  const [unplacedNoteId, setUnplacedNoteId] = useState<string | null>(null);
  const [reveal] = useState(() => createReviewNoteReveal(() => setListOpen(true)));

  const placed = placeReviewNotes(
    [...notes, ...threads],
    files.map(({ fileDiff, fileKey }) => ({
      fileDiff,
      fileKey,
      pending: isPendingFileDiff(fileDiff),
    })),
    { workspaceRoot, repositoryRoot },
    shownLines,
  );
  const shown = placed.filter(({ note }) => !dismissedIds.has(note.id));
  const dismissed = placed.filter(({ note }) => dismissedIds.has(note.id));
  const steps = shown.filter(({ anchor }) => anchor.kind !== "unattached");
  const unattached = shown.filter(
    ({ note, anchor }) => anchor.kind === "unattached" || note.id === unplacedNoteId,
  );

  const showNote = (placedNote: PlacedReviewNote) => {
    const { note, fileKey, anchor } = placedNote;
    setCurrentNoteId(note.id);
    setUnplacedNoteId(null);
    if (dismissedIds.has(note.id) || anchor.kind === "unattached") {
      setListOpen(true);
      return;
    }
    if (onShowNote?.(placedNote)) return;
    unfoldFile(fileKey);
    const file = files.find((candidate) => candidate.fileKey === fileKey);
    if (file && anchor.kind === "pending") requestFile(file.filePath);
    reveal.request(fileKey, note, reviewItemDiffPath(note, { workspaceRoot, repositoryRoot }));
  };

  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const revealRequest = useReviewNoteRevealStore((state) =>
    threadKey === null ? undefined : state.byThreadKey[threadKey],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- takes the timeline's "Show in diff" request from its store once the note's file is in the diff, once per request id
  useEffect(() => {
    if (threadKey === null || !revealRequest) return;
    if (takenRevealRequests.get(threadKey) === revealRequest.requestId) return;
    const note = placed.find((candidate) => candidate.note.id === revealRequest.noteId);
    if (!note) return;
    takenRevealRequests.set(threadKey, revealRequest.requestId);
    // oxlint-disable-next-line react/set-state-in-effect -- the request is an event from the timeline, outside this panel
    showNote(note);
  }, [threadKey, revealRequest, placed, showNote]);

  const step = (direction: 1 | -1) => {
    const next = stepReviewNote(shown, currentNoteId, direction);
    if (next) showNote(next);
  };

  const codeView: DiffReviewNotes = {
    placed: shown,
    answeredIds,
    conversations,
    onDismiss: dismiss,
  };
  const sentCommentCounts = new Map<string, number>();
  for (const comment of sentComments) {
    const diffPath =
      comment.pathBase === "diff"
        ? comment.path
        : diffPathForWorkspaceFile({ filePath: comment.path, workspaceRoot, repositoryRoot });
    sentCommentCounts.set(diffPath, (sentCommentCounts.get(diffPath) ?? 0) + 1);
  }
  return {
    reveal,
    codeView,
    /** By diff path: the comments the user sent the agent on the file. */
    sentCommentCounts,
    /** The view asked to show the current note lacks its lines: the list shows it instead. */
    onNoteUnplaced: () => {
      setUnplacedNoteId(currentNoteId);
      setListOpen(true);
    },
    toolbar:
      placed.length === 0
        ? null
        : {
            count: shown.length,
            threadCount: shown.filter(({ note }) => note.kind === "review_comment_thread").length,
            canStep: steps.length > 0,
            onPrevious: () => step(-1),
            onNext: () => step(1),
            unattached,
            dismissed,
            onDismiss: dismiss,
            onRestore: restore,
            listOpen,
            onListOpenChange: setListOpen,
          },
  };
}

type ReviewNotesToolbarProps = NonNullable<ReturnType<typeof useDiffReviewNotes>["toolbar"]>;

function ReviewNoteListRow({ placed, action }: { placed: PlacedReviewNote; action: ReactNode }) {
  const { note } = placed;
  return (
    <li className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Tooltip>
            <TooltipTrigger render={<span className="truncate font-mono text-foreground" />}>
              {note.path}
            </TooltipTrigger>
            <TooltipPopup side="top">{note.path}</TooltipPopup>
          </Tooltip>
          <span className="shrink-0 text-muted-foreground">{reviewNoteRangeLabel(note)}</span>
        </div>
        <ReviewNoteExcerpt note={note} className="my-1" />
        <ReviewItemText item={note} className="text-xs" />
      </div>
      {action}
    </li>
  );
}

function ReviewNoteListSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="font-medium text-2xs text-muted-foreground">{title}</h3>
      <ul className="space-y-2.5">{children}</ul>
    </section>
  );
}

/** "N notes" with previous and next, and the notes the diff cannot place or that were dismissed. */
export function ReviewNotesToolbar({
  count,
  threadCount,
  canStep,
  onPrevious,
  onNext,
  unattached,
  dismissed,
  onDismiss,
  onRestore,
  listOpen,
  onListOpenChange,
}: ReviewNotesToolbarProps) {
  const noteCount = count - threadCount;
  const label =
    count === 0
      ? `${dismissed.length} dismissed`
      : [
          noteCount > 0 ? `${noteCount} ${noteCount === 1 ? "note" : "notes"}` : null,
          threadCount > 0 ? `${threadCount} ${threadCount === 1 ? "comment" : "comments"}` : null,
        ]
          .filter((part) => part !== null)
          .join(" · ");
  const hasList = unattached.length > 0 || dismissed.length > 0;
  const stepButton = (direction: "Previous" | "Next") => (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`${direction} review item`}
            disabled={!canStep}
            onClick={direction === "Previous" ? onPrevious : onNext}
          />
        }
      >
        {direction === "Previous" ? <ChevronLeftIcon /> : <ChevronRightIcon />}
      </TooltipTrigger>
      <TooltipPopup side="top">{direction}</TooltipPopup>
    </Tooltip>
  );
  return (
    <div role="group" aria-label="Review notes" className="flex shrink-0 items-center">
      {count > 0 ? stepButton("Previous") : null}
      {hasList ? (
        <Popover open={listOpen} onOpenChange={onListOpenChange}>
          <PopoverTrigger render={<Button type="button" size="xs" variant="ghost" />}>
            <span className="tabular-nums">{label}</span>
            <ChevronDownIcon className="opacity-70" />
          </PopoverTrigger>
          <PopoverPopup align="end" width="md" padding="compact">
            <div className="space-y-3">
              {unattached.length > 0 ? (
                <ReviewNoteListSection title="Not placed in this diff">
                  {unattached.map((placed) => (
                    <ReviewNoteListRow
                      key={placed.note.id}
                      placed={placed}
                      action={
                        <ReviewNoteIconAction
                          label="Dismiss"
                          onClick={() => onDismiss(placed.note.id)}
                        >
                          <EyeOffIcon className="size-3" />
                        </ReviewNoteIconAction>
                      }
                    />
                  ))}
                </ReviewNoteListSection>
              ) : null}
              {dismissed.length > 0 ? (
                <ReviewNoteListSection title="Dismissed">
                  {dismissed.map((placed) => (
                    <ReviewNoteListRow
                      key={placed.note.id}
                      placed={placed}
                      action={
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => onRestore(placed.note.id)}
                        >
                          Restore
                        </Button>
                      }
                    />
                  ))}
                </ReviewNoteListSection>
              ) : null}
            </div>
          </PopoverPopup>
        </Popover>
      ) : (
        <span className="px-1 text-xs tabular-nums text-muted-foreground">{label}</span>
      )}
      {count > 0 ? stepButton("Next") : null}
    </div>
  );
}
