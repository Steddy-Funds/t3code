import type { EnvironmentId, MachineBucketId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { serverEnvironment } from "~/state/server";
import { environmentThreadShells } from "~/state/threads";

import type { OwnerNames } from "../primitives/OwnerLabel";

export interface MachineOwnerNames extends OwnerNames {
  readonly projectOf: (threadId: ThreadId) => ProjectId | undefined;
}

interface NameTables {
  readonly threads: ReadonlyMap<
    ThreadId,
    { readonly title: string; readonly projectId: ProjectId }
  >;
  readonly buckets: ReadonlyMap<MachineBucketId, string>;
}

const sameTables = (a: NameTables, b: NameTables) =>
  sameMap(a.threads, b.threads, (x, y) => x.title === y.title && x.projectId === y.projectId) &&
  sameMap(a.buckets, b.buckets, (x, y) => x === y);

function sameMap<K, V>(
  a: ReadonlyMap<K, V>,
  b: ReadonlyMap<K, V>,
  same: (x: V, y: V) => boolean,
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined || !same(value, other)) return false;
  }
  return true;
}

// Thread shells change on every thread event; readers render only when a title, project or
// bucket name changes.
const nameTablesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): NameTables => ({
    threads: new Map(
      get(environmentThreadShells.environmentThreadsAtom(environmentId)).map((thread) => [
        thread.id,
        { title: thread.title, projectId: thread.projectId },
      ]),
    ),
    buckets: new Map(
      Object.values(
        get(serverEnvironment.configValueAtom(environmentId))?.settings.machineResources.buckets ??
          {},
      ).map((bucket) => [bucket.id, bucket.name]),
    ),
  })).pipe(Atom.withEquality(sameTables), Atom.withLabel(`machine-owner-names:${environmentId}`)),
);

/** Names for owner chips and id columns on one machine; stable until a name changes. */
export const ownerNamesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): MachineOwnerNames => {
    const tables = get(nameTablesAtom(environmentId));
    return {
      threadTitle: (threadId) => tables.threads.get(threadId)?.title,
      projectOf: (threadId) => tables.threads.get(threadId)?.projectId,
      bucketName: (bucketId) => tables.buckets.get(bucketId),
    };
  }).pipe(Atom.withLabel(`machine-owner-name-lookups:${environmentId}`)),
);

/** Threads a bucket's `thread` rule may point at, in the shell list's order. */
export const ruleThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<{ readonly id: ThreadId; readonly title: string }> =>
    [...get(nameTablesAtom(environmentId)).threads].map(([id, thread]) => ({
      id,
      title: thread.title,
    })),
  ).pipe(Atom.withLabel(`machine-rule-threads:${environmentId}`)),
);
