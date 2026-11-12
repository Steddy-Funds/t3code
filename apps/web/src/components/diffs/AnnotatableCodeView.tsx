import type {
  AnnotationSide,
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { EnvironmentId, ProjectId, ScopedThreadRef, TurnItemId } from "@t3tools/contracts";
import { type ReviewNote, reviewNoteSectionId } from "@t3tools/shared/reviewNote";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import type { DraftId } from "~/composerDraftStore";
import { fnv1a32, resolveFileDiffPath, resolveFileDiffPreviousPath } from "~/lib/diffRendering";
import { buildDiffReviewComment, restoreDiffReviewCommentRange } from "~/reviewCommentContext";
import { buildReviewNoteReply } from "~/reviewNotes";

import { ReviewCommentBox } from "./ReviewCommentBox";
import { ReviewNoteAnnotation } from "./ReviewNoteAnnotation";
import { isAttachedReviewNote, type PlacedReviewNote } from "./reviewNoteAnchoring";
import { StyledDiffCodeView, type StyledDiffCodeViewOptions } from "./StyledDiffCodeView";
import {
  type SendReviewComments,
  useReviewCommentDrafts,
  withQuotedSelection,
} from "./useReviewCommentDrafts";

interface DiffCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment" | "note";
  rangeLabel: string;
  /** Empty for a draft: typing in the box must not re-version its file. */
  text: string;
}

/** The agent's review notes on the shown diff. */
export interface DiffReviewNotes {
  /** Only the notes with lines in the diff are shown; the rest belong to the panel's list. */
  readonly placed: ReadonlyArray<PlacedReviewNote>;
  readonly answeredIds: ReadonlySet<TurnItemId>;
  readonly onDismiss: (noteId: TurnItemId) => void;
}

const NO_REVIEW_NOTES: ReadonlyArray<PlacedReviewNote> = [];

interface DiffCommentAnnotationGroup {
  entries: DiffCommentAnnotationEntry[];
}

type DiffCommentLineAnnotation = DiffLineAnnotation<DiffCommentAnnotationGroup>;
export type AnnotatableCodeViewHandle = CodeViewHandle<DiffCommentAnnotationGroup, undefined>;

/** Lines of one file of the view. The paths keep a draft through a lazily loaded patch. */
interface DiffCommentRange {
  readonly fileKey: string;
  readonly filePath: string;
  readonly previousFilePath: string;
  readonly lines: SelectedLineRange;
}

/** Whether `node` is under `root`, looking through the shadow roots the viewer renders into. */
function composedContains(root: Node, node: Node | null): boolean {
  for (let current = node; current;) {
    if (current === root) return true;
    current = current.parentNode ?? (current instanceof ShadowRoot ? current.host : null);
  }
  return false;
}

function appendAnnotationEntry(
  annotations: ReadonlyArray<DiffCommentLineAnnotation>,
  range: SelectedLineRange,
  entry: DiffCommentAnnotationEntry,
): DiffCommentLineAnnotation[] {
  const side: AnnotationSide =
    (range.endSide ?? range.side) === "deletions" ? "deletions" : "additions";
  const annotationIndex = annotations.findIndex(
    (annotation) => annotation.side === side && annotation.lineNumber === range.end,
  );
  if (annotationIndex < 0) {
    return [
      ...annotations,
      {
        side,
        lineNumber: range.end,
        metadata: { entries: [entry] },
      },
    ];
  }
  return annotations.map((annotation, index) =>
    index === annotationIndex
      ? {
          ...annotation,
          metadata: { entries: [...annotation.metadata.entries, entry] },
        }
      : annotation,
  );
}

interface AnnotatableCodeViewProps {
  environmentId?: EnvironmentId | undefined;
  projectId?: ProjectId | null | undefined;
  codeViewKey: string;
  files: ReadonlyArray<{
    fileDiff: FileDiffMetadata;
    filePath: string;
    fileKey: string;
    fileVersion: number;
    collapsed: boolean;
  }>;
  pendingFiles: ReadonlyArray<FileDiffMetadata>;
  sectionId: string;
  sectionTitle: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  /** Absent where a comment can only join the message. */
  onSendComments?: SendReviewComments | undefined;
  reviewNotes?: DiffReviewNotes | undefined;
  options: StyledDiffCodeViewOptions<DiffCommentAnnotationGroup>;
  viewerRef?: Ref<AnnotatableCodeViewHandle>;
  className?: string;
  renderCodeViewFooter?: () => ReactNode;
  unsafeCSSExtra?: string;
  renderHeaderMetadata?: (fileDiff: FileDiffMetadata) => ReactNode;
  renderHeaderFilenameSuffix: (fileDiff: FileDiffMetadata) => ReactNode;
  renderHeaderPrefix: (
    fileDiff: FileDiffMetadata,
    fileKey: string,
    collapsed: boolean,
  ) => ReactNode;
  onRevealSearchMatch: (fileKey: string) => void;
}

