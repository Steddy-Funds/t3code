import type { CodeLocation, CodePosition } from "@t3tools/contracts";
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup } from "~/components/ui/popover";
import { cn, isMacPlatform } from "~/lib/utils";

import { filterLocations, groupLocationsByFile, parseGoToLine } from "./codeNavigationModel";

export interface CodePopupAnchor {
  readonly getBoundingClientRect: () => DOMRect;
}

export type CodePopup =
  | { readonly kind: "hint"; readonly anchor: CodePopupAnchor; readonly message: string }
  | {
      readonly kind: "locations";
      readonly anchor: CodePopupAnchor;
      readonly title: string;
      readonly note: string | null;
      readonly locations: ReadonlyArray<CodeLocation>;
    }
  | { readonly kind: "documentation"; readonly anchor: CodePopupAnchor; readonly markdown: string }
  | {
      readonly kind: "definition";
      readonly anchor: CodePopupAnchor;
      readonly location: CodeLocation;
      readonly markdown: string;
    }
  | { readonly kind: "goToLine"; readonly anchor: CodePopupAnchor; readonly lineCount: number };

export const CODE_NAVIGATION_POPUP_ATTRIBUTE = "data-code-nav-popup";

interface CodeNavigationPopupProps {
  readonly popup: CodePopup;
  readonly cwd: string;
  /** `restoreFocus` when the user dismissed it from the keyboard. */
  readonly onClose: (restoreFocus: boolean) => void;
  readonly onOpenLocation: (location: CodeLocation, keepOpen: boolean) => void;
  readonly onGoToPosition: (position: CodePosition) => void;
}

function takesFocus(popup: CodePopup): boolean {
  return popup.kind === "locations" || popup.kind === "goToLine";
}

export function CodeNavigationPopup(props: CodeNavigationPopupProps) {
  const { popup } = props;
  return (
    <Popover
      open
      onOpenChange={(open, details) => {
        if (!open) props.onClose(details.reason === "escape-key");
      }}
    >
      <PopoverPopup
        {...{ [CODE_NAVIGATION_POPUP_ATTRIBUTE]: popup.kind }}
        anchor={popup.anchor}
        side="bottom"
        align="start"
        padding="none"
        initialFocus={takesFocus(popup)}
        finalFocus={false}
      >
        {popup.kind === "hint" ? (
          <p role="status" className="max-w-80 px-3 py-2 text-xs">
            {popup.message}
          </p>
        ) : popup.kind === "locations" ? (
          <CodeLocationList
            title={popup.title}
            note={popup.note}
            locations={popup.locations}
            onOpen={props.onOpenLocation}
          />
        ) : popup.kind === "documentation" ? (
          <div className="max-h-80 w-[min(36rem,80vw)] overflow-auto px-3 py-2 text-xs">
            <ChatMarkdown text={popup.markdown} cwd={props.cwd} />
          </div>
        ) : popup.kind === "definition" ? (
          <div className="flex max-h-96 w-[min(40rem,80vw)] flex-col">
            <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-2xs text-muted-foreground">
              <FileLabel
                path={popup.location.path}
                line={popup.location.range.start.line + 1}
                className="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => props.onOpenLocation(popup.location, false)}
              >
                Open
              </Button>
            </div>
            <div className="min-h-0 overflow-auto px-3 py-2 text-xs">
              <ChatMarkdown text={popup.markdown} cwd={props.cwd} />
            </div>
          </div>
        ) : (
          <GoToLineForm lineCount={popup.lineCount} onSubmit={props.onGoToPosition} />
        )}
      </PopoverPopup>
    </Popover>
  );
}

/** The file name first, so a long directory truncates and the name stays readable. */
function FileLabel(props: {
  readonly path: string;
  readonly line?: number;
  readonly className?: string;
}) {
  const slash = Math.max(props.path.lastIndexOf("/"), props.path.lastIndexOf("\\"));
  const name = props.path.slice(slash + 1);
  const directory = slash > 0 ? props.path.slice(0, slash) : "";
  return (
    <div className={cn("flex min-w-0 items-baseline gap-2 font-mono text-2xs", props.className)}>
      <span className="shrink-0 text-foreground">
        {name}
        {props.line === undefined ? null : `:${props.line}`}
      </span>
      <span className="min-w-0 truncate text-muted-foreground">{directory}</span>
    </div>
  );
}

function isModEnter(event: ReactKeyboardEvent): boolean {
  return isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
}

