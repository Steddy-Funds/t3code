import type {
  LoadCondition,
  MachineVerdict,
  ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskLoadSchedule,
} from "@t3tools/contracts";
import type { HostGpuTotals, HostTotals } from "@t3tools/shared/hostTotals";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as HostProcesses from "../resourceTelemetry/HostProcesses.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

export const LOAD_COOLDOWN_MS = 60_000;
export const RELEASE_JITTER_MIN_MS = 20_000;
export const RELEASE_JITTER_MAX_MS = 40_000;
/** The unbucketed share needs a full process walk, so it is read at most this often. */
export const UNBUCKETED_INTERVAL_MS = 3_600_000;
/** Matches the run's own `t3_machine_read` limit, so both see the same top processes. */
const MACHINE_BUCKETS_UNOWNED_LIMIT = 50;

/** What the monitors compare against on one tick. */
export interface LoadReading {
  readonly totals: HostTotals | null;
  readonly verdict: MachineVerdict | null;
  /** Read hourly while a monitor uses it; until the first read a monitor on it never fires. */
  readonly unbucketedSharePercent: number | null;
}

export const NO_LOAD_READING: LoadReading = {
  totals: null,
  verdict: null,
  unbucketedSharePercent: null,
};

const percent = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);

function maxOverGpus(
  totals: HostTotals,
  gpuId: string | undefined,
  pick: (gpu: HostGpuTotals) => number | null,
): number | null {
  const values = (totals.gpus ?? [])
    .filter((gpu) => gpuId === undefined || gpu.id === gpuId)
    .map(pick)
    .filter((value) => value !== null);
  return values.length === 0 ? null : Math.max(...values);
}

/** The metric's current value, or null when this machine cannot measure it now. */
export function loadMetricValue(condition: LoadCondition, reading: LoadReading): number | null {
  const { totals } = reading;
  switch (condition.metric) {
    case "verdict":
      return reading.verdict === "stressed" ? 1 : reading.verdict === "ok" ? 0 : null;
    case "unbucketedSharePercent":
      return reading.unbucketedSharePercent;
    case "loadPerCore":
      return totals?.load == null || totals.cpuCount <= 0
        ? null
        : totals.load.five / totals.cpuCount;
    case "memoryUsedPercent":
      return totals === null
        ? null
        : percent(totals.memoryTotalBytes - totals.memoryAvailableBytes, totals.memoryTotalBytes);
    case "swapUsedPercent":
      return totals === null ? null : percent(totals.swapUsedBytes, totals.swapTotalBytes);
    case "cpuPercent":
      return totals?.cpuUtilization == null ? null : totals.cpuUtilization * 100;
    case "gpuUtilPercent":
      return totals === null
        ? null
        : maxOverGpus(totals, condition.gpuId, (gpu) => gpu.utilPercent);
    case "vramUsedPercent":
      return totals === null
        ? null
        : maxOverGpus(totals, condition.gpuId, (gpu) => gpu.vramUsedPercent);
  }
}

/** A missing value holds no condition, so an unmeasurable metric neither fires nor clears. */
export function conditionHolds(condition: LoadCondition, reading: LoadReading): boolean {
  const value = loadMetricValue(condition, reading);
  if (value === null) return false;
  return condition.op === ">=" ? value >= condition.threshold : value <= condition.threshold;
}

/** Without a `clear`, the negated condition holds at least a minute so a flap does not re-arm. */
export const DEFAULT_CLEAR_MIN_SECONDS = 60;
const clearSustainSeconds = (schedule: ScheduledTaskLoadSchedule) =>
  schedule.clear?.sustainSeconds ??
  Math.max(schedule.condition.sustainSeconds, DEFAULT_CLEAR_MIN_SECONDS);

function clearHolds(schedule: ScheduledTaskLoadSchedule, reading: LoadReading): boolean {
  if (schedule.clear !== undefined) return conditionHolds(schedule.clear, reading);
  return (
    loadMetricValue(schedule.condition, reading) !== null &&
    !conditionHolds(schedule.condition, reading)
  );
}

/**
 * Monitors waiting for load to drop. Starting them all the moment it drops
 * would bring the load straight back, so they are released one at a time.
 */
export const isClearDirection = (schedule: ScheduledTaskLoadSchedule) =>
  schedule.condition.op === "<=";

/**
 * One monitor's episode: armed → holding → fired → cleared → armed. A
 * clear-direction monitor waits in `releasing` between holding and fired.
 */
export type MonitorState =
  | { readonly phase: "armed" }
  | { readonly phase: "holding"; readonly since: number }
  | { readonly phase: "releasing"; readonly episode: string }
  | { readonly phase: "fired"; readonly at: number; readonly clearingSince: number | null }
  | { readonly phase: "cleared"; readonly firedAt: number };

