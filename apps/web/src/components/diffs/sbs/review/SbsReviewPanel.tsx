import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, ProjectId, ScopedThreadRef, TurnItemId } from "@t3tools/contracts";
import { type ReviewNote, reviewNoteSectionId } from "@t3tools/shared/reviewNote";
import { MessageSquarePlusIcon } from "lucide-react";
import { type ReactNode, type SyntheticEvent, useEffect, useLayoutEffect, useState } from "react";

import type { DraftId } from "~/composerDraftStore";
import { buildDiffReviewComment, type ReviewCommentContext } from "~/reviewCommentContext";
import { buildReviewNoteReply } from "~/reviewNotes";

import { Button } from "../../../ui/button";
import type { DiffReviewNotes } from "../../AnnotatableCodeView";
import { ReviewCommentBox } from "../../ReviewCommentBox";
import { ReviewNoteAnnotation } from "../../ReviewNoteAnnotation";
import { isAttachedReviewNote } from "../../reviewNoteAnchoring";
import {
  type ReviewCommentDrafts,
  type SendReviewComments,
  useReviewCommentDrafts,
  withQuotedSelection,
} from "../../useReviewCommentDrafts";
import {
  SbsNotice,
  SideBySideDiffPanel,
  type SbsFileEntry,
  type SideBySideDiffPanelProps,
} from "../SideBySideDiffPanel";
import {
  type SbsLineSelection,
  SideBySideDiffView,
  type SideBySideDiffViewProps,
} from "../SideBySideDiffView";
import {
  sbsCommentLines,
  sbsReviewAnnotationsOf,
  type SbsReviewEntry,
  type SbsReviewLines,
  sbsShowsLines,
} from "./sbsReviewAnnotations";

/** Lines of one file, with the text they were picked on: the comment quotes that text. */
interface SbsCommentRange extends SbsReviewLines {
  readonly fileKey: string;
  readonly filePath: string;
  readonly fileDiff: FileDiffMetadata;
}

interface SbsPick extends SbsCommentRange {
  readonly selectedText: string;
}

/** A review note to bring into view: the toolbar stepped to it, or the timeline asked. */
export interface SbsNoteReveal {
  readonly noteId: TurnItemId;
}

export interface SbsReviewPanelProps extends Omit<SideBySideDiffPanelProps, "renderView"> {
  /** With an environment, a draft can be dictated; its project supplies vocabulary. */
  readonly environmentId?: EnvironmentId | undefined;
  readonly projectId?: ProjectId | null | undefined;
  readonly sectionId: string;
  readonly sectionTitle: string;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  /** Absent where a comment can only join the message. */
  readonly onSendComments?: SendReviewComments | undefined;
  readonly reviewNotes: DiffReviewNotes;
  readonly noteReveal: SbsNoteReveal | null;
  /** The note asked for is in view, or its file was left before it could be. */
  readonly onNoteRevealed: () => void;
  /** The note asked for has no lines in this diff: the notes list shows it. */
  readonly onNoteUnplaced: () => void;
}

const SELECTION_ID = "sbs-review:selection";

const stopPropagation = (event: SyntheticEvent) => event.stopPropagation();

/** Settles a box whose lines are gone from view: its words go to the message, an empty one closes. */
function keepDraftWords<TRange>(drafts: ReviewCommentDrafts<TRange>, text: string) {
  if (text.trim() === "") drafts.cancel();
  else drafts.addToMessage(text);
}

function pickLabel({ side, startLine, endLine }: SbsReviewLines): string {
  const lines = startLine === endLine ? `line ${startLine}` : `lines ${startLine} to ${endLine}`;
  return side === "deletions" ? `Old ${lines}` : `${lines[0]!.toUpperCase()}${lines.slice(1)}`;
}

/**
 * The side-by-side diff with review: comments on picked lines of either pane, the comments
 * already in the message draft, and the agent's review notes with Reply and Dismiss. The boxes
 * live here, above the view, so a file that reloads keeps the one being written.
 */
