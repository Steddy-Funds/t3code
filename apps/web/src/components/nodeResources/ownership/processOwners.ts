import type { MachineProcessRow } from "@t3tools/client-runtime/state/machineProcessFrames";
import type { MachineBucketId, ProcessOwner, ThreadId } from "@t3tools/contracts";

import { type OwnerNames, ownerLabel } from "../primitives/OwnerLabel";
import type { ProcessGroup } from "../processTable/processRows";

/** Owner colours, defined in index.css. Resource views only: the memory pool and owner dots. */
const OWNER_COLORS = ["--owner-1", "--owner-2", "--owner-3", "--owner-4", "--owner-5"] as const;
export const OTHER_OWNER_COLOR = "--owner-other";

const OTHER_KEY = "other";

/**
 * One key per owner a person would name. A claim counts toward its thread, so a thread and the
 * load it claimed group and colour together.
 */
export function ownerKey(owner: ProcessOwner | undefined): string {
  switch (owner?.type) {
    case undefined:
    case "other":
      return OTHER_KEY;
    case "thread":
    case "claimed":
      return `thread:${owner.threadId}`;
    case "shared":
      return `shared:${owner.provider}:${owner.label}`;
    case "t3":
      return `t3:${owner.label}`;
    case "bucket":
      return `bucket:${owner.bucketId}`;
    case "provider":
      return `provider:${owner.provider}`;
    case "container":
      return `container:${owner.id}`;
  }
}

export function ownerThreadId(owner: ProcessOwner | undefined): ThreadId | null {
  return owner?.type === "thread" || owner?.type === "claimed" ? owner.threadId : null;
}

export function ownerBucketId(owner: ProcessOwner | undefined): MachineBucketId | null {
  return owner?.type === "bucket" ? owner.bucketId : null;
}

/** A frame carries owners only from servers with process ownership. */
export const rowsHaveOwners = (rows: ReadonlyArray<MachineProcessRow>) =>
  rows.some((row) => row.owner !== undefined);

export interface OwnerMemory {
  readonly key: string;
  readonly owner: ProcessOwner;
  readonly bytes: number;
  readonly color: string;
}

/**
 * The five owners holding the most memory, each with its colour. Colours follow key order, not
 * rank, so two owners trading places don't swap colours; only a new owner in the top five
 * recolours.
 */
export function topMemoryOwners(rows: ReadonlyArray<MachineProcessRow>): OwnerMemory[] {
  const byKey = new Map<string, { owner: ProcessOwner; bytes: number }>();
  for (const row of rows) {
    if (row.owner === undefined) continue;
    const key = ownerKey(row.owner);
    if (key === OTHER_KEY) continue;
    const entry = byKey.get(key);
    if (entry) entry.bytes += row.rss;
    else byKey.set(key, { owner: row.owner, bytes: row.rss });
  }
  return [...byKey]
    .toSorted(([, a], [, b]) => b.bytes - a.bytes)
    .slice(0, OWNER_COLORS.length)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, entry], index) => ({ key, ...entry, color: OWNER_COLORS[index]! }));
}

export interface OwnerTotals {
  readonly count: number;
  /** Percent of one core. */
  readonly cpu: number;
  readonly rss: number;
  /** Null when any member's GPU use was unmeasured; absent without GPU columns. */
  readonly gpuUtil?: number | null;
  readonly vram?: number | null;
}

/** Sums rows by a key; rows whose key is null are left out. */
export function totalsBy(
  rows: ReadonlyArray<MachineProcessRow>,
  keyOf: (row: MachineProcessRow) => string | null,
): Map<string, OwnerTotals> {
  const totals = new Map<string, OwnerTotals>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    const current = totals.get(key);
    totals.set(key, {
      count: (current?.count ?? 0) + 1,
      cpu: (current?.cpu ?? 0) + row.cpu,
      rss: (current?.rss ?? 0) + row.rss,
      ...("gpuUtil" in row ? { gpuUtil: addMeasured(current, "gpuUtil", row.gpuUtil) } : {}),
      ...("vram" in row ? { vram: addMeasured(current, "vram", row.vram) } : {}),
    });
  }
  return totals;
}

function addMeasured(
  current: OwnerTotals | undefined,
  field: "gpuUtil" | "vram",
  value: number | null | undefined,
): number | null {
  if (value == null) return null;
  if (current === undefined) return value;
  const sum = current[field];
  return sum == null ? null : sum + value;
}

export type ProcessGroupBy = "thread" | "bucket" | "provider";

const NO_BUCKET: ProcessGroup = { id: "bucket:none", label: "No bucket" };

/** Groups by owner: by thread (claims with their thread, then the other owners), or by bucket. */
export function ownerGroupOf(
  by: Exclude<ProcessGroupBy, "provider">,
  names: OwnerNames,
): (row: MachineProcessRow) => ProcessGroup {
  const groups = new Map<string, ProcessGroup>();
  return (row) => {
    if (by === "bucket" && row.owner?.type !== "bucket") return NO_BUCKET;
    const id = ownerKey(row.owner);
    const known = groups.get(id);
    if (known) return known;
    // A claimed row is labelled by its thread here: the group is the thread, not the claim.
    const owner =
      row.owner?.type === "claimed"
        ? { type: "thread" as const, threadId: row.owner.threadId }
        : (row.owner ?? { type: "other" as const });
    const group = { id, label: ownerLabel(owner, names).text };
    groups.set(id, group);
    return group;
  };
}

/** A case-insensitive match on name, command, PID, user, owner and the owner's ids. */
export function processMatches(row: MachineProcessRow, query: string, names: OwnerNames): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = [
    row.name,
    row.command,
    String(row.pid),
    row.user,
    row.owner ? ownerLabel(row.owner, names).text : "",
    ownerThreadId(row.owner) ?? "",
    ownerBucketId(row.owner) ?? "",
  ];
  return haystack.some((value) => value.toLowerCase().includes(needle));
}

/** Who owns a group of same-named processes, in a few words: the one owner, "N threads" or "N owners". */
export function ownersSummary(
  owners: ReadonlyArray<ProcessOwner | undefined>,
  names: OwnerNames,
): string | null {
  const distinct = new Map<string, ProcessOwner>();
  for (const owner of owners) {
    if (owner !== undefined && owner.type !== "other") distinct.set(ownerKey(owner), owner);
  }
  const [first] = distinct.values();
  if (first === undefined) return null;
  if (distinct.size === 1) return ownerLabel(first, names).text;
  const allThreads = [...distinct.values()].every((owner) => ownerThreadId(owner) !== null);
  return `${distinct.size} ${allThreads ? "threads" : "owners"}`;
}
