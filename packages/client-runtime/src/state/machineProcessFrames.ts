import {
  isUnknownUnionMember,
  type Claim,
  type MachineProcessAdded,
  type MachineProcessFrame,
  type MachineProcessSource,
  type ProcessOwner,
} from "@t3tools/contracts";

export interface MachineProcessRow extends Omit<MachineProcessAdded, "owner"> {
  /** Absent when unattributed: from a server before ownership, or an owner kind this client predates. */
  readonly owner?: ProcessOwner;
  /** Percent of one core. */
  readonly cpu: number;
  /** Resident bytes. */
  readonly rss: number;
  /** GPU util percent and VRAM bytes; absent unless the stream carries GPU columns, null where unmeasured. */
  readonly gpuUtil?: number | null;
  readonly vram?: number | null;
}

export interface MachineProcessTable {
  readonly generation: number;
  readonly sequence: number;
  readonly sampleAgeMs: number;
  readonly source: MachineProcessSource;
  readonly rows: ReadonlyArray<MachineProcessRow>;
  /** Rows the server left out past its row cap. */
  readonly truncated: number;
  /** The machine's claims; absent from a server without ownership. */
  readonly claims?: ReadonlyArray<Claim>;
}

interface KeyedTable {
  readonly generation: number;
  sequence: number;
  sampleAgeMs: number;
  source: MachineProcessSource;
  truncated: number;
  claims: ReadonlyArray<Claim> | undefined;
  readonly entries: Map<number, MachineProcessRow>;
}

function foldFrame(table: KeyedTable, frame: MachineProcessFrame): void {
  for (const key of frame.removed) table.entries.delete(key);
  for (const { owner, ...added } of frame.added) {
    table.entries.set(added.key, {
      ...added,
      ...(owner === undefined || isUnknownUnionMember(owner) ? {} : { owner }),
      cpu: 0,
      rss: 0,
    });
  }
  const { key, cpu, rss, gpuUtil, vram } = frame.rows;
  for (let index = 0; index < key.length; index++) {
    const entry = table.entries.get(key[index]!);
    // A row for a key the table never received is unusable without its static fields.
    if (entry === undefined) continue;
    table.entries.set(entry.key, {
      ...entry,
      cpu: cpu[index]!,
      rss: rss[index]!,
      ...(gpuUtil === undefined ? {} : { gpuUtil: gpuUtil[index] ?? null }),
      ...(vram === undefined ? {} : { vram: vram[index] ?? null }),
    });
  }
  table.sequence = frame.sequence;
  table.sampleAgeMs = frame.sampleAgeMs;
  table.source = frame.source;
  table.truncated = frame.truncated ?? 0;
  if (frame.claims !== undefined) table.claims = frame.claims;
}

function toTable(table: KeyedTable): MachineProcessTable {
  return {
    generation: table.generation,
    sequence: table.sequence,
    sampleAgeMs: table.sampleAgeMs,
    source: table.source,
    rows: [...table.entries.values()],
    truncated: table.truncated,
    ...(table.claims === undefined ? {} : { claims: table.claims }),
  };
}

function emptyTable(frame: MachineProcessFrame): KeyedTable {
  return {
    generation: frame.generation,
    sequence: frame.sequence,
    sampleAgeMs: frame.sampleAgeMs,
    source: frame.source,
    truncated: 0,
    claims: undefined,
    entries: new Map(),
  };
}

/**
 * Folds one subscription's frames into a keyed table. `apply` returns the table after a frame
 * that changes what a view should show, and null while a split full frame is incomplete or for
 * a diff the table cannot use (stale sequence, another generation, no full frame yet).
 */
export function createMachineProcessFrameApplier() {
  let current: KeyedTable | null = null;
  let pending: KeyedTable | null = null;

  const apply = (frame: MachineProcessFrame): MachineProcessTable | null => {
    if (frame.full) {
      if (pending === null || pending.generation !== frame.generation) pending = emptyTable(frame);
      foldFrame(pending, frame);
      if (frame.complete === false) return null;
      current = pending;
      pending = null;
      return toTable(current);
    }
    if (
      current === null ||
      pending !== null ||
      frame.generation !== current.generation ||
      frame.sequence <= current.sequence
    ) {
      return null;
    }
    foldFrame(current, frame);
    return toTable(current);
  };

  return { apply };
}
