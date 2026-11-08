import { ChevronDown, ChevronRight } from "lucide";
import type { ReactNode } from "react";

import { MorphIcon } from "~/components/MorphIcon";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

const MAX_INDENT = 7;

/** A process or group name with its tree toggle; the tooltip carries the full command. */
export function ProcessTreeName({
  name,
  command,
  depth,
  expandable,
  expanded,
  onToggle,
  children,
}: {
  readonly name: string;
  readonly command?: string;
  readonly depth: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** Shown after the name, such as a group's process count. */
  readonly children?: ReactNode;
}) {
  const label = <span className="min-w-0 truncate font-medium text-foreground">{name}</span>;
  return (
    <div
      className="flex min-w-0 items-center gap-1.5"
      style={{ paddingLeft: `${Math.min(depth, MAX_INDENT) * 10}px` }}
    >
      {expandable ? (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
        >
          <MorphIcon className="size-3.5" icon={expanded ? ChevronDown : ChevronRight} />
        </Button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden />
      )}
      {command ? (
        <Tooltip>
          <TooltipTrigger render={label} />
          <TooltipPopup side="top" variant="code">
            {command}
          </TooltipPopup>
        </Tooltip>
      ) : (
        label
      )}
      {children}
    </div>
  );
}
