import { DEFAULT_TOKENIZE_MAX_LENGTH, type FileContents } from "@pierre/diffs";
import { useEffect, useState } from "react";

import { getRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";

import { useDiffWorkerPool } from "../../DiffWorkerPoolProvider";
import type { SbsSide } from "./sbsModel";

/** The highlighted rows of each side, as the worker pool rendered them; null while plain. */
export type SbsHighlightedRows = Readonly<Record<SbsSide, ArrayLike<unknown> | null>>;

interface HighlightedFile {
  readonly file: FileContents;
  readonly rows: ArrayLike<unknown>;
}

/**
 * Syntax colours for both panes from the shared worker pool, so a large file is lexed off the
 * main thread and the panes scroll as plain text until its colours arrive.
 */
export function useSbsHighlight(
  files: Readonly<Record<SbsSide, FileContents | null>>,
  lineCounts: Readonly<Record<SbsSide, number>>,
): SbsHighlightedRows {
  const pool = useDiffWorkerPool();
  const [highlighted, setHighlighted] = useState<
    Readonly<Record<SbsSide, HighlightedFile | null>>
  >({ deletions: null, additions: null });
  const { deletions, additions } = files;
  const deletionLines = lineCounts.deletions;
  const additionLines = lineCounts.additions;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the diff worker pool to highlight both files and stores its rows when they land or its theme changes
  useEffect(() => {
    if (pool?.isWorkingPool() !== true) return;
    let active = true;
    const sides = [
      { side: "deletions", file: deletions, lines: deletionLines },
      { side: "additions", file: additions, lines: additionLines },
    ] as const;
    const read = () => {
      if (!active) return;
      setHighlighted({
        deletions: readRows(deletions),
        additions: readRows(additions),
      });
    };
    const readRows = (file: FileContents | null): HighlightedFile | null => {
      const rows = file ? pool.getFileResultCache(file)?.result.code : undefined;
      return file && rows ? { file, rows } : null;
    };
    const prime = () => {
      // A pool still switching to the page's appearance is asked again when it gets there:
      // a request under the theme it is leaving fails in the worker.
      if (pool.getFileRenderOptions().theme !== resolveDiffThemeName(getRenderedAppearance())) {
        return;
      }
      for (const { file, lines } of sides) {
        if (file === null || lines > DEFAULT_TOKENIZE_MAX_LENGTH) continue;
        // A failed highlight leaves the pane as plain text.
        pool.primeFileHighlightCache(file).then(read, () => undefined);
      }
    };
    // A request sent before the workers hold the theme fails in the worker.
    (pool.isInitialized() ? Promise.resolve() : pool.initialize()).then(
      () => {
        if (active) prime();
      },
      () => undefined,
    );
    const unsubscribe = pool.subscribeToThemeChanges({ onThemeChange: prime });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [pool, deletions, additions, deletionLines, additionLines]);

  return {
    deletions: highlighted.deletions?.file === deletions ? highlighted.deletions.rows : null,
    additions: highlighted.additions?.file === additions ? highlighted.additions.rows : null,
  };
}
