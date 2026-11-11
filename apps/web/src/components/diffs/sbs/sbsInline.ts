import type { LineDiffRangeCache } from "@pierre/diffs";

import type { SbsColumnRange } from "./sbsLineContent";
import type { SbsChange, SbsDocument, SbsSide } from "./sbsModel";

/** JetBrains' highlight policies that this view offers. */
export type SbsHighlightMode = "words" | "lines" | "none";

/** How a changed line is painted. `modified-muted` is a line whose changed words carry the colour. */
export type SbsLineTint = "inserted" | "deleted" | "modified" | "modified-muted";

export interface SbsLineChange {
  readonly tint: SbsLineTint | null;
  readonly changed: ReadonlyArray<SbsColumnRange>;
}

const NO_RANGES: ReadonlyArray<SbsColumnRange> = [];
const UNTINTED: SbsLineChange = { tint: null, changed: NO_RANGES };

/**
 * The paint of one line of a change. A modified block is muted with its changed words at
 * full colour; an insertion or a deletion, and a modified line with no partner on the
 * other side or no word-level difference, is full colour throughout.
 */
export function sbsLineChange(
  document: SbsDocument,
  wordRanges: LineDiffRangeCache,
  mode: SbsHighlightMode,
  side: SbsSide,
  line: number,
  change: SbsChange,
): SbsLineChange {
  if (mode === "none") return UNTINTED;
  if (change.kind !== "modified") return { tint: change.kind, changed: NO_RANGES };
  const offset = line - change[side].start;
  const deletion = change.deletions.start + offset;
  const addition = change.additions.start + offset;
  if (mode === "lines" || deletion >= change.deletions.end || addition >= change.additions.end) {
    return { tint: "modified", changed: NO_RANGES };
  }
  const ranges = wordRanges.get(
    deletion,
    document.lines.deletions[deletion] ?? "",
    document.lines.additions[addition] ?? "",
  );
  if (ranges.deletion.length === 0 && ranges.addition.length === 0) {
    return { tint: "modified", changed: NO_RANGES };
  }
  return {
    tint: "modified-muted",
    changed: side === "deletions" ? ranges.deletion : ranges.addition,
  };
}