export function SbsReviewPanel({
  environmentId,
  projectId,
  sectionId,
  sectionTitle,
  composerDraftTarget,
  onSendComments,
  reviewNotes,
  noteReveal,
  onNoteRevealed,
  onNoteUnplaced,
  ...panelProps
}: SbsReviewPanelProps) {
  const shownFileKey =
    (
      panelProps.files.find((file) => file.fileKey === panelProps.selectedFileKey) ??
      panelProps.files[0]
    )?.fileKey ?? null;
  const [pick, setPick] = useState<SbsPick | null>(null);
  // The card the user opened: an entry's id. An open box keeps its own card open instead.
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  if (pick && pick.fileKey !== shownFileKey) setPick(null);

  const comments = useReviewCommentDrafts<SbsCommentRange>({
    composerDraftTarget,
    onSend: onSendComments,
    buildComment: ({ id, range, text, selectedText }) => {
      const comment = buildDiffReviewComment({
        id,
        sectionId,
        sectionTitle,
        filePath: range.filePath,
        fileDiff: range.fileDiff,
        range: { start: range.startLine, side: range.side, end: range.endLine, endSide: range.side },
        text,
      });
      return comment && withQuotedSelection(comment, selectedText);
    },
    // The stacked and split views own the same comments, so each shows the other's.
    ownsComment: (comment) =>
      comment.sectionId === sectionId && (comment.fenceLanguage ?? "diff") === "diff",
  });

  const attachedNotes = reviewNotes.placed.filter(isAttachedReviewNote);
  const notesBySection = new Map(
    attachedNotes.map(({ note }) => [reviewNoteSectionId(note.id), note]),
  );
  const noteReplies = useReviewCommentDrafts<ReviewNote>({
    composerDraftTarget,
    onSend: onSendComments,
    buildComment: ({ id, range, text, selectedText }) =>
      withQuotedSelection(buildReviewNoteReply({ id, note: range, text }), selectedText),
    ownsComment: (comment) => notesBySection.has(comment.sectionId),
  });

  const draft = comments.annotations.find((annotation) => annotation.kind === "draft");
  const replyDraft = noteReplies.annotations.find((annotation) => annotation.kind === "draft");
  const replyNote = replyDraft
    ? reviewNotes.placed.find(({ note }) => note.id === replyDraft.range.id)
    : undefined;
  // Another file is shown, or the note lost its lines. A reloading file holds its notes as
  // pending, and the reply waits for it.
  const strandedDraft = draft && !draft.sending && draft.range.fileKey !== shownFileKey ? draft : null;
  const strandedReply =
    replyDraft &&
    !replyDraft.sending &&
    (replyNote === undefined ||
      replyNote.anchor.kind === "unattached" ||
      replyNote.fileKey !== shownFileKey)
      ? replyDraft
      : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a box whose file was left, or a reply whose note lost its lines, keeps its words in the composer's draft store
  useEffect(() => {
    if (strandedDraft) keepDraftWords(comments, strandedDraft.text);
    if (strandedReply) keepDraftWords(noteReplies, strandedReply.text);
  }, [strandedDraft, strandedReply, comments, noteReplies]);

  const revealPlaced = noteReveal
    ? reviewNotes.placed.find(({ note }) => note.id === noteReveal.noteId)
    : undefined;
  const revealNoteId =
    revealPlaced && isAttachedReviewNote(revealPlaced) && revealPlaced.fileKey === shownFileKey
      ? revealPlaced.note.id
      : null;
  const revealUnplaced =
    noteReveal !== null &&
    (revealPlaced === undefined || revealPlaced.anchor.kind === "unattached");
  const revealAbandoned =
    revealPlaced !== undefined && !revealUnplaced && revealPlaced.fileKey !== shownFileKey;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a note asked for while its file loaded may turn out to have no lines here, and then the notes list shows it
  useEffect(() => {
    if (revealUnplaced) onNoteUnplaced();
    else if (revealAbandoned) onNoteRevealed();
  }, [revealUnplaced, revealAbandoned, onNoteUnplaced, onNoteRevealed]);

  // One box at a time: it keeps its card open until it is sent, saved or cancelled.
  const boxOpen = draft !== undefined || replyDraft !== undefined;
  const openId = draft ? draft.id : replyDraft ? replyDraft.range.id : (revealNoteId ?? openEntryId);

  const selectLines = (
    selection: SbsLineSelection | null,
    entry: SbsFileEntry,
    fileDiff: FileDiffMetadata,
  ) => {
    if (boxOpen) return;
    if (!selection) {
      setPick(null);
      if (openEntryId === SELECTION_ID) setOpenEntryId(null);
      return;
    }
    setPick({ fileKey: entry.fileKey, filePath: entry.filePath, fileDiff, ...selection });
    setOpenEntryId(SELECTION_ID);
  };

  const startComment = () => {
    if (!pick) return;
    const { selectedText, ...range } = pick;
    comments.beginComment(range, selectedText);
    setPick(null);
    setOpenEntryId(null);
  };

  const ownerKey = (...ids: ReadonlyArray<string>) =>
    JSON.stringify([environmentId, composerDraftTarget, panelProps.scopeKey, ...ids]);

  const renderEntry = (entry: SbsReviewEntry): ReactNode => {
    if (entry.kind === "selection") {
      return (
        <div key={entry.id} className="flex min-w-0 items-center gap-2 px-2 py-1.5">
          <Button type="button" size="xs" variant="ghost" onClick={startComment}>
            <MessageSquarePlusIcon />
            Comment
          </Button>
          <span className="truncate text-2xs text-muted-foreground">{pickLabel(entry)}</span>
        </div>
      );
    }
    if (entry.kind === "note") {
      const placed = attachedNotes.find(({ note }) => note.id === entry.id);
      if (!placed) return null;
      const { note } = placed;
      const replies = noteReplies.annotations.filter((annotation) =>
        annotation.kind === "draft"
          ? annotation.range.id === note.id
          : notesBySection.get(annotation.comment.sectionId)?.id === note.id,
      );
      return (
        <ReviewNoteAnnotation
          key={entry.id}
          note={note}
          moved={placed.anchor.kind === "moved"}
          answered={reviewNotes.answeredIds.has(note.id)}
          replying={replies.some((reply) => reply.kind === "draft")}
          onReply={() => {
            noteReplies.beginComment(note, pick?.selectedText);
            setPick(null);
          }}
          onDismiss={() => reviewNotes.onDismiss(note.id)}
          replies={
            replies.length > 0 ? (
              <div className="divide-y divide-border/30 border-t border-border/30">
                {replies.map((reply) => (
                  <ReviewCommentBox
                    key={reply.id}
                    environmentId={environmentId}
                    projectId={projectId}
                    ownerKey={ownerKey(note.id, reply.id)}
                    annotation={reply}
                    drafts={noteReplies}
                  />
                ))}
              </div>
            ) : null
          }
        />
      );
    }
    const annotation = comments.annotations.find((candidate) => candidate.id === entry.id);
    return annotation ? (
      <ReviewCommentBox
        key={entry.id}
        environmentId={environmentId}
        projectId={projectId}
        ownerKey={ownerKey(entry.id)}
        annotation={annotation}
        drafts={comments}
      />
    ) : null;
  };

  const renderCard = (entries: ReadonlyArray<SbsReviewEntry>) => (
    <div
      className="divide-y divide-border/50 overflow-hidden rounded-md"
      // The view reads these as a pick given up or a copy of its lines; in the card they are not.
      onPointerDown={stopPropagation}
      onMouseUp={stopPropagation}
      onKeyUp={stopPropagation}
      onCopy={stopPropagation}
    >
      {entries.map(renderEntry)}
    </div>
  );

  const renderView = (viewProps: SideBySideDiffViewProps, entry: SbsFileEntry) => {
    const entries: SbsReviewEntry[] = [];
    for (const { note, fileKey, anchor } of attachedNotes) {
      if (fileKey !== entry.fileKey) continue;
      const { startLine, endLine } = anchor;
      entries.push({ kind: "note", id: note.id, side: "additions", startLine, endLine });
    }
    if (draft?.range.fileKey === entry.fileKey) {
      const { side, startLine, endLine } = draft.range;
      entries.push({ kind: "draft", id: draft.id, side, startLine, endLine });
    }
    if (pick?.fileKey === entry.fileKey) {
      const { side, startLine, endLine } = pick;
      entries.push({ kind: "selection", id: SELECTION_ID, side, startLine, endLine });
    }
    const fileComments = comments.annotations.flatMap((annotation) =>
      annotation.kind === "comment" && annotation.comment.filePath === entry.filePath
        ? [annotation.comment]
        : [],
    );
    return (
      <SbsReviewView
        viewProps={viewProps}
        entries={entries}
        comments={fileComments}
        openId={openId}
        onOpenChange={(id) => {
          if (!boxOpen) setOpenEntryId(id);
        }}
        onSelectRange={(selection, fileDiff) => selectLines(selection, entry, fileDiff)}
        revealId={revealNoteId}
        onRevealed={() => {
          if (revealNoteId) setOpenEntryId(revealNoteId);
          onNoteRevealed();
        }}
        onDraftLinesGone={() => {
          if (draft && !draft.sending) keepDraftWords(comments, draft.text);
        }}
        renderCard={renderCard}
      />
    );
  };

  return <SideBySideDiffPanel {...panelProps} renderView={renderView} />;
}

