import { cn } from "~/lib/utils";

import type { CellPool } from "./CellPool";
import { type ChartFrame, useChartCanvas } from "./chartCanvas";
import type { SeriesRing } from "./SeriesRing";

/** Each cell is a sparkline of one ring column (per-core load), tinted by its current value. */
interface SparklineCells {
  readonly ring: SeriesRing;
  /** The top of every cell's scale. */
  readonly max?: number;
  /** The value printed in a cell's corner when cells are large enough. */
  readonly format?: (value: number) => string;
  readonly pool?: never;
}

/** Each cell is one unit of a pool (memory, VRAM), coloured by the segment that fills it. */
interface PoolCells {
  readonly pool: CellPool;
  readonly ring?: never;
}

const GAP = 4;
const POOL_GAP = 2;
const LABEL_MIN_WIDTH = 40;
const EMPTY_COLOR = "--muted";

/**
 * N cells laid out in `columns` per row, all drawn on one canvas. The canvas height follows its
 * width, so the grid keeps each cell's aspect ratio.
 */
export function CellGrid({
  columns,
  aspect,
  label,
  className,
  ...cells
}: (SparklineCells | PoolCells) & {
  readonly columns: number;
  /** Cell width over height; sparklines default to 1.55, pool cells are square. */
  readonly aspect?: number;
  /** The aria-label, carrying the current value; read at each draw. */
  readonly label: () => string;
  readonly className?: string;
}) {
  const source = cells.pool ?? cells.ring;
  const gap = cells.pool ? POOL_GAP : GAP;
  const ratio = aspect ?? (cells.pool ? 1 : 1.55);
  const count = () => (cells.pool ? cells.pool.total : cells.ring.columns);

  const layout = (width: number) => {
    const perRow = Math.max(1, columns);
    const cellWidth = Math.max(0, (width - gap * (perRow - 1)) / perRow);
    const rows = Math.ceil(count() / perRow);
    return { perRow, cellWidth, cellHeight: cellWidth / ratio, rows };
  };

  const canvasRef = useChartCanvas(
    source,
    (frame) => {
      const grid = layout(frame.width);
      for (let index = 0; index < count(); index++) {
        const cell = {
          x: (index % grid.perRow) * (grid.cellWidth + gap),
          y: Math.floor(index / grid.perRow) * (grid.cellHeight + gap),
          width: grid.cellWidth,
          height: grid.cellHeight,
        };
        if (cells.pool) drawPoolCell(frame, cell, poolColor(cells.pool, index));
        else drawSparklineCell(frame, cell, cells.ring, index, cells.max ?? 100, cells.format);
      }
      return label();
    },
    (width) => {
      const grid = layout(width);
      return grid.rows === 0 ? 0 : Math.round(grid.rows * grid.cellHeight + gap * (grid.rows - 1));
    },
  );
  return <canvas ref={canvasRef} role="img" className={cn("block w-full", className)} />;
}

interface Cell {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function poolColor(pool: CellPool, index: number): string {
  let end = 0;
  for (const segment of pool.segments) {
    end += segment.cells;
    if (index < end) return segment.color;
  }
  return EMPTY_COLOR;
}

function drawPoolCell(frame: ChartFrame, cell: Cell, color: string) {
  const { context } = frame;
  context.beginPath();
  context.roundRect(cell.x, cell.y, cell.width, cell.height, 2);
  context.fillStyle = frame.color(color);
  context.fill();
}

function drawSparklineCell(
  frame: ChartFrame,
  cell: Cell,
  ring: SeriesRing,
  column: number,
  max: number,
  format: ((value: number) => string) | undefined,
) {
  const { context } = frame;
  const primary = frame.color("--primary");
  const current = ring.latest(column);

  context.save();
  context.beginPath();
  context.roundRect(cell.x + 0.5, cell.y + 0.5, cell.width - 1, cell.height - 1, 3);
  context.fillStyle = frame.color("--card");
  context.fill();
  context.clip();

  const yAt = (value: number) =>
    cell.y + cell.height - (Math.min(Math.max(value, 0), max) / max) * cell.height;
  const xAt = (index: number) =>
    cell.x + ((ring.capacity - ring.length + index) / (ring.capacity - 1)) * cell.width;

  context.beginPath();
  let started = false;
  let lastX = cell.x;
  for (let index = 0; index < ring.length; index++) {
    const value = ring.valueAt(column, index);
    if (Number.isNaN(value)) continue;
    const x = xAt(index);
    if (started) context.lineTo(x, yAt(value));
    else context.moveTo(x, yAt(value));
    started = true;
    lastX = x;
  }
  if (started) {
    context.strokeStyle = primary;
    context.lineWidth = 1;
    context.stroke();
    context.lineTo(lastX, cell.y + cell.height);
    context.lineTo(xAt(firstValueIndex(ring, column)), cell.y + cell.height);
    context.closePath();
    context.globalAlpha = Number.isNaN(current)
      ? 0.12
      : 0.12 + (Math.min(current, max) / max) * 0.55;
    context.fillStyle = primary;
    context.fill();
    context.globalAlpha = 1;
  }
  context.restore();

  context.beginPath();
  context.roundRect(cell.x + 0.5, cell.y + 0.5, cell.width - 1, cell.height - 1, 3);
  context.strokeStyle = frame.color("--border");
  context.lineWidth = 1;
  context.stroke();

  if (cell.width < LABEL_MIN_WIDTH) return;
  context.font = frame.font;
  context.textBaseline = "top";
  context.textAlign = "left";
  context.fillStyle = frame.color("--muted-foreground");
  context.fillText(String(column), cell.x + 3, cell.y + 2);
  if (Number.isNaN(current)) return;
  context.textAlign = "right";
  context.fillStyle = frame.color("--foreground");
  context.fillText(
    format ? format(current) : String(Math.round(current)),
    cell.x + cell.width - 3,
    cell.y + 2,
  );
}

function firstValueIndex(ring: SeriesRing, column: number): number {
  for (let index = 0; index < ring.length; index++) {
    if (!Number.isNaN(ring.valueAt(column, index))) return index;
  }
  return 0;
}
