import {
  MACHINE_PROCESSES_MAX_ROWS,
  MACHINE_PROCESSES_MIN_INTERVAL_MS,
  type Claim,
  type GpuProcessSample,
  type MachineBucketId,
  type MachineProcessAdded,
  type MachineProcessFrame,
  type MachineProcessSnapshot,
  type MachineProcessSnapshotGroupBy,
  type MachineProcessSource,
  type ProcessOwner,
  type ResourceTelemetryProcess,
  type ResourceTelemetrySnapshot,
  type SubscribeMachineProcessesInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import { ownerThreadId, ProcessOwnership, type OwnershipRow } from "./ProcessOwnership.ts";
import * as ResourceTelemetry from "./ResourceTelemetry.ts";

export class HostProcesses extends Context.Service<
  HostProcesses,
  {
    /**
     * Process frames at max(intervalMs, 1 s): host-wide from a v4 monitor, otherwise the T3
     * subtree. Full on subscribe, on each new generation and after the monitor's `staticReset`.
     */
    readonly frames: (input: SubscribeMachineProcessesInput) => Stream.Stream<MachineProcessFrame>;
    /** One process walk, host-wide when the monitor can, otherwise the T3 subtree. */
    readonly snapshot: (
      input: ProcessSnapshotInput,
    ) => Effect.Effect<ProcessSnapshotResult, HostProcessesUnavailable>;
    /** One host-wide walk for auto-buckets; unavailable without a host-mode monitor. */
    readonly unbucketed: (
      input: UnbucketedInput,
    ) => Effect.Effect<UnbucketedResult, HostProcessesUnavailable>;
  }
>()("t3/resourceTelemetry/HostProcesses") {}

export class HostProcessesUnavailable extends Schema.TaggedError<HostProcessesUnavailable>()(
  "HostProcessesUnavailable",
  {},
) {
  override get message(): string {
    return "This machine's resource monitor is not running, so its processes cannot be listed.";
  }
}

export interface ProcessSnapshotInput {
  /** Process rows to list; 0 lists none and skips the per-process GPU walk. */
  readonly limit: number;
  readonly groupBy: MachineProcessSnapshotGroupBy;
  /** False for callers reaching this machine through a peer link. */
  readonly commands: boolean;
  readonly bucketNames: ReadonlyMap<MachineBucketId, string>;
}

export interface BucketTotal {
  readonly bucketId: MachineBucketId;
  readonly name: string;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly count: number;
}

export interface ProcessSnapshotResult {
  readonly snapshot: MachineProcessSnapshot;
  /** Buckets with at least one process, busiest first. */
  readonly buckets: ReadonlyArray<BucketTotal>;
}

export interface UnbucketedInput {
  /** Process rows to list; 0 reads only the share. */
  readonly limit: number;
  /** False for callers reaching this machine through a peer link: no command or cwd. */
  readonly commands: boolean;
  readonly bucketNames: ReadonlyMap<MachineBucketId, string>;
}

export interface UnbucketedProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly exe: string;
  readonly command?: string;
  readonly cwd?: string;
  readonly user: string;
  readonly container?: string;
  readonly parent?: string;
  /** Percent of one core. */
  readonly cpuPercent: number;
  readonly rssBytes: number;
}

export interface UnbucketedResult {
  /** The share of used CPU or memory, whichever is larger, that no thread, claim or bucket owns. */
  readonly sharePercent: number | null;
  readonly sampleAgeMs: number;
  readonly processes: ReadonlyArray<UnbucketedProcess>;
  readonly truncated?: number;
  readonly buckets: ReadonlyArray<BucketTotal>;
}

export interface FrameBuilderState {
  readonly generation: number;
  readonly sequence: number;
  readonly nextKey: number;
  /** Process identity → key for every row the client currently holds. */
  readonly keys: ReadonlyMap<string, number>;
  /** The owner each key was last sent with; a changed owner re-adds the row. */
  readonly owners: ReadonlyMap<number, ProcessOwner>;
  /** The claims last sent, by reference; a new array is sent again. */
  readonly claims: ReadonlyArray<Claim> | null;
  readonly lastReadAtMs: number | null;
}

export const initialFrameBuilderState: FrameBuilderState = {
  generation: -1,
  sequence: -1,
  nextKey: 0,
  keys: new Map(),
  owners: new Map(),
  claims: null,
  lastReadAtMs: null,
};

export interface FrameInput {
  readonly generation: number;
  readonly readAtMs: number;
  readonly nowMs: number;
  readonly monitorAvailable: boolean;
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
  readonly top: number | undefined;
  /** By process key; rows without one are sent without an owner. */
  readonly owners?: ReadonlyMap<string, ProcessOwner>;
  readonly claims?: ReadonlyArray<Claim>;
  /** Only rows this thread owns, directly or through a claim. */
  readonly threadId?: ThreadId;
}

const identityOf = (process: ResourceTelemetryProcess) =>
  `${process.identity.pid}:${process.identity.startTimeMs}`;

const byCpu = (a: ResourceTelemetryProcess, b: ResourceTelemetryProcess) =>
  b.cpuPercent - a.cpuPercent;
