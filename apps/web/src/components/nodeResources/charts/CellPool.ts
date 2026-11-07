type Listener = () => void;

export interface CellPoolSegment {
  readonly cells: number;
  /** A CSS custom property, read at draw time, e.g. `--primary`. */
  readonly color: string;
}

/**
 * A pool of unit cells (1 GiB of memory, 256 MiB of VRAM) filled in order by segments, kept
 * outside React like `SeriesRing`. Cells past the segments are free.
 */
export class CellPool {
  private cellCount = 0;
  private filled: ReadonlyArray<CellPoolSegment> = [];
  private readonly listeners = new Set<Listener>();

  static create(): CellPool {
    return new CellPool();
  }

  get total(): number {
    return this.cellCount;
  }

  get segments(): ReadonlyArray<CellPoolSegment> {
    return this.filled;
  }

  set(total: number, segments: ReadonlyArray<CellPoolSegment>): void {
    const cells = Math.max(0, Math.round(total));
    if (cells === this.cellCount && sameSegments(segments, this.filled)) return;
    this.cellCount = cells;
    this.filled = segments;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function sameSegments(a: ReadonlyArray<CellPoolSegment>, b: ReadonlyArray<CellPoolSegment>) {
  return (
    a.length === b.length &&
    a.every(
      (segment, index) => segment.cells === b[index]?.cells && segment.color === b[index]?.color,
    )
  );
}