/**
 * One file's view: the entries placed on the lines its text has, and the comments it lacks the
 * lines for listed above the panes. It mounts with the view, so a reveal it passes on is taken
 * by the time its own layout effect runs.
 */
function SbsReviewView({
  viewProps,
  entries,
  comments,
  openId,
  onOpenChange,
  onSelectRange,
  revealId,
  onRevealed,
  onDraftLinesGone,
  renderCard,
}: {
  viewProps: SideBySideDiffViewProps;
  /** Notes, the open box and the picked lines, on this file. */
  entries: ReadonlyArray<SbsReviewEntry>;
  /** This file's comments in the message draft. */
  comments: ReadonlyArray<ReviewCommentContext>;
  /** The entry whose card is open. */
  openId: string | null;
  onOpenChange: (id: string | null) => void;
  onSelectRange: (selection: SbsLineSelection | null, fileDiff: FileDiffMetadata) => void;
  /** An entry to bring into view. */
  revealId: string | null;
  onRevealed: () => void;
  /** The file reloaded without the lines under the open box. */
  onDraftLinesGone: () => void;
  renderCard: (entries: ReadonlyArray<SbsReviewEntry>) => ReactNode;
}) {
  const { fileDiff } = viewProps;
  const placed = entries.filter((entry) => sbsShowsLines(fileDiff, entry));
  const unplacedComments: ReviewCommentContext[] = [];
  for (const comment of comments) {
    const lines = sbsCommentLines(comment);
    if (lines && sbsShowsLines(fileDiff, lines)) {
      placed.push({ kind: "comment", id: comment.id, ...lines });
    } else {
      unplacedComments.push(comment);
    }
  }
  const annotations = sbsReviewAnnotationsOf(fileDiff, placed);
  const groupOf = (id: string | null) =>
    id === null
      ? undefined
      : annotations.find((annotation) => annotation.data.entries.some((entry) => entry.id === id));
  const openGroup = groupOf(openId);
  const revealGroup = groupOf(revealId);
  // Built here, not per call: the view renders on every scroll frame and gets the same card.
  const card = openGroup ? renderCard(openGroup.data.entries) : null;

  const draftLinesGone = entries.some(
    (entry) => entry.kind === "draft" && !sbsShowsLines(fileDiff, entry),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the file reloaded without the lines under the open box, which can no longer show; its words go to the composer's draft store
  useEffect(() => {
    if (draftLinesGone) onDraftLinesGone();
  }, [draftLinesGone, onDraftLinesGone]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the view scrolled to the entry in its own layout effect, which runs before this one; the request is then spent
  useLayoutEffect(() => {
    if (revealGroup) onRevealed();
  }, [revealGroup, onRevealed]);

  const count = unplacedComments.length;
  const notice =
    count > 0 ? (
      <SbsNotice>
        {`${count === 1 ? "A comment" : `${count} comments`} in the message ${count === 1 ? "is" : "are"} on lines this file no longer has: ${unplacedComments.map((comment) => comment.rangeLabel).join(", ")}`}
      </SbsNotice>
    ) : null;

  return (
    <SideBySideDiffView
      {...viewProps}
      notice={
        viewProps.notice || notice ? (
          <>
            {viewProps.notice}
            {notice}
          </>
        ) : null
      }
      annotations={annotations}
      openAnnotationId={openGroup?.id ?? null}
      onOpenAnnotationChange={onOpenChange}
      renderAnnotation={() => card}
      onSelectRange={(selection) => onSelectRange(selection, fileDiff)}
      revealAnnotationId={revealGroup?.id ?? null}
    />
  );
}