const byRss = (a: ResourceTelemetryProcess, b: ResourceTelemetryProcess) =>
  b.residentBytes - a.residentBytes;

/** Top N by CPU together with top N by memory, or the whole table up to the row cap. */
function selectTop<T>(
  items: ReadonlyArray<T>,
  top: number | undefined,
  cpuOrder: (a: T, b: T) => number,
  rssOrder: (a: T, b: T) => number,
): { readonly selected: ReadonlyArray<T>; readonly truncated: number } {
  if (top === undefined) {
    if (items.length <= MACHINE_PROCESSES_MAX_ROWS) return { selected: items, truncated: 0 };
    return {
      selected: items.toSorted(cpuOrder).slice(0, MACHINE_PROCESSES_MAX_ROWS),
      truncated: items.length - MACHINE_PROCESSES_MAX_ROWS,
    };
  }
  const byCpuTop = items.toSorted(cpuOrder).slice(0, top);
  const byRssTop = items.toSorted(rssOrder).slice(0, top);
  return { selected: [...new Set([...byCpuTop, ...byRssTop])], truncated: 0 };
}

export function selectProcesses(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  top: number | undefined,
): { readonly selected: ReadonlyArray<ResourceTelemetryProcess>; readonly truncated: number } {
  return selectTop(processes, top, byCpu, byRss);
}

function staticFields(
  key: number,
  process: ResourceTelemetryProcess,
  owner: ProcessOwner | undefined,
): MachineProcessAdded {
  return {
    key,
    pid: process.identity.pid,
    ppid: process.ppid,
    startTimeMs: process.identity.startTimeMs,
    name: process.name,
    user: "",
    command: process.command,
    ...(owner === undefined ? {} : { owner }),
  };
}

const isOwnedBy = (owner: ProcessOwner | undefined, threadId: ThreadId | undefined) =>
  owner !== undefined && ownerThreadId(owner) === threadId;

function isSameOwner(a: ProcessOwner | undefined, b: ProcessOwner | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.type !== b.type) return false;
  const left: Record<string, unknown> = a;
  const right: Record<string, unknown> = b;
  const fields = Object.keys(left);
  return (
    fields.length === Object.keys(right).length &&
    fields.every((field) => left[field] === right[field])
  );
}

/** The subtree's processes as attribution reads them; it has no user, cwd or cgroup. */
export function subtreeOwnershipRows(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
): Array<OwnershipRow> {
  return processes.map((process) => ({
    pid: process.identity.pid,
    ppid: process.ppid,
    startTimeMs: process.identity.startTimeMs,
    name: process.name,
    command: process.command,
    exe: "",
    cwd: "",
    user: "",
    cgroup: "",
    containerId: "",
  }));
}

/** The next frame for one subscriber, or null when no new sample arrived since the last frame. */
export function nextFrame(
  state: FrameBuilderState,
  input: FrameInput,
): readonly [MachineProcessFrame | null, FrameBuilderState] {
  const full = input.generation !== state.generation;
  if (!full && input.readAtMs === state.lastReadAtMs) return [null, state];

  const previousKeys = full ? new Map<string, number>() : state.keys;
  const processes =
    input.threadId === undefined
      ? input.processes
      : input.processes.filter((process) =>
          isOwnedBy(input.owners?.get(identityOf(process)), input.threadId),
        );
  const { selected, truncated } = input.monitorAvailable
    ? selectProcesses(processes, input.top)
    : { selected: [], truncated: 0 };

  let nextKey = full ? 0 : state.nextKey;
  const keys = new Map<string, number>();
  const owners = new Map<number, ProcessOwner>();
  const added: Array<MachineProcessAdded> = [];
  const rows = { key: [] as Array<number>, cpu: [] as Array<number>, rss: [] as Array<number> };
  for (const process of selected) {
    const identity = identityOf(process);
    const owner = input.owners?.get(identity);
    let key = previousKeys.get(identity);
    if (key === undefined) {
      key = nextKey++;
      added.push(staticFields(key, process, owner));
    } else if (!isSameOwner(state.owners.get(key), owner)) {
      added.push(staticFields(key, process, owner));
    }
    if (owner !== undefined) owners.set(key, owner);
    keys.set(identity, key);
    rows.key.push(key);
    rows.cpu.push(process.cpuPercent);
    rows.rss.push(process.residentBytes);
  }
  const removed: Array<number> = [];
  for (const [identity, key] of previousKeys) {
    if (!keys.has(identity)) removed.push(key);
  }

  const sequence = state.sequence + 1;
  const frame: MachineProcessFrame = {
    generation: input.generation,
    full,
    sequence,
    sampleAgeMs: Math.max(0, input.nowMs - input.readAtMs),
    source: "t3",
    added,
    removed,
    rows,
    ...(input.claims !== undefined && (full || input.claims !== state.claims)
      ? { claims: input.claims }
      : {}),
    ...(truncated > 0 ? { truncated } : {}),
  };
  return [
    frame,
    {
      generation: input.generation,
      sequence,
      nextKey,
      keys,
      owners,
      claims: input.claims ?? null,
      lastReadAtMs: input.readAtMs,
    },
  ];
}

