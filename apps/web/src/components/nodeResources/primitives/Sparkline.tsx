import { cn } from "~/lib/utils";

import type { SeriesRing } from "../charts/SeriesRing";
import { TimeSeriesCanvas } from "../charts/TimeSeriesCanvas";

/**
 * A 26 px single-line graph of one ring column, as in thread details. It draws only when the ring
 * changes (one frame per arrival through `TimeSeriesCanvas`), never on a loop. An idle thread's line
 * is muted.
 */
export function Sparkline({
  ring,
  column = 0,
  max,
  idle = false,
  label,
  className,
}: {
  readonly ring: SeriesRing;
  readonly column?: number;
  /** The top of the scale; omitted, a nice scale over the visible values. */
  readonly max?: number;
  readonly idle?: boolean;
  /** The aria-label with the current value; read at each draw. */
  readonly label: () => string;
  readonly className?: string;
}) {
  return (
    <TimeSeriesCanvas
      ring={ring}
      lines={[{ column, color: idle ? "--muted-foreground" : "--primary" }]}
      {...(max === undefined ? {} : { max })}
      label={label}
      className={cn("h-[26px]", className)}
    />
  );
}
