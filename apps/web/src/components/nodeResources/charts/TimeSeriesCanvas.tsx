import { niceScale } from "~/lib/niceScale";
import { cn } from "~/lib/utils";

import { type ChartFrame, useChartCanvas } from "./chartCanvas";
import type { SeriesRing } from "./SeriesRing";

export interface TimeSeriesLine {
  readonly column: number;
  /** A CSS custom property, read at draw time. Defaults to `--primary`. */
  readonly color?: string;
  /** Secondary lines (swap, VRAM) are dashed and unfilled. */
  readonly dashed?: boolean;
}

const STRESS_COLOR = "--machine-stress";
const SCALE_TICKS = 4;

/**
 * A live time-series graph of 1–4 ring columns. The ring's capacity is the window: the newest
 * sample sits at the right edge. The first solid line gets an area fill.
 */
export function TimeSeriesCanvas({
  ring,
  lines,
  max,
  threshold,
  tripped = false,
  label,
  className,
}: {
  readonly ring: SeriesRing;
  readonly lines: ReadonlyArray<TimeSeriesLine>;
  /** The top of the scale; omitted, a nice scale over the visible values and the threshold. */
  readonly max?: number;
  /** Drawn as a dashed limit line in the stress colour. */
  readonly threshold?: number;
  /** Tints the plot when this graph's rule tripped the verdict. */
  readonly tripped?: boolean;
  /** The aria-label, carrying the current value; read at each draw. */
  readonly label: () => string;
  readonly className?: string;
}) {
  const canvasRef = useChartCanvas(ring, (frame) => {
    // A limit above the data stays visible below the top edge instead of pinning to it.
    const top =
      max ??
      (threshold === undefined
        ? autoMax(ring, lines)
        : Math.max(autoMax(ring, lines), niceScale(threshold * 1.1, SCALE_TICKS).max));
    if (tripped) fillBackground(frame, STRESS_COLOR, 0.08);
    const filled = lines.find((line) => !line.dashed);
    if (filled) fillArea(frame, ring, filled, top);
    if (threshold !== undefined) drawThreshold(frame, threshold, top);
    for (const line of lines) drawLine(frame, ring, line, top);
    return label();
  });
  return <canvas ref={canvasRef} role="img" className={cn("block size-full", className)} />;
}

function autoMax(ring: SeriesRing, lines: ReadonlyArray<TimeSeriesLine>): number {
  let peak = 0;
  for (const line of lines) {
    for (let index = 0; index < ring.length; index++) {
      const value = ring.valueAt(line.column, index);
      if (value > peak) peak = value;
    }
  }
  return niceScale(peak, SCALE_TICKS).max || 1;
}

function xAt(ring: SeriesRing, index: number, width: number): number {
  return ((ring.capacity - ring.length + index) / (ring.capacity - 1)) * width;
}

function yAt(value: number, top: number, height: number): number {
  return height - (Math.min(Math.max(value, 0), top) / top) * height;
}

/** Traces the line, starting a new subpath after each missing (NaN) value. */
function tracePath(frame: ChartFrame, ring: SeriesRing, column: number, top: number) {
  const { context, width, height } = frame;
  let drawing = false;
  for (let index = 0; index < ring.length; index++) {
    const value = ring.valueAt(column, index);
    if (Number.isNaN(value)) {
      drawing = false;
      continue;
    }
    const x = xAt(ring, index, width);
    const y = yAt(value, top, height);
    if (drawing) context.lineTo(x, y);
    else context.moveTo(x, y);
    drawing = true;
  }
}

function drawLine(frame: ChartFrame, ring: SeriesRing, line: TimeSeriesLine, top: number) {
  const { context } = frame;
  context.beginPath();
  tracePath(frame, ring, line.column, top);
  context.strokeStyle = frame.color(line.color ?? "--primary");
  context.lineWidth = line.dashed ? 1.25 : 1.5;
  context.lineJoin = "round";
  context.setLineDash(line.dashed ? [3, 2] : []);
  context.stroke();
  context.setLineDash([]);
}

function fillArea(frame: ChartFrame, ring: SeriesRing, line: TimeSeriesLine, top: number) {
  const { context, width, height } = frame;
  let first = -1;
  let last = -1;
  context.beginPath();
  for (let index = 0; index < ring.length; index++) {
    const value = ring.valueAt(line.column, index);
    if (Number.isNaN(value)) continue;
    const x = xAt(ring, index, width);
    if (first < 0) {
      first = x;
      context.moveTo(x, height);
    }
    context.lineTo(x, yAt(value, top, height));
    last = x;
  }
  if (first < 0) return;
  context.lineTo(last, height);
  context.closePath();
  context.globalAlpha = 0.14;
  context.fillStyle = frame.color(line.color ?? "--primary");
  context.fill();
  context.globalAlpha = 1;
}

function drawThreshold(frame: ChartFrame, threshold: number, top: number) {
  const { context, width, height } = frame;
  const y = Math.round(yAt(threshold, top, height)) + 0.5;
  context.beginPath();
  context.moveTo(0, y);
  context.lineTo(width, y);
  context.strokeStyle = frame.color(STRESS_COLOR);
  context.lineWidth = 1;
  context.setLineDash([2, 3]);
  context.stroke();
  context.setLineDash([]);
}

function fillBackground(frame: ChartFrame, color: string, alpha: number) {
  const { context, width, height } = frame;
  context.globalAlpha = alpha;
  context.fillStyle = frame.color(color);
  context.fillRect(0, 0, width, height);
  context.globalAlpha = 1;
}