// ~512 KiB of static fields per part keeps one websocket message from stalling the others.
const MAX_ADDED_BYTES_PER_PART = 512 * 1024;
// Field names, keys and numbers in one serialized `added` entry, beyond its strings.
const ADDED_ENTRY_OVERHEAD_BYTES = 120;

/** What one subscriber last sent for a key: cpu, rss, gpu util, vram. */
type SentValues = readonly [number, number, number | null, number | null];

export interface HostFrameBuilderState {
  readonly generation: number;
  readonly sequence: number;
  readonly nextKey: number;
  /** Process identity → key for every row the client currently holds. */
  readonly keys: ReadonlyMap<string, number>;
  readonly sent: ReadonlyMap<number, SentValues>;
  /** Keys added with empty statics; re-added named once the monitor reads them. */
  readonly unnamed: ReadonlySet<number>;
  /** The owner each key was last sent with; a changed owner re-adds the row. */
  readonly owners: ReadonlyMap<number, ProcessOwner>;
  /** The claims last sent, by reference; a new array is sent again. */
  readonly claims: ReadonlyArray<Claim> | null;
  readonly lastSampledAtMs: number | null;
}

export const initialHostFrameBuilderState: HostFrameBuilderState = {
  generation: -1,
  sequence: -1,
  nextKey: 0,
  keys: new Map(),
  sent: new Map(),
  unnamed: new Set(),
  owners: new Map(),
  claims: null,
  lastSampledAtMs: null,
};

export interface HostFrameInput {
  readonly sample: NativeTelemetryClient.NativeHostSample;
  readonly nowMs: number;
  readonly intervalMs: number;
  readonly top: number | undefined;
  readonly gpuProcesses: boolean;
  /** By process key, over every process in the sample. */
  readonly owners?: ReadonlyMap<string, ProcessOwner>;
  readonly claims?: ReadonlyArray<Claim>;
  /** Only rows this thread owns, directly or through a claim. */
  readonly threadId?: ThreadId;
}

interface HostRow {
  readonly identity: string;
  readonly pid: number;
  readonly ppid: number;
  readonly startTimeMs: number;
  readonly cpu: number;
  readonly rss: number;
}

const hostByCpu = (a: HostRow, b: HostRow) => b.cpu - a.cpu;
const hostByRss = (a: HostRow, b: HostRow) => b.rss - a.rss;

// One decimal is all a table shows, and it keeps idle rows unchanged between frames.
const roundCpu = (percent: number) => Math.round(percent * 10) / 10;

/** Every process in a host sample as attribution reads it, statics "" where unread. */
export function hostOwnershipRows(
  sample: NativeTelemetryClient.NativeHostSample["sample"],
  statics: NativeTelemetryClient.HostProcessStatics,
): Array<OwnershipRow> {
  const columns = sample.processes;
  if (!columns) return [];
  return columns.pid.map((pid, index) => {
    const startTimeMs = columns.startTimeMs[index]!;
    const known = statics.get(pid);
    const entry = known?.startTimeMs === startTimeMs ? known : undefined;
    return {
      pid,
      ppid: columns.ppid[index]!,
      startTimeMs,
      name: entry?.name ?? "",
      command: entry?.command ?? "",
      exe: entry?.exe ?? "",
      cwd: entry?.cwd ?? "",
      user: entry?.user ?? "",
      cgroup: entry?.cgroup ?? "",
      containerId: entry?.containerId ?? "",
    };
  });
}

function hostRows(sample: NativeTelemetryClient.NativeHostSample["sample"]): Array<HostRow> {
  const columns = sample.processes;
  if (!columns) return [];
  return columns.pid.map((pid, index) => {
    const startTimeMs = columns.startTimeMs[index]!;
    return {
      identity: `${pid}:${startTimeMs}`,
      pid,
      ppid: columns.ppid[index]!,
      startTimeMs,
      cpu: roundCpu(columns.cpuPercent[index]!),
      rss: columns.residentBytes[index]!,
    };
  });
}

/** Per-process GPU use summed over devices; null where no device measured it. */
function gpuUseByIdentity(
  rows: ReadonlyArray<GpuProcessSample>,
): Map<string, { util: number | null; vram: number | null }> {
  const byIdentity = new Map<string, { util: number | null; vram: number | null }>();
  for (const row of rows) {
    const identity = `${row.pid}:${row.startTimeMs}`;
    const current = byIdentity.get(identity) ?? { util: null, vram: null };
    byIdentity.set(identity, {
      util: row.utilPercent === null ? current.util : (current.util ?? 0) + row.utilPercent,
      vram: row.vramBytes === null ? current.vram : (current.vram ?? 0) + row.vramBytes,
    });
  }
  return byIdentity;
}

/**
 * Whether every device's process walk succeeded. A process's GPU columns sum over devices, so
 * one failed walk leaves every process unmeasured rather than showing a partial number.
 */
