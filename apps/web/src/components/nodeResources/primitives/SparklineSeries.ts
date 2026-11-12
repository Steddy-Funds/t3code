import type { SeriesRing } from "../charts/SeriesRing";

export interface AgedPoint {
  /** How long before `nowMs` the point was sampled. */
  readonly ageMs: number;
}

/**
 * The ring's columns from points sampled every `stepMs`, newest at the right edge. Each point lands
 * in the slot its age rounds to; slots without a point stay NaN, so a gap (no turn running) breaks
 * the line instead of being bridged. Points older than the ring's window are dropped.
 */
export function sparklineColumns<Point extends AgedPoint>(
  points: ReadonlyArray<Point>,
  readers: ReadonlyArray<(point: Point) => number | null>,
  capacity: number,
  stepMs: number,
): Float32Array[] {
  const columns = readers.map(() => new Float32Array(capacity).fill(Number.NaN));
  for (const point of points) {
    const slot = capacity - 1 - Math.round(point.ageMs / stepMs);
    if (slot < 0 || slot >= capacity) continue;
    readers.forEach((read, column) => {
      columns[column]![slot] = read(point) ?? Number.NaN;
    });
  }
  return columns;
}

/** Replaces the ring's contents with `points`, ending at `nowMs`. */
export function seedSparkline<Point extends AgedPoint>(
  ring: SeriesRing,
  points: ReadonlyArray<Point>,
  readers: ReadonlyArray<(point: Point) => number | null>,
  stepMs: number,
  nowMs: number,
): void {
  ring.seed(sparklineColumns(points, readers, ring.capacity, stepMs), stepMs, nowMs);
}