export const ARMED: MonitorState = { phase: "armed" };

/**
 * Advances one monitor by one reading. `fired` is true on the tick its
 * condition has held for `sustainSeconds`: the monitor is then `fired`, or
 * `releasing` when it must queue first. Nothing fires again until the clear
 * condition holds (for its own `sustainSeconds`) and the cooldown has passed.
 */
export function stepMonitor(
  state: MonitorState,
  schedule: ScheduledTaskLoadSchedule,
  reading: LoadReading,
  now: number,
): { readonly state: MonitorState; readonly fired: boolean } {
  switch (state.phase) {
    case "armed":
    case "holding": {
      if (!conditionHolds(schedule.condition, reading)) return { state: ARMED, fired: false };
      const since = state.phase === "holding" ? state.since : now;
      if (now - since < schedule.condition.sustainSeconds * 1000) {
        return { state: { phase: "holding", since }, fired: false };
      }
      return {
        state: isClearDirection(schedule)
          ? { phase: "releasing", episode: String(now) }
          : { phase: "fired", at: now, clearingSince: null },
        fired: true,
      };
    }
    case "releasing":
      return { state, fired: false };
    case "fired": {
      if (!clearHolds(schedule, reading)) {
        return { state: { ...state, clearingSince: null }, fired: false };
      }
      const clearingSince = state.clearingSince ?? now;
      const clearSustainMs = clearSustainSeconds(schedule) * 1000;
      return {
        state:
          now - clearingSince < clearSustainMs
            ? { ...state, clearingSince }
            : { phase: "cleared", firedAt: state.at },
        fired: false,
      };
    }
    case "cleared":
      return { state: now - state.firedAt < LOAD_COOLDOWN_MS ? state : ARMED, fired: false };
  }
}

interface WatchedTask {
  readonly id: ScheduledTaskId;
  readonly schedule: ScheduledTaskLoadSchedule;
  /** A new key (an edit, or the id reused by a new task) starts a fresh episode. */
  readonly key: string;
}

const usesUnbucketedShare = ({ schedule }: WatchedTask) =>
  schedule.condition.metric === "unbucketedSharePercent" ||
  schedule.clear?.metric === "unbucketedSharePercent";

const watchedTask = (task: ScheduledTask): ReadonlyArray<WatchedTask> =>
  task.enabled && task.schedule.type === "load"
    ? [
        {
          id: task.id,
          schedule: task.schedule,
          key: `${task.createdAt}\n${JSON.stringify(task.schedule)}`,
        },
      ]
    : [];

/**
 * Runs enabled `load` tasks when their condition is met. Host readings flow
 * only while such a task exists, and the 5 s Scheduler tick returns at once
 * without one. A restart forgets episodes, so a monitor may fire once more.
 */