function isEveryGpuWalked(sample: NativeTelemetryClient.NativeHostSample["sample"]): boolean {
  if (sample.gpuProcesses === undefined || sample.gpuProcessDevices === undefined) return false;
  const walked = new Set(sample.gpuProcessDevices);
  return (sample.gpus ?? []).every((device) => walked.has(device.id));
}

function knownStatics(row: HostRow, statics: NativeTelemetryClient.HostProcessStatics) {
  const known = statics.get(row.pid);
  return known?.startTimeMs === row.startTimeMs ? known : undefined;
}

function hostStaticFields(
  key: number,
  row: HostRow,
  statics: NativeTelemetryClient.HostProcessStatics,
  owner: ProcessOwner | undefined,
): MachineProcessAdded {
  // A process the monitor could not read keeps its row with empty static fields.
  const entry = knownStatics(row, statics);
  return {
    key,
    pid: row.pid,
    ppid: row.ppid,
    startTimeMs: row.startTimeMs,
    name: entry?.name ?? "",
    user: entry?.user ?? "",
    command: entry?.command ?? "",
    ...(entry?.containerId ? { containerId: entry.containerId } : {}),
    ...(owner === undefined ? {} : { owner }),
  };
}

const addedBytes = (added: MachineProcessAdded) =>
  ADDED_ENTRY_OVERHEAD_BYTES +
  added.name.length +
  added.user.length +
  added.command.length +
  (added.containerId?.length ?? 0);

interface FrameRows {
  readonly key: Array<number>;
  readonly cpu: Array<number>;
  readonly rss: Array<number>;
  readonly gpuUtil?: Array<number | null>;
  readonly vram?: Array<number | null>;
}

const emptyRows = (gpuColumns: boolean): FrameRows =>
  gpuColumns ? { key: [], cpu: [], rss: [], gpuUtil: [], vram: [] } : { key: [], cpu: [], rss: [] };

function pushRow(rows: FrameRows, key: number, values: SentValues) {
  rows.key.push(key);
  rows.cpu.push(values[0]);
  rows.rss.push(values[1]);
  rows.gpuUtil?.push(values[2]);
  rows.vram?.push(values[3]);
}

/**
 * The frames for one host sample and one subscriber: none when the sample comes sooner than
 * the subscriber's interval, several when a full frame splits. Diffs carry only rows whose
 * values changed; the client keeps the rest.
 */
export function nextHostFrames(
  state: HostFrameBuilderState,
  input: HostFrameInput,
): readonly [ReadonlyArray<MachineProcessFrame>, HostFrameBuilderState] {
  const { sample, statics, generation } = input.sample;
  const full = generation !== state.generation || sample.staticReset;
  // Concurrent streams share the fastest native interval; a slower subscriber skips samples.
  const tolerance = Math.min(500, input.intervalMs / 2);
  if (
    !full &&
    state.lastSampledAtMs !== null &&
    sample.sampledAtUnixMs - state.lastSampledAtMs < input.intervalMs - tolerance
  ) {
    return [[], state];
  }

  const rows =
    input.threadId === undefined
      ? hostRows(sample)
      : hostRows(sample).filter((row) =>
          isOwnedBy(input.owners?.get(row.identity), input.threadId),
        );
  const { selected, truncated } = selectTop(rows, input.top, hostByCpu, hostByRss);
  // The columns follow the request; a sample without GPU rows sends null (unmeasured) once, so
  // the client never keeps a stale value after GPUs turn off.
  const gpuColumns = input.gpuProcesses;
  const gpuMeasured = isEveryGpuWalked(sample);
  const gpuUse = gpuMeasured ? gpuUseByIdentity(sample.gpuProcesses ?? []) : new Map();
  const previousKeys = full ? new Map<string, number>() : state.keys;
  let nextKey = full ? 0 : state.nextKey;

  const keys = new Map<string, number>();
  const sent = new Map<number, SentValues>();
  const unnamed = new Set<number>();
  const owners = new Map<number, ProcessOwner>();
  const parts: Array<{ added: Array<MachineProcessAdded>; rows: FrameRows }> = [];
  let part = { added: [] as Array<MachineProcessAdded>, rows: emptyRows(gpuColumns) };
  let partBytes = 0;
  for (const row of selected) {
    let key = previousKeys.get(row.identity);
    const use = gpuUse.get(row.identity);
    // Absent from the device's process list means the process is not using that GPU.
    const values: SentValues =
      gpuColumns && gpuMeasured
        ? [row.cpu, row.rss, use ? use.util : 0, use ? use.vram : 0]
        : [row.cpu, row.rss, null, null];
    const named = knownStatics(row, statics) !== undefined;
    const owner = input.owners?.get(row.identity);
    if (
      key !== undefined &&
      ((state.unnamed.has(key) && named) || !isSameOwner(state.owners.get(key), owner))
    ) {
      // Re-added with its values: the client resets a row's values when it is added.
      part.added.push(hostStaticFields(key, row, statics, owner));
      pushRow(part.rows, key, values);
      if (!named) unnamed.add(key);
    } else if (key === undefined) {
      key = nextKey++;
      if (!named) unnamed.add(key);
      const added = hostStaticFields(key, row, statics, owner);
      const bytes = addedBytes(added);
      if (full && partBytes > 0 && partBytes + bytes > MAX_ADDED_BYTES_PER_PART) {
        parts.push(part);
        part = { added: [], rows: emptyRows(gpuColumns) };
        partBytes = 0;
      }
      part.added.push(added);
      partBytes += bytes;
      pushRow(part.rows, key, values);
    } else {
      const last = state.sent.get(key);
      if (
        !last ||
        last[0] !== values[0] ||
        last[1] !== values[1] ||
        last[2] !== values[2] ||
        last[3] !== values[3]
      ) {
        pushRow(part.rows, key, values);
      }
      if (!named) unnamed.add(key);
    }
    if (owner !== undefined) owners.set(key, owner);
    keys.set(row.identity, key);
    sent.set(key, values);
  }
  parts.push(part);

  const removed: Array<number> = [];
  if (!full) {
    for (const [identity, key] of previousKeys) {
      if (!keys.has(identity)) removed.push(key);
    }
  }

  const sequence = state.sequence + 1;
  const sampleAgeMs = Math.max(0, Math.round(input.nowMs - sample.sampledAtUnixMs));
  const split = parts.length > 1;
  const frames = parts.map((current, index): MachineProcessFrame => {
    const last = index === parts.length - 1;
    return {
      generation,
      full,
      ...(split ? { complete: last } : {}),
      sequence,
      sampleAgeMs,
      source: "host",
      added: current.added,
      removed: last ? removed : [],
      rows: current.rows,
      ...(last && input.gpuProcesses && sample.gpus ? { gpus: sample.gpus } : {}),
      ...(last && input.claims !== undefined && (full || input.claims !== state.claims)
        ? { claims: input.claims }
        : {}),
      ...(last && truncated > 0 ? { truncated } : {}),
    };
  });
  return [
    frames,
    {
      generation,
      sequence,
      nextKey,
      keys,
      sent,
      unnamed,
      owners,
      claims: input.claims ?? null,
      lastSampledAtMs: sample.sampledAtUnixMs,
    },
  ];
}

