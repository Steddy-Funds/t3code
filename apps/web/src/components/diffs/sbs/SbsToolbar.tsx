import { ArrowDownIcon, ArrowUpIcon, FoldVerticalIcon, HighlighterIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../ui/menu";
import { Toggle } from "../../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import type { SbsHighlightMode } from "./sbsInline";

const HIGHLIGHT_MODE_LABELS: Record<SbsHighlightMode, string> = {
  words: "Highlight words",
  lines: "Highlight lines",
  none: "Do not highlight",
};

const HIGHLIGHT_MODES = ["words", "lines", "none"] as const;

function isHighlightMode(value: unknown): value is SbsHighlightMode {
  return value === "words" || value === "lines" || value === "none";
}

/** The row above the panes: what the caller names the file with, then this layout's controls. */
export function SbsBar({ leading, children }: { leading?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/70 bg-background ps-3 pe-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{leading}</div>
      {children}
    </div>
  );
}

export interface SbsToolbarProps {
  readonly statusLabel: string;
  readonly canStep: boolean;
  readonly onStep: (direction: "next" | "previous") => void;
  readonly collapseUnchanged: boolean;
  readonly onCollapseUnchangedChange: (collapse: boolean) => void;
  readonly highlightMode: SbsHighlightMode;
  readonly onHighlightModeChange: (mode: SbsHighlightMode) => void;
}

export function SbsToolbar(props: SbsToolbarProps) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {/* First, so its changing width never moves the buttons. */}
      <span
        className="me-1 whitespace-nowrap text-2xs tabular-nums text-muted-foreground"
        aria-live="polite"
        data-sbs-status=""
      >
        {props.statusLabel}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Previous difference"
              disabled={!props.canStep}
              onClick={() => props.onStep("previous")}
            />
          }
        >
          <ArrowUpIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">Previous difference (Shift+F7)</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Next difference"
              disabled={!props.canStep}
              onClick={() => props.onStep("next")}
            />
          }
        >
          <ArrowDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">Next difference (F7)</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              aria-label="Collapse unchanged lines"
              variant="ghost"
              size="sm"
              pressed={props.collapseUnchanged}
              onPressedChange={(pressed) => props.onCollapseUnchangedChange(Boolean(pressed))}
            />
          }
        >
          <FoldVerticalIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {props.collapseUnchanged ? "Show unchanged lines" : "Collapse unchanged lines"}
        </TooltipPopup>
      </Tooltip>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<Button type="button" size="icon-xs" variant="ghost" />}
                aria-label={`Highlighting: ${HIGHLIGHT_MODE_LABELS[props.highlightMode]}`}
              />
            }
          >
            <HighlighterIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">{HIGHLIGHT_MODE_LABELS[props.highlightMode]}</TooltipPopup>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuRadioGroup
            value={props.highlightMode}
            onValueChange={(value) => {
              if (isHighlightMode(value)) props.onHighlightModeChange(value);
            }}
          >
            {HIGHLIGHT_MODES.map((mode) => (
              <DropdownMenuRadioItem key={mode} value={mode} closeOnClick>
                {HIGHLIGHT_MODE_LABELS[mode]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
