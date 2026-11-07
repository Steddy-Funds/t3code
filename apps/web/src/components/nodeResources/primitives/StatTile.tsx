import { type ReactNode, useLayoutEffect, useRef } from "react";

import { cn } from "~/lib/utils";

import type { SeriesRing } from "../charts/SeriesRing";

/**
 * A fixed-size graph tile: label, current value, an optional legend or limit note, the chart, and
 * the window axis. Fixed size and `contain: strict` keep a tick inside the tile.
 */
export function StatTile({
  label,
  value,
  detail,
  tripped = false,
  axis,
  className,
  children,
}: {
  readonly label: ReactNode;
  /** Usually a `LiveValue`, so a tick doesn't render the tile. */
  readonly value: ReactNode;
  /** A legend or limit note ("swap dashed", "limit 12.5"). */
  readonly detail?: ReactNode;
  /** This tile's rule tripped the verdict: the value and note turn the stress colour. */
  readonly tripped?: boolean;
  /** Window labels, oldest first; the last is the live edge. */
  readonly axis?: ReadonlyArray<ReactNode>;
  readonly className?: string;
  /** The chart; it fills the space between header and axis. */
  readonly children: ReactNode;
}) {
  return (
    <div
      data-tripped={tripped || undefined}
      className={cn(
        "flex h-33 min-w-0 flex-col rounded-xl border bg-card px-3 py-2.5 contain-strict data-tripped:border-(--machine-stress)/50",
        className,
      )}
    >
      <div className="flex min-w-0 items-baseline gap-1.5 text-2xs text-muted-foreground">
        <span className="shrink-0">{label}</span>
        <b
          className={cn(
            "shrink-0 text-sm font-semibold tabular-nums",
            tripped ? "text-error-foreground" : "text-foreground",
          )}
        >
          {value}
        </b>
        {detail === undefined ? null : (
          <span
            className={cn("ms-auto min-w-0 truncate text-3xs", tripped && "text-error-foreground")}
          >
            {detail}
          </span>
        )}
      </div>
      <div className="relative mt-1.5 min-h-0 flex-1">{children}</div>
      {axis === undefined || axis.length === 0 ? null : (
        <div className="mt-0.5 flex justify-between text-3xs text-muted-foreground">
          {axis.map((tick, index) => (
            <span
              // oxlint-disable-next-line react/no-array-index-key -- axis ticks are positional
              key={index}
              className={cn(index === axis.length - 1 && "font-medium text-foreground")}
            >
              {tick}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The newest value of a ring column as text, updated in place on each sample without a React
 * render.
 */
export function LiveValue({
  ring,
  column = 0,
  format,
}: {
  readonly ring: SeriesRing;
  readonly column?: number;
  /** Receives NaN while the ring is empty. */
  readonly format: (value: number) => string;
}) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const formatRef = useRef(format);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the latest formatter for the ring subscription, which writes text outside React
  useLayoutEffect(() => {
    formatRef.current = format;
    const span = spanRef.current;
    if (span) span.textContent = format(ring.latest(column));
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes each sample's value straight into the DOM so a tick doesn't render
  useLayoutEffect(
    () =>
      ring.subscribe(() => {
        const span = spanRef.current;
        if (span) span.textContent = formatRef.current(ring.latest(column));
      }),
    [ring, column],
  );

  return <span ref={spanRef} />;
}