// Enough for a bucket rule's command prefix; whole command lines would swamp an agent's context.
const SNAPSHOT_COMMAND_MAX_CHARS = 512;

/** One process as a snapshot reads it, from either source. */
export interface SnapshotRow {
  readonly identity: string;
  readonly pid: number;
  readonly ppid: number;
  readonly name: string;
  readonly user: string;
  readonly command: string;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly gpuUtilPercent: number | null;
  readonly vramBytes: number | null;
}

export interface SnapshotBuildInput extends ProcessSnapshotInput {
  readonly rows: ReadonlyArray<SnapshotRow>;
  readonly owners: ReadonlyMap<string, ProcessOwner>;
  readonly source: MachineProcessSource;
  readonly sampleAgeMs: number;
}

interface GroupKey {
  readonly key: string;
  readonly label: string;
  readonly owner?: ProcessOwner;
  readonly bucketId?: MachineBucketId;
}

const OTHER_GROUP: GroupKey = { key: "other", label: "other" };

/** A thread's own processes and its claims form one group. */
function ownerGroup(
  owner: ProcessOwner | undefined,
  bucketNames: ReadonlyMap<MachineBucketId, string>,
): GroupKey {
  if (owner === undefined) return OTHER_GROUP;
  switch (owner.type) {
    case "thread":
    case "claimed":
      return {
        key: `thread:${owner.threadId}`,
        label: `thread ${owner.threadId}`,
        owner: { type: "thread", threadId: owner.threadId },
      };
    case "shared":
      return { key: `shared:${owner.provider}:${owner.label}`, label: owner.label, owner };
    case "t3":
      return { key: `t3:${owner.label}`, label: owner.label, owner };
    case "bucket":
      return bucketGroup(owner.bucketId, bucketNames);
    case "provider":
      return { key: `provider:${owner.provider}`, label: owner.provider, owner };
    case "container":
      return { key: `container:${owner.id}`, label: `container ${owner.id.slice(0, 12)}`, owner };
    case "other":
      return OTHER_GROUP;
  }
}

function bucketGroup(
  bucketId: MachineBucketId,
  bucketNames: ReadonlyMap<MachineBucketId, string>,
): GroupKey & { readonly bucketId: MachineBucketId } {
  return {
    key: `bucket:${bucketId}`,
    label: bucketNames.get(bucketId) ?? bucketId,
    owner: { type: "bucket", bucketId },
    bucketId,
  };
}

const NO_BUCKET_GROUP: GroupKey = { key: "none", label: "not in a bucket" };

interface GroupTotal<G extends GroupKey> {
  readonly group: G;
  cpuPercent: number;
  rssBytes: number;
  count: number;
}

