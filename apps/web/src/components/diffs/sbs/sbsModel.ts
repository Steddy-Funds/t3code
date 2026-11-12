import type { FileDiffMetadata } from "@pierre/diffs";

/** Pierre's names: the left pane shows `deletions` (before), the right `additions` (after). */
export type SbsSide = "deletions" | "additions";
export const SBS_SIDES = ["deletions", "additions"] as const satisfies ReadonlyArray<SbsSide>;

export type SbsChangeKind = "modified" | "inserted" | "deleted";

/** Zero-based indices into one side's lines. `end` is exclusive. */
export interface SbsLineRange {
  readonly start: number;
  readonly end: number;
}

export interface SbsChange {
  readonly kind: SbsChangeKind;
  readonly deletions: SbsLineRange;
  readonly additions: SbsLineRange;
  /** Changes with no unchanged line between them are one difference to step to and count. */
  readonly group: number;
}

/** Lines a patch leaves out, sitting just before these indices. Only a patch-only diff has them. */
export interface SbsOmittedLines {
  readonly deletions: number;
  readonly additions: number;
  readonly lines: number;
}

interface SbsLineOrigin {
  readonly deletions: number;
  readonly additions: number;
  readonly deletionLineNumber: number;
  readonly additionLineNumber: number;
}

export interface SbsDocument {
  /** Line text without its line ending. */
  readonly lines: Readonly<Record<SbsSide, ReadonlyArray<string>>>;
  readonly changes: ReadonlyArray<SbsChange>;
  readonly groupCount: number;
  readonly omitted: ReadonlyArray<SbsOmittedLines>;
  /** True when the lines are a patch's hunks, not the whole files. */
  readonly partial: boolean;
  /** Where line numbering restarts: once for whole files, per hunk for a patch. */
  readonly origins: ReadonlyArray<SbsLineOrigin>;
  /** The widest line of either side, in columns, a tab counted at its full width. */
  readonly maxColumns: number;
  /** The digits of the highest line number of either side. */
  readonly lineNumberDigits: number;
}

/** How wide a tab is drawn. */
const SBS_TAB_SIZE = 4;

function withoutLineEnding(line: string): string {
  if (!line.endsWith("\n")) return line;
  return line.endsWith("\r\n") ? line.slice(0, -2) : line.slice(0, -1);
}

function changeKind(deletions: number, additions: number): SbsChangeKind {
  if (deletions === 0) return "inserted";
  return additions === 0 ? "deleted" : "modified";
}

function widestLine(lines: ReadonlyArray<string>): number {
  let widest = 0;
  for (const line of lines) {
    let columns = line.length;
    for (let tab = line.indexOf("\t"); tab !== -1; tab = line.indexOf("\t", tab + 1)) {
      columns += SBS_TAB_SIZE - 1;
    }
    if (columns > widest) widest = columns;
  }
  return widest;
}

const documents = new WeakMap<FileDiffMetadata, SbsDocument>();

/** The document of a diff. One per diff object, so everything derived from it can be kept. */
export function sbsDocumentOf(fileDiff: FileDiffMetadata): SbsDocument {
  const cached = documents.get(fileDiff);
  if (cached) return cached;
  const document = buildSbsDocument(fileDiff);
  documents.set(fileDiff, document);
  return document;
}