function CodeLocationList(props: {
  readonly title: string;
  readonly note: string | null;
  readonly locations: ReadonlyArray<CodeLocation>;
  readonly onOpen: (location: CodeLocation, keepOpen: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const groups = groupLocationsByFile(filterLocations(props.locations, query));
  const ordered = groups.flatMap((group) => group.locations);
  const active = Math.min(activeIndex, Math.max(0, ordered.length - 1));

  const moveTo = (index: number) => {
    if (ordered.length === 0) return;
    const next = (index + ordered.length) % ordered.length;
    setActiveIndex(next);
    listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") moveTo(active + 1);
    else if (event.key === "ArrowUp") moveTo(active - 1);
    else if (event.key === "Enter") {
      const location = ordered[active];
      if (location) props.onOpen(location, isModEnter(event));
    } else return;
    event.preventDefault();
  };

  const groupStarts: number[] = [];
  let rowCount = 0;
  for (const group of groups) {
    groupStarts.push(rowCount);
    rowCount += group.locations.length;
  }

  return (
    <div className="flex max-h-[min(28rem,60vh)] w-[min(36rem,80vw)] flex-col">
      <div className="flex shrink-0 items-baseline gap-2 px-3 pt-2 text-xs">
        <span className="font-medium">{props.title}</span>
        <span className="text-muted-foreground">
          {ordered.length === props.locations.length
            ? `${props.locations.length} in ${groups.length} ${groups.length === 1 ? "file" : "files"}`
            : `${ordered.length} of ${props.locations.length}`}
        </span>
      </div>
      {props.note ? (
        <p className="shrink-0 px-3 pt-1 text-2xs text-muted-foreground">{props.note}</p>
      ) : null}
      <div className="shrink-0 px-2 py-2">
        <Input
          size="sm"
          value={query}
          placeholder="Filter by file or text"
          aria-label="Filter results"
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div ref={listRef} role="listbox" className="min-h-0 overflow-auto pb-1">
        {groups.map((group, groupIndex) => (
          <div key={group.path} role="group" aria-label={group.path}>
            <FileLabel path={group.path} className="px-3 pt-1.5 pb-0.5" />
            {group.locations.map((location, indexInGroup) => {
              const rowIndex = (groupStarts[groupIndex] ?? 0) + indexInGroup;
              return (
                <div
                  key={`${location.range.start.line}:${location.range.start.character}:${rowIndex}`}
                  role="option"
                  aria-selected={rowIndex === active}
                  data-index={rowIndex}
                  className={cn(
                    "flex cursor-pointer items-baseline gap-2 px-3 py-0.5 font-mono text-xs",
                    rowIndex === active && "bg-accent text-accent-foreground",
                  )}
                  onPointerMove={() => {
                    if (rowIndex !== active) setActiveIndex(rowIndex);
                  }}
                  onClick={(event) =>
                    props.onOpen(
                      location,
                      isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey,
                    )
                  }
                >
                  <span className="w-10 shrink-0 text-right text-muted-foreground tabular-nums">
                    {location.range.start.line + 1}
                  </span>
                  <LinePreview location={location} />
                </div>
              );
            })}
          </div>
        ))}
        {ordered.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">Nothing matches the filter</p>
        ) : null}
      </div>
    </div>
  );
}

function LinePreview({ location }: { readonly location: CodeLocation }) {
  const text = location.lineText;
  if (text === undefined) return <span className="text-muted-foreground">(no preview)</span>;
  const indent = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const { start, end } = location.range;
  const singleLine = start.line === end.line && end.character > start.character;
  const from = singleLine ? Math.max(0, start.character - indent) : -1;
  const to = singleLine ? Math.min(trimmed.length, end.character - indent) : -1;
  if (from < 0 || to <= from) return <span className="min-w-0 truncate">{trimmed}</span>;
  return (
    <span className="min-w-0 truncate">
      {trimmed.slice(0, from)}
      <span className="font-semibold text-foreground">{trimmed.slice(from, to)}</span>
      {trimmed.slice(to)}
    </span>
  );
}

function GoToLineForm(props: {
  readonly lineCount: number;
  readonly onSubmit: (position: CodePosition) => void;
}) {
  const [value, setValue] = useState("");
  const position = parseGoToLine(value, props.lineCount);
  const invalid = value.trim() !== "" && position === null;
  return (
    <form
      className="flex w-64 flex-col gap-1.5 px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (position) props.onSubmit(position);
      }}
    >
      <label className="text-xs font-medium" htmlFor="code-go-to-line">
        Go to line
      </label>
      <Input
        id="code-go-to-line"
        size="sm"
        value={value}
        placeholder="Line[:column]"
        aria-invalid={invalid}
        onChange={(event) => setValue(event.currentTarget.value)}
      />
      <p className={cn("text-2xs", invalid ? "text-destructive" : "text-muted-foreground")}>
        {invalid
          ? `Enter a line from 1 to ${props.lineCount}`
          : `${props.lineCount} ${props.lineCount === 1 ? "line" : "lines"}`}
      </p>
    </form>
  );
}