function sumGroups<G extends GroupKey>(
  rows: ReadonlyArray<SnapshotRow>,
  groupOf: (row: SnapshotRow) => G | undefined,
): Array<GroupTotal<G>> {
  const totals = new Map<string, GroupTotal<G>>();
  for (const row of rows) {
    const group = groupOf(row);
    if (group === undefined) continue;
    const total = totals.get(group.key) ?? { group, cpuPercent: 0, rssBytes: 0, count: 0 };
    total.cpuPercent += row.cpuPercent;
    total.rssBytes += row.rssBytes;
    total.count += 1;
    totals.set(group.key, total);
  }
  return [...totals.values()].toSorted(
    (a, b) => b.cpuPercent - a.cpuPercent || b.rssBytes - a.rssBytes,
  );
}

const snapshotByCpu = (a: SnapshotRow, b: SnapshotRow) => b.cpuPercent - a.cpuPercent;
const snapshotByRss = (a: SnapshotRow, b: SnapshotRow) => b.rssBytes - a.rssBytes;

/** The agent's view of one process walk: top rows, optional groups and bucket totals. */
export function buildProcessSnapshot(input: SnapshotBuildInput): ProcessSnapshotResult {
  const ownerOf = (row: SnapshotRow) => input.owners.get(row.identity);
  const { selected } = selectTop(
    input.rows,
    Math.ceil(input.limit / 2),
    snapshotByCpu,
    snapshotByRss,
  );
  const listed = selected.toSorted(snapshotByCpu).slice(0, input.limit);
  const processes = listed.map((row) => {
    const owner = ownerOf(row);
    return {
      pid: row.pid,
      ppid: row.ppid,
      name: row.name,
      user: row.user,
      ...(input.commands ? { command: row.command.slice(0, SNAPSHOT_COMMAND_MAX_CHARS) } : {}),
      cpuPercent: roundCpu(row.cpuPercent),
      rssBytes: row.rssBytes,
      ...(row.gpuUtilPercent ? { gpuUtilPercent: row.gpuUtilPercent } : {}),
      ...(row.vramBytes ? { vramBytes: row.vramBytes } : {}),
      ...(owner === undefined ? {} : { owner }),
    };
  });

  const groups =
    input.groupBy === "none"
      ? undefined
      : sumGroups(input.rows, (row): GroupKey => {
          const owner = ownerOf(row);
          if (input.groupBy === "owner") return ownerGroup(owner, input.bucketNames);
          return owner?.type === "bucket"
            ? bucketGroup(owner.bucketId, input.bucketNames)
            : NO_BUCKET_GROUP;
        }).map(({ group, cpuPercent, rssBytes, count }) => ({
          label: group.label,
          ...(group.owner === undefined ? {} : { owner: group.owner }),
          ...(group.bucketId === undefined ? {} : { bucketId: group.bucketId }),
          cpuPercent: roundCpu(cpuPercent),
          rssBytes,
          count,
        }));

  const buckets = sumGroups(input.rows, (row) => {
    const owner = ownerOf(row);
    return owner?.type === "bucket" ? bucketGroup(owner.bucketId, input.bucketNames) : undefined;
  }).map(({ group, cpuPercent, rssBytes, count }) => ({
    bucketId: group.bucketId,
    name: group.label,
    cpuPercent: roundCpu(cpuPercent),
    rssBytes,
    count,
  }));

  const truncated = input.rows.length - listed.length;
  return {
    snapshot: {
      sampleAgeMs: Math.max(0, Math.round(input.sampleAgeMs)),
      source: input.source,
      processes,
      ...(groups === undefined ? {} : { groups }),
      ...(truncated > 0 && input.limit > 0 ? { truncated } : {}),
    },
    buckets,
  };
}

/** Only processes nothing else claims count: a container or an unknown process. */
const isUnbucketed = (owner: ProcessOwner | undefined) =>
  owner === undefined || owner.type === "other" || owner.type === "container";

/**
 * Percent of the processes' summed CPU, or of their summed resident memory if larger, taken by
 * unbucketed processes. Null when the walk measured neither.
 */
export function unbucketedSharePercent(
  rows: ReadonlyArray<{ readonly identity: string; readonly cpu: number; readonly rss: number }>,
  owners: ReadonlyMap<string, ProcessOwner>,
): number | null {
  let cpu = 0;
  let rss = 0;
  let unbucketedCpu = 0;
  let unbucketedRss = 0;
  for (const row of rows) {
    cpu += row.cpu;
    rss += row.rss;
    if (!isUnbucketed(owners.get(row.identity))) continue;
    unbucketedCpu += row.cpu;
    unbucketedRss += row.rss;
  }
  const shares = [
    ...(cpu > 0 ? [(unbucketedCpu / cpu) * 100] : []),
    ...(rss > 0 ? [(unbucketedRss / rss) * 100] : []),
  ];
  return shares.length === 0 ? null : Math.round(Math.max(...shares) * 10) / 10;
}

// Enough for a bucket rule; the auto-buckets agent reads up to 50 of each per run.
const UNBUCKETED_TEXT_MAX_CHARS = SNAPSHOT_COMMAND_MAX_CHARS;

