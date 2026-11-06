import {
  MACHINE_PROCESSES_MAX_ROWS,
  MACHINE_PROCESSES_MIN_INTERVAL_MS,
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
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ResourceTelemetry from "./ResourceTelemetry.ts";

export class HostProcesses extends Context.Service<
  HostProcesses,
  {
    /** Process frames at max(intervalMs, 1 s), full on subscribe and on each new generation. */
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

export function selectProcesses(
  processes: ReadonlyArray<ResourceTelemetryProcess>,
  top: number | undefined,
): { readonly selected: ReadonlyArray<ResourceTelemetryProcess>; readonly truncated: number } {
  if (top === undefined) {
    if (processes.length <= MACHINE_PROCESSES_MAX_ROWS)
      return { selected: processes, truncated: 0 };
    return {
      selected: processes.toSorted(byCpu).slice(0, MACHINE_PROCESSES_MAX_ROWS),
      truncated: processes.length - MACHINE_PROCESSES_MAX_ROWS,
    };
  }
  const byCpuTop = processes.toSorted(byCpu).slice(0, top);
  const byRssTop = processes.toSorted(byRss).slice(0, top);
  return { selected: [...new Set([...byCpuTop, ...byRssTop])], truncated: 0 };
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

function isMonitorAvailable(snapshot: ResourceTelemetrySnapshot): boolean {
  const status = snapshot.health.native.status;
  return status !== "unavailable" && status !== "stopped";
}

const make = Effect.fn("makeHostProcesses")(function* () {
  const telemetry = yield* ResourceTelemetry.ResourceTelemetry;

  const frames = (input: SubscribeMachineProcessesInput) =>
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

  return HostProcesses.of({ frames });
});

export const layer = Layer.effect(HostProcesses, make());
