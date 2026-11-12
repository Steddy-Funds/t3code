import { formatTokens } from "@t3tools/shared/usageFormat";
import { FlameIcon } from "lucide-react";
import { useId } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Flicker steps, by tokens per minute; the top one is half a million. */
const HEAT_STEPS = [25_000, 100_000, 250_000, 500_000] as const;

function burnHeat(tokensPerMinute: number): 0 | 1 | 2 | 3 | 4 {
  return HEAT_STEPS.filter((step) => tokensPerMinute >= step).length as 0 | 1 | 2 | 3 | 4;
}

function FlameGlyph(props: { hot?: boolean; className?: string }) {
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
          <stop
            offset="0%"
            stopColor="currentColor"
            className={props.hot ? "text-flame-body" : "text-flame-base"}
          />
          <stop
            offset="55%"
            stopColor="currentColor"
            className={props.hot ? "text-flame-tip" : "text-flame-body"}
          />
          <stop
            offset="100%"
            stopColor="currentColor"
            className={props.hot ? "text-flame-core" : "text-flame-tip"}
          />
        </linearGradient>
      </defs>
    </FlameIcon>
  );
}

/** A hotter copy of the flame flickers over it, faster the more tokens burn. */
function BurnFlameIcon(props: { tokensPerMinute: number }) {
  const heat = burnHeat(props.tokensPerMinute);
  return (
    <span className="relative inline-flex shrink-0">
      <FlameGlyph />
      {heat === 0 ? null : (
        <span data-heat={heat} className="burn-flame-flicker absolute inset-0 inline-flex">
          <FlameGlyph hot />
        </span>
      )}
    </span>
  );
}

const VALUE_CLASS = "inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums";
const rateLabel = (tokensPerMinute: number) => `${formatTokens(tokensPerMinute)}/m`;

function BurnRateContent(props: { tokensPerMinute: number }) {
  return (
    <>
      <BurnFlameIcon tokensPerMinute={props.tokensPerMinute} />
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