/** The busiest unbucketed processes with the fields bucket rules match on, and the share. */
export function buildUnbucketed(input: {
  readonly sample: NativeTelemetryClient.NativeHostSample;
  readonly owners: ReadonlyMap<string, ProcessOwner>;
  readonly nowMs: number;
  readonly limit: number;
  readonly commands: boolean;
  readonly bucketNames: ReadonlyMap<MachineBucketId, string>;
}): UnbucketedResult {
  const { sample, owners } = input;
  const rows = hostRows(sample.sample);
  const unbucketed = rows.filter((row) => isUnbucketed(owners.get(row.identity)));
  const byCpuTop = unbucketed.toSorted(hostByCpu).slice(0, Math.ceil(input.limit / 2));
  const chosen = new Set(byCpuTop);
  const byRssFill = unbucketed
    .toSorted(hostByRss)
    .filter((row) => !chosen.has(row))
    .slice(0, input.limit - byCpuTop.length);
  const listed = [...byCpuTop, ...byRssFill].toSorted(hostByCpu);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const processes = listed.map((row): UnbucketedProcess => {
    const entry = knownStatics(row, sample.statics);
    const parentRow = byPid.get(row.ppid);
    const parent = parentRow === undefined ? undefined : knownStatics(parentRow, sample.statics);
    return {
      pid: row.pid,
      ppid: row.ppid,
      name: entry?.name ?? "",
      exe: entry?.exe ?? "",
      ...(input.commands
        ? {
            command: (entry?.command ?? "").slice(0, UNBUCKETED_TEXT_MAX_CHARS),
            cwd: (entry?.cwd ?? "").slice(0, UNBUCKETED_TEXT_MAX_CHARS),
          }
        : {}),
      user: entry?.user ?? "",
      ...(entry?.containerId ? { container: entry.containerId } : {}),
      ...(parent?.name ? { parent: parent.name } : {}),
      cpuPercent: row.cpu,
      rssBytes: row.rss,
    };
  });
  const truncated = unbucketed.length - listed.length;
  const { buckets } = buildProcessSnapshot({
    limit: 0,
    groupBy: "none",
    commands: false,
    bucketNames: input.bucketNames,
    rows: hostSnapshotRows(sample),
    owners,
    source: "host",
    sampleAgeMs: 0,
  });
  return {
    sharePercent: unbucketedSharePercent(rows, owners),
    sampleAgeMs: Math.max(0, Math.round(input.nowMs - sample.sample.sampledAtUnixMs)),
    processes,
    ...(truncated > 0 && input.limit > 0 ? { truncated } : {}),
    buckets,
  };
}

/** A host sample's processes for a snapshot; GPU use only where every device was walked. */
export function hostSnapshotRows(
  sample: NativeTelemetryClient.NativeHostSample,
): Array<SnapshotRow> {
  const gpuUse = isEveryGpuWalked(sample.sample)
    ? gpuUseByIdentity(sample.sample.gpuProcesses ?? [])
    : new Map<string, { util: number | null; vram: number | null }>();
  return hostRows(sample.sample).map((row) => {
    const entry = knownStatics(row, sample.statics);
    const use = gpuUse.get(row.identity);
    return {
      identity: row.identity,
      pid: row.pid,
      ppid: row.ppid,
      name: entry?.name ?? "",
      user: entry?.user ?? "",
      command: entry?.command ?? "",
      cpuPercent: row.cpu,
      rssBytes: row.rss,
      gpuUtilPercent: use?.util ?? null,
      vramBytes: use?.vram ?? null,
    };
  });
}

export function subtreeSnapshotRows(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
): Array<SnapshotRow> {
  return processes.map((process) => ({
    identity: identityOf(process),
    pid: process.identity.pid,
    ppid: process.ppid,
    name: process.name,
    user: "",
    command: process.command,
    cpuPercent: process.cpuPercent,
    rssBytes: process.residentBytes,
    gpuUtilPercent: null,
    vramBytes: null,
  }));
}

function isMonitorAvailable(snapshot: ResourceTelemetrySnapshot): boolean {
  const status = snapshot.health.native.status;
  return status !== "unavailable" && status !== "stopped";
}

/** Whether the monitor speaks host mode, after its handshake settles. */
const supportsHostProcesses = Effect.fn("HostProcesses.supportsHostProcesses")(function* (
  native: NativeTelemetryClient.NativeTelemetryClient["Service"],
) {
  const { latest, changes } = yield* native.subscribeHealth;
  const settled =
    latest.status !== "starting"
      ? latest
      : Option.getOrElse(
          yield* changes.pipe(
            Stream.filter((health) => health.status !== "starting"),
            Stream.runHead,
          ),
          () => latest,
        );
  return Option.match(settled.hello, {
    onNone: () => false,
    onSome: (hello) => hello.capabilities.hostProcesses === true,
  });
}, Effect.scoped);

