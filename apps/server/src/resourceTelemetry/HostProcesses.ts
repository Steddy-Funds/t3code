import {
  MACHINE_PROCESSES_MAX_ROWS,
  MACHINE_PROCESSES_MIN_INTERVAL_MS,
  type GpuProcessSample,
  type MachineProcessAdded,
  type MachineProcessFrame,
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
  readonly lastReadAtMs: number | null;
}

export const initialFrameBuilderState: FrameBuilderState = {
  generation: -1,
  sequence: -1,
  nextKey: 0,
  keys: new Map(),
  lastReadAtMs: null,
};

export interface FrameInput {
  readonly generation: number;
  readonly readAtMs: number;
  readonly nowMs: number;
  readonly monitorAvailable: boolean;
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
  readonly top: number | undefined;
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

function staticFields(key: number, process: ResourceTelemetryProcess): MachineProcessAdded {
  return {
    key,
    pid: process.identity.pid,
    ppid: process.ppid,
    startTimeMs: process.identity.startTimeMs,
    name: process.name,
    user: "",
    command: process.command,
  };
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
  const added: Array<MachineProcessAdded> = [];
  const rows = { key: [] as Array<number>, cpu: [] as Array<number>, rss: [] as Array<number> };
  for (const process of selected) {
    const identity = identityOf(process);
    let key = previousKeys.get(identity);
    if (key === undefined) {
      key = nextKey++;
      added.push(staticFields(key, process));
    }
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
    ...(truncated > 0 ? { truncated } : {}),
  };
  return [
    frame,
    {
      generation: input.generation,
      sequence,
      nextKey,
      keys,
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
  readonly lastSampledAtMs: number | null;
}

export const initialHostFrameBuilderState: HostFrameBuilderState = {
  generation: -1,
  sequence: -1,
  nextKey: 0,
  keys: new Map(),
  sent: new Map(),
  lastSampledAtMs: null,
};

export interface HostFrameInput {
  readonly sample: NativeTelemetryClient.NativeHostSample;
  readonly nowMs: number;
  readonly intervalMs: number;
  readonly top: number | undefined;
  readonly gpuProcesses: boolean;
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

function hostStaticFields(
  key: number,
  row: HostRow,
  statics: NativeTelemetryClient.HostProcessStatics,
): MachineProcessAdded {
  const known = statics.get(row.pid);
  // A process the monitor could not read keeps its row with empty static fields.
  const entry = known?.startTimeMs === row.startTimeMs ? known : undefined;
  return {
    key,
    pid: row.pid,
    ppid: row.ppid,
    startTimeMs: row.startTimeMs,
    name: entry?.name ?? "",
    user: entry?.user ?? "",
    command: entry?.command ?? "",
    ...(entry?.containerId ? { containerId: entry.containerId } : {}),
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
  const gpuColumns = input.gpuProcesses && sample.gpuProcesses !== undefined;
  const gpuUse = gpuColumns ? gpuUseByIdentity(sample.gpuProcesses ?? []) : new Map();
  const previousKeys = full ? new Map<string, number>() : state.keys;
  let nextKey = full ? 0 : state.nextKey;

  const keys = new Map<string, number>();
  const sent = new Map<number, SentValues>();
  const parts: Array<{ added: Array<MachineProcessAdded>; rows: FrameRows }> = [];
  let part = { added: [] as Array<MachineProcessAdded>, rows: emptyRows(gpuColumns) };
  let partBytes = 0;
  for (const row of selected) {
    let key = previousKeys.get(row.identity);
    const use = gpuUse.get(row.identity);
    // Absent from the device's process list means the process is not using that GPU.
    const values: SentValues = gpuColumns
      ? [row.cpu, row.rss, use ? use.util : 0, use ? use.vram : 0]
      : [row.cpu, row.rss, null, null];
    if (key === undefined) {
      key = nextKey++;
      const added = hostStaticFields(key, row, statics);
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
    }
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
              Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
                Ref.modify(builder, (state) =>
                  nextHostFrames(state, {
                    sample,
                    nowMs,
                    intervalMs,
                    top: input.top,
                    gpuProcesses,
                  }),
                ),
              ),
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
              return yield* Ref.modify(builder, (state) =>
                nextFrame(state, {
                  generation: snapshot.health.restartCount,
                  readAtMs: DateTime.toEpochMillis(snapshot.readAt),
                  nowMs,
                  monitorAvailable: isMonitorAvailable(snapshot),
                  processes: snapshot.processes,
                  top: input.top,
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
