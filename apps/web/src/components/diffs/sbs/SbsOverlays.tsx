import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { sbsRangeRows, type SbsLayout } from "./sbsLayout";
import type { SbsDocument, SbsSide } from "./sbsModel";

/** Every change marked along the pane's outer edge, beside its scrollbar. */
export function SbsScrollMarks(props: {
  readonly side: SbsSide;
  readonly document: SbsDocument;
  readonly layout: SbsLayout;
  readonly rowCount: number;
  readonly viewportHeight: number;
}) {
  const rowCount = Math.max(1, props.rowCount);
  // Never thinner than two pixels of the strip, however long the file.
  const minimum = (2 * rowCount) / Math.max(1, props.viewportHeight);
  return (
    <svg
      className={cn(
        "sbs-scroll-marks pointer-events-none absolute inset-y-0 w-1.5",
        props.side === "deletions" ? "left-0" : "right-0",
      )}
      viewBox={`0 0 1 ${rowCount}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {props.document.changes.map((change, index) => {
        const rows = sbsRangeRows(props.layout, props.side, change[props.side]);
        return (
          <rect
            // oxlint-disable-next-line react/no-array-index-key -- a change has no identity but its position in the diff
            key={index}
            data-kind={change.kind}
            x={0}
            width={1}
            y={rows.start}
            height={Math.max(rows.end - rows.start, minimum)}
          />
        );
      })}
    </svg>
  );
}

export function SbsFindBar(props: {
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
    props.query.length === 0
      ? ""
      : props.count === 0
        ? "No results"
        : `${props.index + 1}/${props.count}${props.truncated ? "+" : ""}`;
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
        aria-label={props.label}
        placeholder="Find"
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          props.onStep(event.shiftKey ? -1 : 1);
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
        disabled={props.count === 0}
        onClick={() => props.onStep(-1)}
      >
        <ChevronUpIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Next match"
        disabled={props.count === 0}
        onClick={() => props.onStep(1)}
      >
        <ChevronDownIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Close find"
        onClick={props.onClose}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}
