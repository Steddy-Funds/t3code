import { useAtomValue } from "@effect/atom-react";
import type { MachineStatusSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, type Atom } from "effect/reactivity";

export type SnapshotResult = AsyncResult.AsyncResult<MachineStatusSnapshot, unknown>;
type Primitive = string | number | boolean | null;

/**
 * One primitive read from the snapshot stream; the caller renders only when it changes, not on
 * every tick. `select` must be stable (module level).
 */
export function useSnapshotValue<A extends Primitive>(
  source: Atom.Atom<SnapshotResult>,
  select: (snapshot: MachineStatusSnapshot | null) => A,
): A {
  const pick = (result: SnapshotResult) => select(Option.getOrNull(AsyncResult.value(result)));
  return useAtomValue(source, pick);
}

/** Per-tick text as its own leaf, so a sample re-renders this span and nothing around it. */
export function SnapshotText({
  source,
  select,
}: {
  readonly source: Atom.Atom<SnapshotResult>;
  readonly select: (snapshot: MachineStatusSnapshot | null) => string;
}) {
  return useSnapshotValue(source, select);
}