export const monitorLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const host = yield* HostResources.HostResources;
    const hostProcesses = yield* HostProcesses.HostProcesses;
    const scheduler = yield* Scheduler.Scheduler;
    const watched = yield* Ref.make<ReadonlyArray<WatchedTask>>([]);
    const reading = yield* Ref.make<LoadReading>(NO_LOAD_READING);

    const readingUpdates = Stream.merge(
      host.ticks.pipe(Stream.map((totals) => (current: LoadReading) => ({ ...current, totals }))),
      host.status.pipe(
        Stream.map(({ verdict }) => (current: LoadReading) => ({ ...current, verdict })),
      ),
    );
    const clearReading = Stream.fromEffect(Ref.set(reading, NO_LOAD_READING)).pipe(Stream.drain);

    yield* scheduledTasks.subscribeList().pipe(
      Stream.retry(Schedule.spaced("30 seconds")),
      Stream.map(({ tasks }) => tasks.flatMap(watchedTask)),
      Stream.tap((tasks) => Ref.set(watched, tasks)),
      Stream.map((tasks) => tasks.length > 0),
      Stream.changes,
      Stream.switchMap((active) => (active ? readingUpdates : clearReading)),
      Stream.runForEach((update) => Ref.update(reading, update)),
      Effect.forkScoped,
    );

    // The Scheduler runs one evaluation at a time, so this state needs no lock.
    const states = new Map<ScheduledTaskId, { readonly key: string; state: MonitorState }>();
    let releaseQueue: ScheduledTaskId[] = [];
    let nextReleaseAt = 0;
    let unbucketedReadAt: number | null = null;

    // One host walk and attribution pass; a monitor that cannot list processes reads no value.
    const readUnbucketedShare = hostProcesses
      .unbucketed({ limit: 0, commands: false, bucketNames: new Map() })
      .pipe(
        Effect.map((result) => result.sharePercent),
        Effect.orElseSucceed(() => null),
      );
    const releaseGap = Random.nextIntBetween(RELEASE_JITTER_MIN_MS, RELEASE_JITTER_MAX_MS);

    // The built-in skips a fire whose unowned set its last run already saw; a failed read sees none.
    const readUnowned = (id: ScheduledTaskId): Effect.Effect<ReadonlyArray<string> | undefined> =>
      id !== ScheduledTaskService.MACHINE_BUCKETS_TASK_ID
        ? Effect.undefined
        : hostProcesses
            .unbucketed({
              limit: MACHINE_BUCKETS_UNOWNED_LIMIT,
              commands: false,
              bucketNames: new Map(),
            })
            .pipe(
              Effect.map((result) => result.processes.map(ScheduledTaskService.unownedProcessKey)),
              Effect.orElseSucceed(() => []),
            );

    const trigger = (id: ScheduledTaskId, episode: string) =>
      readUnowned(id).pipe(
        Effect.flatMap((unowned) => scheduledTasks.triggerLoad(id, episode, unowned)),
        Effect.catch((cause) =>
          Effect.logWarning("Load-triggered schedule task failed", { taskId: id, cause }),
        ),
      );

    // Every 5 s for the server's lifetime; a span per tick would only add noise.
    const evaluate = Effect.fnUntraced(function* () {
      const tasks = yield* Ref.get(watched);
      if (tasks.length === 0) {
        states.clear();
        releaseQueue = [];
        unbucketedReadAt = null;
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      if (!tasks.some(usesUnbucketedShare)) unbucketedReadAt = null;
      else if (unbucketedReadAt === null || now - unbucketedReadAt >= UNBUCKETED_INTERVAL_MS) {
        unbucketedReadAt = now;
        const unbucketedSharePercent = yield* readUnbucketedShare;
        yield* Ref.update(reading, (latest) => ({ ...latest, unbucketedSharePercent }));
        // The built-in re-arms at each read, so only its service caps (6 h, in flight,
        // changed set) limit it; a skipped fire would otherwise latch until restart.
        const builtIn = states.get(ScheduledTaskService.MACHINE_BUCKETS_TASK_ID);
        if (builtIn !== undefined && builtIn.state.phase !== "holding") builtIn.state = ARMED;
      }
      const current = yield* Ref.get(reading);
      const byId = new Map(tasks.map((task) => [task.id, task]));
      for (const id of states.keys()) if (!byId.has(id)) states.delete(id);
      for (const task of tasks) {
        if (states.get(task.id)?.key !== task.key) {
          states.set(task.id, { key: task.key, state: ARMED });
        }
      }
      releaseQueue = releaseQueue.filter((id) => states.get(id)?.state.phase === "releasing");

      for (const task of tasks) {
        const entry = states.get(task.id)!;
        const step = stepMonitor(entry.state, task.schedule, current, now);
        entry.state = step.state;
        if (!step.fired) continue;
        if (step.state.phase === "releasing") {
          if (releaseQueue.length === 0) {
            nextReleaseAt = Math.max(nextReleaseAt, now + (yield* releaseGap));
          }
          releaseQueue.push(task.id);
        } else {
          yield* trigger(task.id, String(now));
        }
      }

      // Releases one monitor whose condition still holds; the rest wait a fresh gap.
      while (releaseQueue.length > 0 && now >= nextReleaseAt) {
        const id = releaseQueue.shift()!;
        const task = byId.get(id)!;
        const entry = states.get(id)!;
        if (entry.state.phase !== "releasing") continue;
        if (!conditionHolds(task.schedule.condition, current)) {
          entry.state = ARMED;
          continue;
        }
        const { episode } = entry.state;
        entry.state = { phase: "fired", at: now, clearingSince: null };
        nextReleaseAt = now + (yield* releaseGap);
        yield* trigger(id, episode);
      }
    });

    yield* scheduler.register("LoadMonitor", evaluate());
  }),
);

/** Keeps built-in tasks (auto-buckets) in step with settings, from startup on. */
export const builtInTasksLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const settings = yield* ServerSettingsService;
    // Subscribe before the first read so a change in between is not missed.
    const changes = yield* settings.subscribeChanges;
    yield* Stream.concat(Stream.make(undefined), changes).pipe(
      Stream.runForEach(() =>
        settings.getSettings.pipe(
          Effect.flatMap(scheduledTasks.ensureBuiltInTasks),
          Effect.catch((cause) =>
            Effect.logWarning("Could not update built-in scheduled tasks", { cause }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

export const layer = Layer.mergeAll(monitorLayer, builtInTasksLayer);
