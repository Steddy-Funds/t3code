import {
  MACHINE_PROCESSES_MAX_ROWS,
  MACHINE_PROCESSES_MIN_INTERVAL_MS,
  type Claim,
  type GpuProcessSample,
  type MachineProcessAdded,
  type MachineProcessFrame,
  type ProcessOwner,
  type ResourceTelemetryProcess,
  type ResourceTelemetrySnapshot,
  type SubscribeMachineProcessesInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import { ProcessOwnership, type OwnershipRow } from "./ProcessOwnership.ts";
import * as ResourceTelemetry from "./ResourceTelemetry.ts";

export class HostProcesses extends Context.Service<
  HostProcesses,
  {
    /**
     * Process frames at max(intervalMs, 1 s): host-wide from a v4 monitor, otherwise the T3
     * subtree. Full on subscribe, on each new generation and after the monitor's `staticReset`.
     */
    readonly frames: (input: SubscribeMachineProcessesInput) => Stream.Stream<MachineProcessFrame>;
  }
>()("t3/resourceTelemetry/HostProcesses") {}

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
  const { selected, truncated } = input.monitorAvailable
    ? selectProcesses(input.processes, input.top)
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

  const { selected, truncated } = selectTop(hostRows(sample), input.top, hostByCpu, hostByRss);
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

  return HostProcesses.of({ frames });
});

export const layer = Layer.effect(HostProcesses, make());
