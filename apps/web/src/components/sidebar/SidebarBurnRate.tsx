import { formatTokens } from "@t3tools/shared/usageFormat";
import { FlameIcon } from "lucide-react";
import { useId } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function BurnFlameIcon(props: { className?: string }) {
  // Per instance: a gradient referenced from a hidden row's <defs> would not paint.
  const gradientId = useId();
  return (
    <FlameIcon
      aria-hidden
      stroke={`url(#${CSS.escape(gradientId)})`}
      className={cn("size-3 shrink-0", props.className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="currentColor" className="text-flame-base" />
          <stop offset="55%" stopColor="currentColor" className="text-flame-body" />
          <stop offset="100%" stopColor="currentColor" className="text-flame-tip" />
        </linearGradient>
      </defs>
    </FlameIcon>
  );
}

const VALUE_CLASS = "inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums";
const rateLabel = (tokensPerMinute: number) => `${formatTokens(tokensPerMinute)}/m`;

function BurnRateContent(props: { tokensPerMinute: number }) {
  return (
    <>
      <BurnFlameIcon />
      <span className="text-secondary-label">{rateLabel(props.tokensPerMinute)}</span>
    </>
  );
}

/** A flame and a rate, for places that already explain it. */
export function BurnRateValue(props: { tokensPerMinute: number; className?: string }) {
  return (
    <span
      role="img"
      aria-label={`${rateLabel(props.tokensPerMinute)} tokens per minute`}
      className={cn(VALUE_CLASS, props.className)}
    >
      <BurnRateContent tokensPerMinute={props.tokensPerMinute} />
    </span>
  );
}

export function SidebarBurnRate(props: {
  tokensPerMinute: number;
  description?: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`${rateLabel(props.tokensPerMinute)} tokens per minute`}
            className={cn(VALUE_CLASS, props.className)}
          />
        }
      >
        <BurnRateContent tokensPerMinute={props.tokensPerMinute} />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.description ?? "Tokens per minute, last 5 minutes, agents included"}
      </TooltipPopup>
    </Tooltip>
  );
}