const make = Effect.fn("makeHostProcesses")(function* () {
  const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
  const native = yield* NativeTelemetryClient.NativeTelemetryClient;
  const ownership = yield* ProcessOwnership;

  const hostFrames = (input: SubscribeMachineProcessesInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const builder = yield* Ref.make(initialHostFrameBuilderState);
        const intervalMs = Math.max(MACHINE_PROCESSES_MIN_INTERVAL_MS, input.intervalMs);
        const gpuProcesses = input.gpuProcesses === true;
        return native
          .hostSamples({ intervalMs, processes: true, gpus: gpuProcesses, gpuProcesses })
          .pipe(
            Stream.mapEffect((sample) =>
              Effect.gen(function* () {
                const owners = yield* ownership.attribute(
                  hostOwnershipRows(sample.sample, sample.statics),
                );
                const claims = yield* ownership.claims;
                const nowMs = yield* Clock.currentTimeMillis;
                return yield* Ref.modify(builder, (state) =>
                  nextHostFrames(state, {
                    sample,
                    nowMs,
                    intervalMs,
                    top: input.top,
                    gpuProcesses,
                    owners,
                    claims,
                    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                  }),
                );
              }),
            ),
            Stream.flatMap((frames) => Stream.fromIterable(frames)),
            // The subtree fallback never fails; neither does the host stream from a viewer's side.
            Stream.catch(() => Stream.empty),
          );
      }),
    );

  const subtreeFrames = (input: SubscribeMachineProcessesInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Holding the subscription keeps the native monitor sampling; releasing it lets it idle.
        yield* telemetry.subscribe;
        const builder = yield* Ref.make(initialFrameBuilderState);
        const intervalMs = Math.max(MACHINE_PROCESSES_MIN_INTERVAL_MS, input.intervalMs);
        return Stream.tick(intervalMs).pipe(
          Stream.mapEffect(() =>
            Effect.gen(function* () {
              const snapshot = yield* telemetry.latest;
              const nowMs = yield* Clock.currentTimeMillis;
              const owners = yield* ownership.attribute(subtreeOwnershipRows(snapshot.processes));
              const claims = yield* ownership.claims;
              return yield* Ref.modify(builder, (state) =>
                nextFrame(state, {
                  generation: snapshot.health.restartCount,
                  readAtMs: DateTime.toEpochMillis(snapshot.readAt),
                  nowMs,
                  monitorAvailable: isMonitorAvailable(snapshot),
                  processes: snapshot.processes,
                  top: input.top,
                  owners,
                  claims,
                  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
                }),
              );
            }),
          ),
          Stream.filter((frame): frame is MachineProcessFrame => frame !== null),
        );
      }),
    );

  const frames = (input: SubscribeMachineProcessesInput) =>
    Stream.unwrap(
      Effect.map(supportsHostProcesses(native), (host) =>
        host ? hostFrames(input) : subtreeFrames(input),
      ),
    );

  const hostSnapshot = Effect.fn("HostProcesses.hostSnapshot")(function* (
    input: ProcessSnapshotInput,
  ) {
    const gpuProcesses = input.limit > 0;
    const sample = yield* native.hostSampleNow({
      processes: true,
      gpus: gpuProcesses,
      gpuProcesses,
    });
    const owners = yield* ownership.attribute(hostOwnershipRows(sample.sample, sample.statics));
    const nowMs = yield* Clock.currentTimeMillis;
    return buildProcessSnapshot({
      ...input,
      rows: hostSnapshotRows(sample),
      owners,
      source: "host",
      sampleAgeMs: nowMs - sample.sample.sampledAtUnixMs,
    });
  });

  const subtreeSnapshot = Effect.fn("HostProcesses.subtreeSnapshot")(function* (
    input: ProcessSnapshotInput,
  ) {
    const snapshot = yield* telemetry.refresh.pipe(Effect.catch(() => telemetry.latest));
    if (!isMonitorAvailable(snapshot)) return yield* new HostProcessesUnavailable();
    const owners = yield* ownership.attribute(subtreeOwnershipRows(snapshot.processes));
    const nowMs = yield* Clock.currentTimeMillis;
    return buildProcessSnapshot({
      ...input,
      rows: subtreeSnapshotRows(snapshot.processes),
      owners,
      source: "t3",
      sampleAgeMs: nowMs - DateTime.toEpochMillis(snapshot.readAt),
    });
  });

  const snapshot = Effect.fn("HostProcesses.snapshot")(function* (input: ProcessSnapshotInput) {
    if (!(yield* supportsHostProcesses(native))) return yield* subtreeSnapshot(input);
    return yield* hostSnapshot(input).pipe(Effect.catch(() => subtreeSnapshot(input)));
  });

  const unbucketed = Effect.fn("HostProcesses.unbucketed")(function* (input: UnbucketedInput) {
    if (!(yield* supportsHostProcesses(native))) return yield* new HostProcessesUnavailable();
    const sample = yield* native
      .hostSampleNow({ processes: true, gpus: false, gpuProcesses: false })
      .pipe(Effect.mapError(() => new HostProcessesUnavailable()));
    const owners = yield* ownership.attribute(hostOwnershipRows(sample.sample, sample.statics));
    const nowMs = yield* Clock.currentTimeMillis;
    return buildUnbucketed({ ...input, sample, owners, nowMs });
  });

  return HostProcesses.of({ frames, snapshot, unbucketed });
});

export const layer = Layer.effect(HostProcesses, make());
