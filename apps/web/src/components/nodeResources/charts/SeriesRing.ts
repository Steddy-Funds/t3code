type Listener = () => void;

/** Samples a graph shows: the labelled span is this many ticks. */
export const CHART_SAMPLES = 60;

/**
 * A fixed-size ring of timestamped rows, one value per column, kept outside React.
 * Charts subscribe and redraw on change; NaN marks a missing value and breaks the line.
 */
export class SeriesRing {
  readonly columns: number;
  readonly capacity: number;
  private readonly values: Float32Array;
  private readonly times: Float64Array;
  private head = 0;
  private count = 0;
  private readonly listeners = new Set<Listener>();

  private constructor(columns: number, capacity: number) {
    this.columns = columns;
    this.capacity = capacity;
    this.values = new Float32Array(columns * capacity);
    this.times = new Float64Array(capacity);
  }

  static create({
    columns = 1,
    capacity = CHART_SAMPLES,
  }: { readonly columns?: number; readonly capacity?: number } = {}): SeriesRing {
    return new SeriesRing(Math.max(1, columns), Math.max(2, capacity));
  }

  get length(): number {
    return this.count;
  }

  /** Time from the oldest kept sample to the newest; 0 with fewer than two. */
  get spanMs(): number {
    return this.count < 2 ? 0 : this.timeAt(this.count - 1) - this.timeAt(0);
  }

  /** `index` counts from the oldest kept sample. */
  valueAt(column: number, index: number): number {
    return this.values[this.slot(index) * this.columns + column] ?? Number.NaN;
  }

  timeAt(index: number): number {
    return this.times[this.slot(index)] ?? Number.NaN;
  }

  /** The newest value of `column`, or NaN when empty. */
  latest(column = 0): number {
    return this.count === 0 ? Number.NaN : this.valueAt(column, this.count - 1);
  }

  /** Appends one row sampled at `atMs`. A row not newer than the last is dropped, so a live snapshot overlapping the seed doesn't repeat. */
  push(row: ArrayLike<number>, atMs: number): void {
    if (this.count > 0 && atMs <= this.timeAt(this.count - 1)) return;
    this.write((column) => row[column], atMs);
    this.emit();
  }

  /**
   * Replaces the contents with history: `values` holds one array per column, oldest first, sampled
   * every `stepMs` and ending at `endAtMs`. Only the newest `capacity` samples are kept.
   */
  seed(values: ReadonlyArray<ArrayLike<number>>, stepMs: number, endAtMs: number): void {
    const length = values.reduce((longest, column) => Math.max(longest, column.length), 0);
    const kept = Math.min(length, this.capacity);
    this.head = 0;
    this.count = 0;
    for (let index = length - kept; index < length; index++) {
      const atMs = endAtMs - (length - 1 - index) * stepMs;
      this.write((column) => values[column]?.[index], atMs);
    }
    this.emit();
  }

  clear(): void {
    if (this.count === 0) return;
    this.head = 0;
    this.count = 0;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private slot(index: number): number {
    return (this.head - this.count + index + this.capacity) % this.capacity;
  }

  private write(read: (column: number) => number | undefined, atMs: number): void {
    const base = this.head * this.columns;
    for (let column = 0; column < this.columns; column++) {
      this.values[base + column] = read(column) ?? Number.NaN;
    }
    this.times[this.head] = atMs;
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
