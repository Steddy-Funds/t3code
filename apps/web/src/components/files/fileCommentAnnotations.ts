import type { LineAnnotation, SelectedLineRange } from "@pierre/diffs";

import type { ReviewCommentAnnotation } from "../diffs/useReviewCommentDrafts";

export interface FileCommentAnnotationEntry {
  id: string;
  kind: "draft" | "comment";
  startLine: number;
  endLine: number;
  text: string;
}

export interface FileCommentAnnotationGroup {
  entries: FileCommentAnnotationEntry[];
}

export type FileCommentLineAnnotation = LineAnnotation<FileCommentAnnotationGroup>;

export interface FileCommentRange {
  readonly startLine: number;
  readonly endLine: number;
}

export function normalizeFileCommentRange(range: SelectedLineRange): FileCommentRange {
  return {
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
  };
}

export function remapFileCommentAnnotations(
  annotations: ReadonlyArray<FileCommentLineAnnotation>,
): FileCommentLineAnnotation[] {
  return annotations.map((annotation) => ({
    ...annotation,
    metadata: {
      entries: annotation.metadata.entries.map((entry) => {
        const lineCount = entry.endLine - entry.startLine;
        return {
          ...entry,
          endLine: annotation.lineNumber,
          startLine: Math.max(1, annotation.lineNumber - lineCount),
        };
      }),
    },
  }));
}

/**
 * Whether the file still reads, at the comment's lines, what the comment quotes. One that no
 * longer fits is left alone: drawn there, the next edit would rewrite its excerpt from the
 * wrong lines.
 */
export function fileCommentStillFits(
  contents: string,
  comment: { readonly startIndex: number; readonly diff: string },
): boolean {
  // Walks to the comment's first line without splitting a file that can be megabytes long.
  let start = 0;
  for (let line = 0; line < comment.startIndex; line += 1) {
    const lineEnd = contents.indexOf("\n", start);
    if (lineEnd < 0) return false;
    start = lineEnd + 1;
  }
  const end = start + comment.diff.length;
  return (
    contents.startsWith(comment.diff, start) && (end === contents.length || contents[end] === "\n")
  );
}

/** The file's comments as the viewer takes them: grouped on the last line of each range. */
export function fileCommentLineAnnotations(
  annotations: ReadonlyArray<ReviewCommentAnnotation<FileCommentRange>>,
): FileCommentLineAnnotation[] {
  const byLine = new Map<number, FileCommentAnnotationEntry[]>();
  for (const annotation of annotations) {
    const entry: FileCommentAnnotationEntry =
      annotation.kind === "draft"
        ? // A draft's text stays out, so typing in the box does not re-render the file.
          { id: annotation.id, kind: "draft", ...annotation.range, text: "" }
        : {
            id: annotation.id,
            kind: "comment",
            startLine: annotation.comment.startIndex + 1,
            endLine: annotation.comment.endIndex + 1,
            text: annotation.comment.text,
          };
    byLine.set(entry.endLine, [...(byLine.get(entry.endLine) ?? []), entry]);
  }
  return Array.from(byLine, ([lineNumber, entries]) => ({ lineNumber, metadata: { entries } }));
}

/** Whether two annotation lists show the same comments on the same lines. */
export function sameFileCommentAnnotations(
  left: ReadonlyArray<FileCommentLineAnnotation>,
  right: ReadonlyArray<FileCommentLineAnnotation>,
): boolean {
  return (
    left.length === right.length &&
    left.every((annotation, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        annotation.lineNumber === other.lineNumber &&
        annotation.metadata.entries.length === other.metadata.entries.length &&
        annotation.metadata.entries.every((entry, entryIndex) => {
          const otherEntry = other.metadata.entries[entryIndex];
          return (
            otherEntry !== undefined &&
            entry.id === otherEntry.id &&
            entry.kind === otherEntry.kind &&
            entry.startLine === otherEntry.startLine &&
            entry.endLine === otherEntry.endLine &&
            entry.text === otherEntry.text
          );
        })
      );
    })
  );
}

interface EditorPosition {
  readonly line: number;
  readonly character: number;
}

/** The text of the editor's first selection that is not just a caret. */
export function editorSelectedText(
  text: string,
  selections: ReadonlyArray<{ readonly start: EditorPosition; readonly end: EditorPosition }>,
): string | undefined {
  const selection = selections.find(
    ({ start, end }) => start.line !== end.line || start.character !== end.character,
  );
  if (!selection) return undefined;
  const backward =
    selection.start.line > selection.end.line ||
    (selection.start.line === selection.end.line &&
      selection.start.character > selection.end.character);
  const from = backward ? selection.end : selection.start;
  const to = backward ? selection.start : selection.end;
  const lines = text.split("\n").slice(from.line, to.line + 1);
  const last = lines.length - 1;
  if (last < 0) return undefined;
  lines[last] = lines[last]!.slice(0, to.character);
  lines[0] = lines[0]!.slice(from.character);
  return lines.join("\n");
}