export function buildSbsDocument(fileDiff: FileDiffMetadata): SbsDocument {
  const changes: SbsChange[] = [];
  const omitted: SbsOmittedLines[] = [];
  const origins: SbsLineOrigin[] = [];
  let group = -1;

  for (const hunk of fileDiff.hunks) {
    // A new or deleted file has no lines on one side, which Pierre indexes as -1.
    const hunkDeletions = Math.max(0, hunk.deletionLineIndex);
    const hunkAdditions = Math.max(0, hunk.additionLineIndex);
    if (fileDiff.isPartial) {
      origins.push({
        deletions: hunkDeletions,
        additions: hunkAdditions,
        deletionLineNumber: hunk.deletionStart,
        additionLineNumber: hunk.additionStart,
      });
      if (hunk.collapsedBefore > 0) {
        omitted.push({
          deletions: hunkDeletions,
          additions: hunkAdditions,
          lines: hunk.collapsedBefore,
        });
      }
    }
    let previous: SbsChange | undefined;
    for (const content of hunk.hunkContent) {
      if (content.type !== "change") {
        previous = undefined;
        continue;
      }
      const deletionsStart = Math.max(0, content.deletionLineIndex);
      const additionsStart = Math.max(0, content.additionLineIndex);
      if (previous === undefined) group += 1;
      previous = {
        kind: changeKind(content.deletions, content.additions),
        deletions: { start: deletionsStart, end: deletionsStart + content.deletions },
        additions: { start: additionsStart, end: additionsStart + content.additions },
        group,
      };
      changes.push(previous);
    }
  }

  const lines = {
    deletions: fileDiff.deletionLines.map(withoutLineEnding),
    additions: fileDiff.additionLines.map(withoutLineEnding),
  };
  const document: SbsDocument = {
    lines,
    changes,
    groupCount: group + 1,
    omitted,
    partial: fileDiff.isPartial,
    origins: fileDiff.isPartial
      ? origins
      : [{ deletions: 0, additions: 0, deletionLineNumber: 1, additionLineNumber: 1 }],
    maxColumns: Math.max(widestLine(lines.deletions), widestLine(lines.additions)),
    lineNumberDigits: 1,
  };
  const lastLineNumber = Math.max(
    sbsLineNumber(document, "deletions", Math.max(0, lines.deletions.length - 1)),
    sbsLineNumber(document, "additions", Math.max(0, lines.additions.length - 1)),
  );
  return { ...document, lineNumberDigits: String(lastLineNumber).length };
}

/** The file line number (1-based) of a line index. */
export function sbsLineNumber(document: SbsDocument, side: SbsSide, index: number): number {
  let origin = document.origins[0];
  for (const candidate of document.origins) {
    if (candidate[side] > index) break;
    origin = candidate;
  }
  if (origin === undefined) return index + 1;
  const first = side === "deletions" ? origin.deletionLineNumber : origin.additionLineNumber;
  return first + (index - origin[side]);
}

/** The line index of a file line number, or -1 when the document does not hold that line. */
export function sbsLineIndex(document: SbsDocument, side: SbsSide, lineNumber: number): number {
  const lineCount = document.lines[side].length;
  for (let index = document.origins.length - 1; index >= 0; index -= 1) {
    const origin = document.origins[index]!;
    const first = side === "deletions" ? origin.deletionLineNumber : origin.additionLineNumber;
    if (lineNumber < first) continue;
    const next = document.origins[index + 1];
    const lineIndex = origin[side] + (lineNumber - first);
    return lineIndex < (next?.[side] ?? lineCount) ? lineIndex : -1;
  }
  return -1;
}

type SbsGroupRanges = ReadonlyArray<Readonly<Record<SbsSide, SbsLineRange>>>;

const groupRanges = new WeakMap<SbsDocument, SbsGroupRanges>();

/** Both sides of every difference: from its first change's start to its last change's end. */
export function sbsGroupRanges(document: SbsDocument): SbsGroupRanges {
  const cached = groupRanges.get(document);
  if (cached) return cached;
  const ranges: Record<SbsSide, SbsLineRange>[] = [];
  for (const change of document.changes) {
    const group = ranges[change.group];
    ranges[change.group] = {
      deletions: {
        start: group?.deletions.start ?? change.deletions.start,
        end: change.deletions.end,
      },
      additions: {
        start: group?.additions.start ?? change.additions.start,
        end: change.additions.end,
      },
    };
  }
  groupRanges.set(document, ranges);
  return ranges;
}
