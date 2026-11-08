import type { MachineProcessTable } from "@t3tools/client-runtime/state/machineProcessFrames";
import type { ProcessOwner } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { topMemoryOwners } from "./processOwners";

export type ProcessesResult = AsyncResult.AsyncResult<MachineProcessTable, unknown>;

export interface OwnerPaletteEntry {
  readonly key: string;
  readonly owner: ProcessOwner;
  readonly color: string;
}

export interface OwnerPalette {
  readonly entries: ReadonlyArray<OwnerPaletteEntry>;
  readonly colorOf: (key: string) => string | undefined;
}

const EMPTY: OwnerPalette = { entries: [], colorOf: () => undefined };

const samePalette = (a: OwnerPalette, b: OwnerPalette) =>
  a.entries.length === b.entries.length &&
  a.entries.every((entry, index) => {
    const other = b.entries[index];
    // A shared owner's thread count changes its label under the same key.
    return (
      entry.key === other?.key &&
      entry.color === other.color &&
      JSON.stringify(entry.owner) === JSON.stringify(other.owner)
    );
  });

/**
 * The colours of the top memory owners in one process stream, shared by the memory pool and the
 * process list's owner dots. Stable while the same owners stay on top, so frames don't repaint rows.
 */
export const ownerPaletteAtom = Atom.family((processes: Atom.Atom<ProcessesResult>) =>
  Atom.make((get): OwnerPalette => {
    const table = Option.getOrNull(AsyncResult.value(get(processes)));
    if (table === null) return EMPTY;
    const entries = topMemoryOwners(table.rows).map(({ key, owner, color }) => ({
      key,
      owner,
      color,
    }));
    if (entries.length === 0) return EMPTY;
    const colors = new Map(entries.map((entry) => [entry.key, entry.color]));
    return { entries, colorOf: (key) => colors.get(key) };
  }).pipe(Atom.withEquality(samePalette), Atom.withLabel("machine-owner-palette")),
);
