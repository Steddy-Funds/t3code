import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { sbsRangeRows, type SbsLayout } from "./sbsLayout";
import type { SbsDocument, SbsSide } from "./sbsModel";

/** Every change marked along the pane's outer edge, beside its scrollbar. */
export function SbsScrollMarks({
  side,
  document,
  layout,
  rowCount: rows,
  viewportHeight,
}: {
  readonly side: SbsSide;
  readonly document: SbsDocument;
  readonly layout: SbsLayout;
  readonly rowCount: number;
  readonly viewportHeight: number;
}) {
  const rowCount = Math.max(1, rows);
  // Never thinner than two pixels of the strip, however long the file.
  const minimum = (2 * rowCount) / Math.max(1, viewportHeight);
  return (
    <svg
      className={cn(
        // An explicit height: an absolutely placed svg otherwise takes its viewBox's proportions.
        "sbs-scroll-marks pointer-events-none absolute top-0 h-full w-1.5",
        side === "deletions" ? "left-0" : "right-0",
      )}
      viewBox={`0 0 1 ${rowCount}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {document.changes.map((change, index) => {
        const changeRows = sbsRangeRows(layout, side, change[side]);
        return (
          <rect
            // oxlint-disable-next-line react/no-array-index-key -- a change has no identity but its position in the diff
            key={index}
            data-kind={change.kind}
            x={0}
            width={1}
            y={changeRows.start}
            height={Math.max(changeRows.end - changeRows.start, minimum)}
          />
        );
      })}
    </svg>
  );
}

export function SbsFindBar({
  label,
  query,
  index,
  count,
  truncated,
  onQueryChange,
  onStep,
  onClose,
}: {
  readonly label: string;
  readonly query: string;
  /** The match the bar is on, zero-based; -1 when there is none. */
  readonly index: number;
  readonly count: number;
  readonly truncated: boolean;
  readonly onQueryChange: (query: string) => void;
  readonly onStep: (direction: 1 | -1) => void;
  readonly onClose: () => void;
}) {
  const position =
    query.length === 0
      ? ""
      : count === 0
        ? "No results"
        : `${index + 1}/${count}${truncated ? "+" : ""}`;
  return (
    <div
      className="absolute top-2 right-4 z-10 flex items-center gap-1 rounded-md border border-border bg-popover p-1 font-sans shadow-md"
      data-sbs-find=""
    >
      <Input
        size="compact"
        className="w-44"
        // Opened by the find key from this pane, so typing goes on here.
        autoFocus
        aria-label={label}
        placeholder="Find"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onStep(event.shiftKey ? -1 : 1);
        }}
      />
      <span className="min-w-14 px-1 text-center text-2xs tabular-nums text-muted-foreground">
        {position}
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Previous match"
        disabled={count === 0}
        onClick={() => onStep(-1)}
      >
        <ChevronUpIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Next match"
        disabled={count === 0}
        onClick={() => onStep(1)}
      >
        <ChevronDownIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Close find"
        onClick={onClose}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}
