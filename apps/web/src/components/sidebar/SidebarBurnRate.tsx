import { formatTokens } from "@t3tools/shared/usageFormat";
import { FlameIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarBurnRate(props: { tokensPerMinute: number }) {
  const rate = `${formatTokens(props.tokensPerMinute)}/m`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={`${rate} tokens per minute`}
            className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums"
          />
        }
      >
        <FlameIcon aria-hidden className="size-3 shrink-0 text-icon-muted" />
        <span className="text-secondary-label">{rate}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">Tokens per minute, last 5 minutes, agents included</TooltipPopup>
    </Tooltip>
  );
}