interface DiffSelectionContext {
  item: CodeViewItem<DiffCommentAnnotationGroup>;
}

export function AnnotatableCodeView({
  environmentId,
  projectId,
  codeViewKey,
  files,
  pendingFiles,
  sectionId,
  sectionTitle,
  composerDraftTarget,
  onSendComments,
  reviewNotes,
  options,
  viewerRef,
  className,
  renderCodeViewFooter,
  unsafeCSSExtra,
  renderHeaderMetadata,
  renderHeaderFilenameSuffix,
  renderHeaderPrefix,
  onRevealSearchMatch,
}: AnnotatableCodeViewProps) {
  const [selectedLines, setSelectedLines] = useState<{
    id: string;
    range: SelectedLineRange;
  } | null>(null);
  // Pressing the gutter clears the text selection before Pierre reports the click.
  const selectedTextRef = useRef("");

  const filesByKey = new Map(files.map((file) => [file.fileKey, file]));
  const comments = useReviewCommentDrafts<DiffCommentRange>({
    composerDraftTarget,
    onSend: onSendComments,
    buildComment: ({ id, range, text, selectedText }) => {
      const file = filesByKey.get(range.fileKey);
      if (!file) return null;
      const comment = buildDiffReviewComment({
        id,
        sectionId,
        sectionTitle,
        filePath: file.filePath,
        fileDiff: file.fileDiff,
        range: range.lines,
        text,
      });
      return comment && withQuotedSelection(comment, selectedText);
    },
    ownsComment: (comment) =>
      comment.sectionId === sectionId && (comment.fenceLanguage ?? "diff") === "diff",
  });
  const draft = comments.annotations.find((annotation) => annotation.kind === "draft");
  if (
    draft &&
    !filesByKey.has(draft.range.fileKey) &&
    // Lazy placeholders have provisional change types, so match both paths instead.
    !pendingFiles.some(
      (file) =>
        resolveFileDiffPath(file) === draft.range.filePath &&
        resolveFileDiffPreviousPath(file) === draft.range.previousFilePath,
    )
  ) {
    comments.cancel();
    setSelectedLines(null);
  }

  const attachedNotes = (reviewNotes?.placed ?? NO_REVIEW_NOTES).filter(isAttachedReviewNote);
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
  const repliesTo = (noteId: TurnItemId) =>
    noteReplies.annotations.filter((annotation) =>
      annotation.kind === "draft"
        ? annotation.range.id === noteId
        : notesBySection.get(annotation.comment.sectionId)?.id === noteId,
    );
  const noteDraft = noteReplies.annotations.find((annotation) => annotation.kind === "draft");
  const draftAnchor = noteDraft
    ? reviewNotes?.placed.find(({ note }) => note.id === noteDraft.range.id)?.anchor.kind
    : undefined;
  // A reloading file holds its notes as pending; the reply waits for it.
  const orphanedReply =
    noteDraft && (draftAnchor === undefined || draftAnchor === "unattached") ? noteDraft : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a reply whose note left its lines (the file changed under it) keeps its words in the composer's draft store
  useEffect(() => {
    if (!orphanedReply) return;
    if (orphanedReply.text.trim() === "") noteReplies.cancel();
    else noteReplies.addToMessage(orphanedReply.text);
  }, [orphanedReply, noteReplies]);

  const items: CodeViewDiffItem<DiffCommentAnnotationGroup>[] = files.map(
    ({ fileDiff, filePath, fileKey, fileVersion, collapsed }) => {
      let annotations: DiffCommentLineAnnotation[] = [];
      for (const { note, fileKey: noteFileKey, anchor } of attachedNotes) {
        if (noteFileKey !== fileKey) continue;
        annotations = appendAnnotationEntry(
          annotations,
          { start: anchor.startLine, side: "additions", end: anchor.endLine, endSide: "additions" },
          {
            id: note.id,
            kind: "note",
            rangeLabel: `${anchor.kind}:${anchor.startLine}:${anchor.endLine}`,
            text: JSON.stringify([
              reviewNotes?.answeredIds.has(note.id) ?? false,
              repliesTo(note.id).map((reply) => reply.id),
            ]),
          },
        );
      }
      for (const annotation of comments.annotations) {
        if (annotation.kind === "draft") {
          if (annotation.range.fileKey !== fileKey) continue;
          annotations = appendAnnotationEntry(annotations, annotation.range.lines, {
            id: annotation.id,
            kind: "draft",
            rangeLabel: annotation.rangeLabel,
            text: "",
          });
          continue;
        }
        if (annotation.comment.filePath !== filePath) continue;
        const range = restoreDiffReviewCommentRange(fileDiff, annotation.comment);
        if (!range) continue;
        annotations = appendAnnotationEntry(annotations, range, {
          id: annotation.id,
          kind: "comment",
          rangeLabel: annotation.comment.rangeLabel,
          text: annotation.comment.text,
        });
      }
      return {
        id: fileKey,
        type: "diff",
        fileDiff,
        annotations,
        collapsed,
        version: fnv1a32(
          `${fileVersion}:${collapsed ? "1" : "0"}:${annotations
            .flatMap((annotation) =>
              annotation.metadata.entries.map(
                (entry) => `${entry.id}:${entry.rangeLabel}:${entry.text}`,
              ),
            )
            .join(":")}`,
        ),
      };
    },
  );

  const beginComment = (range: SelectedLineRange | null, context: DiffSelectionContext) => {
    if (!range) return;
    const item = context.item;
    if (item.type !== "diff") return;
    comments.beginComment(
      {
        fileKey: item.id,
        filePath: resolveFileDiffPath(item.fileDiff),
        previousFilePath: resolveFileDiffPreviousPath(item.fileDiff),
        lines: range,
      },
      selectedTextRef.current,
    );
  };

  return (
    <div
      className="contents"
      onPointerDownCapture={(event) => {
        const selection = document.getSelection();
        selectedTextRef.current =
          selection && composedContains(event.currentTarget, selection.anchorNode)
            ? selection.toString()
            : "";
      }}
    >
      <StyledDiffCodeView<DiffCommentAnnotationGroup>
        key={codeViewKey}
        {...(viewerRef ? { viewerRef } : {})}
        {...(className ? { className } : {})}
        {...(unsafeCSSExtra ? { unsafeCSSExtra } : {})}
        {...(renderHeaderMetadata
          ? {
              renderHeaderMetadata: (item: CodeViewItem<DiffCommentAnnotationGroup>) =>
                item.type === "diff" ? renderHeaderMetadata(item.fileDiff) : null,
            }
          : {})}
        {...(renderCodeViewFooter ? { renderCodeViewFooter } : {})}
        items={items}
        selectedLines={selectedLines}
        onSelectedLinesChange={setSelectedLines}
        options={{
          ...options,
          enableGutterUtility: draft === undefined,
          enableLineSelection: draft === undefined,
          onGutterUtilityClick: beginComment,
          onRevealSearchMatch: (item) => onRevealSearchMatch(item.id),
        }}
        renderHeaderFilenameSuffix={(item) =>
          item.type === "diff" ? renderHeaderFilenameSuffix(item.fileDiff) : null
        }
        renderHeaderPrefix={(item) =>
          item.type === "diff"
            ? renderHeaderPrefix(item.fileDiff, item.id, item.collapsed === true)
            : null
        }
        renderAnnotation={(...[annotation]) => {
          const hasDraft = annotation.metadata.entries.some((entry) => entry.kind === "draft");
          return (
            <div
              className={hasDraft ? "py-1" : "divide-y divide-border/30 border-y border-border/30"}
            >
              {annotation.metadata.entries.map((entry) => {
                if (entry.kind === "note") {
                  const placed = attachedNotes.find(({ note }) => note.id === entry.id);
                  if (!placed || !reviewNotes) return null;
                  const { note } = placed;
                  const replies = repliesTo(note.id);
                  return (
                    <ReviewNoteAnnotation
                      key={entry.id}
                      note={note}
                      moved={placed.anchor.kind === "moved"}
                      answered={reviewNotes.answeredIds.has(note.id)}
                      replying={replies.some((reply) => reply.kind === "draft")}
                      onReply={() => noteReplies.beginComment(note, selectedTextRef.current)}
                      onDismiss={() => reviewNotes.onDismiss(note.id)}
                      replies={
                        replies.length > 0 ? (
                          <div className="divide-y divide-border/30 border-t border-border/30">
                            {replies.map((reply) => (
                              <ReviewCommentBox
                                key={reply.id}
                                environmentId={environmentId}
                                projectId={projectId}
                                ownerKey={JSON.stringify([
                                  environmentId,
                                  composerDraftTarget,
                                  codeViewKey,
                                  note.id,
                                  reply.id,
                                ])}
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
                const live = comments.annotations.find((candidate) => candidate.id === entry.id);
                return live ? (
                  <ReviewCommentBox
                    key={entry.id}
                    environmentId={environmentId}
                    projectId={projectId}
                    ownerKey={JSON.stringify([
                      environmentId,
                      composerDraftTarget,
                      codeViewKey,
                      entry.id,
                    ])}
                    annotation={live}
                    drafts={comments}
                    onDismiss={() => setSelectedLines(null)}
                  />
                ) : null;
              })}
            </div>
          );
        }}
      />
    </div>
  );
}
