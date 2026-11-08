import { BoxesIcon, ContainerIcon, LinkIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import type { OwnerKind, OwnerLabel } from "./OwnerLabel";

const KIND_ICON: Partial<Record<OwnerKind, typeof BoxesIcon>> = {
  bucket: BoxesIcon,
  claimed: LinkIcon,
  container: ContainerIcon,
};

/**
 * Names who a process belongs to. The dot carries the owner's colour in resource views (the memory
 * pool); owners without one are gray. A shared root reads muted and italic, never split by a guess.
 */
export function OwnerChip({
  label,
  color,
  className,
}: {
  readonly label: OwnerLabel;
  /** A CSS colour for the dot; omitted, the neutral "other" gray. */
  readonly color?: string | undefined;
  readonly className?: string;
}) {
  const Icon = KIND_ICON[label.kind];
  const quiet = label.kind === "shared" || label.kind === "other";
  const chip = (
    <span
      data-owner-kind={label.kind}
      className={cn(
        "inline-flex h-4.5 min-w-0 max-w-44 items-center gap-1 rounded-full bg-accent px-1.5 text-2xs leading-none",
        quiet ? "text-muted-foreground" : "text-foreground",
        label.kind === "shared" && "italic",
        className,
      )}
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-xs"
        style={{ background: color ?? "var(--color-zinc-400)" }}
      />
      {Icon ? <Icon aria-hidden className="size-3 shrink-0 opacity-70" /> : null}
      <span className="truncate">{label.text}</span>
    </span>
  );
  if (label.detail === undefined) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipPopup side="top">{label.detail}</TooltipPopup>
    </Tooltip>
  );
}
