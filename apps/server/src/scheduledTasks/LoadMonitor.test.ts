import { describe, expect, it } from "@effect/vitest";
import {
  type LoadCondition,
  type MachineStatusSnapshot,
  type MachineVerdict,
  ProjectId,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  type ScheduledTaskLoadSchedule,
  type ScheduledTaskSchedule,
} from "@t3tools/contracts";
import type { HostGpuTotals, HostTotals } from "@t3tools/shared/hostTotals";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as HostProcesses from "../resourceTelemetry/HostProcesses.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import {
  ARMED,
  monitorLayer as loadMonitorLayer,
  LOAD_COOLDOWN_MS,
  type LoadReading,
  loadMetricValue,
  type MonitorState,
  NO_LOAD_READING,
  RELEASE_JITTER_MAX_MS,
  RELEASE_JITTER_MIN_MS,
  stepMonitor,
  UNBUCKETED_INTERVAL_MS,
} from "./LoadMonitor.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const TICK_MS = 5_000;

const gpu = (id: string, utilPercent: number | null, vramUsedPercent: number | null = null) =>
  ({
    id,
    name: id,
    vendor: "nvidia",
    status: "active",
    utilPercent,
    vramUsedPercent,
  }) satisfies HostGpuTotals;

const hostTotals = (overrides: Partial<HostTotals> = {}): HostTotals => ({
  platform: "linux",
  sampledAt: 0,
  cpuCount: 4,
  cpuUtilization: 0.25,
  perCore: [],
  load: { one: 2, five: 4, fifteen: 1 },
  memoryTotalBytes: 1_000,
  memoryAvailableBytes: 750,
  swapTotalBytes: 200,
  swapUsedBytes: 50,
  memoryPressure: null,
  ...overrides,
});

const reading = (
  totals: HostTotals | null,
  verdict: MachineVerdict | null = null,
): LoadReading => ({
  totals,
  verdict,
  unbucketedSharePercent: null,
});

const condition = (overrides: Partial<LoadCondition> = {}): LoadCondition => ({
  metric: "cpuPercent",
  op: ">=",
  threshold: 90,
  sustainSeconds: 0,
  ...overrides,
});

const load = (
  conditionOverrides: Partial<LoadCondition> = {},
  clear?: LoadCondition,
): ScheduledTaskLoadSchedule => ({
  type: "load",
  condition: condition(conditionOverrides),
  ...(clear === undefined ? {} : { clear }),
});

describe("loadMetricValue", () => {
  const twoGpus = hostTotals({ gpus: [gpu("gpu-0", 30, 10), gpu("gpu-1", 70, null)] });
  it.each<[string, Partial<LoadCondition>, LoadReading, number | null]>([
    ["verdict stressed", { metric: "verdict" }, reading(null, "stressed"), 1],
    ["verdict ok", { metric: "verdict" }, reading(null, "ok"), 0],
    ["verdict unknown", { metric: "verdict" }, reading(hostTotals()), null],
    ["load per core from the 5-minute load", { metric: "loadPerCore" }, reading(hostTotals()), 1],
    ["no load average", { metric: "loadPerCore" }, reading(hostTotals({ load: null })), null],
    ["no cores", { metric: "loadPerCore" }, reading(hostTotals({ cpuCount: 0 })), null],
    ["memory used", { metric: "memoryUsedPercent" }, reading(hostTotals()), 25],
    [
      "no memory total",
      { metric: "memoryUsedPercent" },
      reading(hostTotals({ memoryTotalBytes: 0 })),
      null,
    ],
    ["swap used", { metric: "swapUsedPercent" }, reading(hostTotals()), 25],
    ["no swap", { metric: "swapUsedPercent" }, reading(hostTotals({ swapTotalBytes: 0 })), null],
    ["cpu", { metric: "cpuPercent" }, reading(hostTotals()), 25],
    [
      "first cpu read",
      { metric: "cpuPercent" },
      reading(hostTotals({ cpuUtilization: null })),
      null,
    ],
    ["max GPU util", { metric: "gpuUtilPercent" }, reading(twoGpus), 70],
    ["one GPU's util", { metric: "gpuUtilPercent", gpuId: "gpu-0" }, reading(twoGpus), 30],
    ["unknown gpuId", { metric: "gpuUtilPercent", gpuId: "gpu-9" }, reading(twoGpus), null],
    ["no GPUs", { metric: "gpuUtilPercent" }, reading(hostTotals()), null],
    ["empty GPU list", { metric: "gpuUtilPercent" }, reading(hostTotals({ gpus: [] })), null],
    [
      "a GPU without util is skipped",
      { metric: "gpuUtilPercent" },
      reading(hostTotals({ gpus: [gpu("gpu-0", null), gpu("gpu-1", 12)] })),
      12,
    ],
    [
      "every GPU without util",
      { metric: "gpuUtilPercent" },
      reading(hostTotals({ gpus: [gpu("gpu-0", null)] })),
      null,
    ],
    ["max VRAM skips an unknown device", { metric: "vramUsedPercent" }, reading(twoGpus), 10],
    [
      "VRAM of a device without it",
      { metric: "vramUsedPercent", gpuId: "gpu-1" },
      reading(twoGpus),
      null,
    ],
    [
      "unbucketed share before the hourly pass",
      { metric: "unbucketedSharePercent" },
      reading(hostTotals()),
      null,
    ],
    [
      "unbucketed share",
      { metric: "unbucketedSharePercent" },
      { ...reading(null), unbucketedSharePercent: 40 },
      40,
    ],
    ...(
      [
        "loadPerCore",
        "memoryUsedPercent",
        "swapUsedPercent",
        "cpuPercent",
        "gpuUtilPercent",
        "vramUsedPercent",
      ] as const
    ).map((metric): [string, Partial<LoadCondition>, LoadReading, null] => [
      `${metric} before any totals`,
      { metric },
      NO_LOAD_READING,
      null,
    ]),
  ])("%s", (_name, overrides, input, expected) => {
    expect(loadMetricValue(condition(overrides), input)).toBe(expected);
  });
});

describe("stepMonitor", () => {
  const hot = reading(hostTotals({ cpuUtilization: 0.95 }));
  const cool = reading(hostTotals({ cpuUtilization: 0.5 }));
  const unknown = reading(hostTotals({ cpuUtilization: null }));
  const sustained = load({ sustainSeconds: 30 });
  const clearDirection = load({ op: "<=", threshold: 60 });
  const explicitClear = load({}, condition({ op: "<=", threshold: 40, sustainSeconds: 20 }));
  const fired = (at: number, clearingSince: number | null = null): MonitorState => ({
    phase: "fired",
    at,
    clearingSince,
  });

  it.each<
    [string, MonitorState, ScheduledTaskLoadSchedule, LoadReading, number, MonitorState, boolean]
  >([
    ["stays armed while the condition does not hold", ARMED, sustained, cool, 0, ARMED, false],
    [
      "an unknown value never holds",
      ARMED,
      load({ op: "<=", threshold: 1_000 }),
      unknown,
      0,
      ARMED,
      false,
    ],
    ["starts holding", ARMED, sustained, hot, 1_000, { phase: "holding", since: 1_000 }, false],
    [
      "keeps its first since just short of sustain",
      { phase: "holding", since: 1_000 },
      sustained,
      hot,
      30_999,
      { phase: "holding", since: 1_000 },
      false,
    ],
    [
      "fires once sustained",
      { phase: "holding", since: 1_000 },
      sustained,
      hot,
      31_000,
      fired(31_000),
      true,
    ],
    [
      "a flap restarts the hold",
      { phase: "holding", since: 1_000 },
      sustained,
      cool,
      20_000,
      ARMED,
      false,
    ],
    ["no sustain fires on the first tick", ARMED, load(), hot, 5_000, fired(5_000), true],
    [
      "a clear-direction monitor queues with the tick as its episode",
      ARMED,
      clearDirection,
      cool,
      5_000,
      { phase: "releasing", episode: "5000" },
      true,
    ],
    [
      "releasing waits for the release loop",
      { phase: "releasing", episode: "5000" },
      clearDirection,
      hot,
      10_000,
      { phase: "releasing", episode: "5000" },
      false,
    ],
    [
      "stays fired while the condition holds",
      fired(0, 5_000),
      load(),
      hot,
      10_000,
      fired(0),
      false,
    ],
    ["an unknown value never clears", fired(0), load(), unknown, 120_000, fired(0), false],
    [
      "clears on the default clear",
      fired(0),
      load(),
      cool,
      5_000,
      { phase: "cleared", firedAt: 0 },
      false,
    ],
    [
      "an explicit clear starts its streak",
      fired(0),
      explicitClear,
      reading(hostTotals({ cpuUtilization: 0.3 })),
      5_000,
      fired(0, 5_000),
      false,
    ],
    [
      "between condition and clear is not clear",
      fired(0, 5_000),
      explicitClear,
      cool,
      10_000,
      fired(0),
      false,
    ],
    [
      "an explicit clear waits out its sustain",
      fired(0, 5_000),
      explicitClear,
      reading(hostTotals({ cpuUtilization: 0.3 })),
      24_999,
      fired(0, 5_000),
      false,
    ],
    [
      "an explicit clear completes",
      fired(0, 5_000),
      explicitClear,
      reading(hostTotals({ cpuUtilization: 0.3 })),
      25_000,
      { phase: "cleared", firedAt: 0 },
      false,
    ],
    [
      "cleared waits out the cooldown",
      { phase: "cleared", firedAt: 1_000 },
      load(),
      hot,
      1_000 + LOAD_COOLDOWN_MS - 1,
      { phase: "cleared", firedAt: 1_000 },
      false,
    ],
    [
      "re-arms after the cooldown without firing on that tick",
      { phase: "cleared", firedAt: 1_000 },
      load(),
      hot,
      1_000 + LOAD_COOLDOWN_MS,
      ARMED,
      false,
    ],
  ])("%s", (_name, state, schedule, input, now, expected, expectedFired) => {
    expect(stepMonitor(state, schedule, input, now)).toEqual({
      state: expected,
      fired: expectedFired,
    });
  });
});

const loadTask = (
  name: string,
  schedule: ScheduledTaskSchedule,
  overrides: Partial<ScheduledTask> = {},
): ScheduledTask => ({
  id: ScheduledTaskId.make(`scheduled-task:${name}`),
  title: name,
  prompt: "Do the thing",
  enabled: true,
  schedule,
  projectId: ProjectId.make("project:load"),
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdBy: "agent",
  creationSource: "mcp",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
  ...overrides,
});

const statusFor = (verdict: MachineVerdict): MachineStatusSnapshot => ({
  sequence: 1,
  verdict,
  verdictAgeMs: 0,
  reason: null,
  sampleAgeMs: 0,
  totals: null,
});

interface Fire {
  readonly id: ScheduledTaskId;
  readonly episode: string;
  readonly at: number;
  readonly unowned?: ReadonlyArray<string> | undefined;
}

/** The real monitor and Scheduler on TestClock, with tasks and host readings the test sets. */
const monitorHarness = (options: { readonly triggerFails?: boolean } = {}) =>
  Effect.gen(function* () {
    const tasks = yield* SubscriptionRef.make<ReadonlyArray<ScheduledTask>>([]);
    const totals = yield* SubscriptionRef.make<HostTotals | null>(null);
    const verdict = yield* SubscriptionRef.make<MachineVerdict | null>(null);
    const subscriptions = yield* Ref.make(0);
    const fires = yield* Ref.make<ReadonlyArray<Fire>>([]);
    // "fail" stands for a machine without a host-mode monitor.
    const share = yield* Ref.make<number | null | "fail">("fail");
    const walks = yield* Ref.make<ReadonlyArray<HostProcesses.UnbucketedInput>>([]);
    const processes = yield* Ref.make<ReadonlyArray<HostProcesses.UnbucketedProcess>>([]);

    yield* Layer.build(
      loadMonitorLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Scheduler.layer,
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              subscribeList: () =>
                SubscriptionRef.changes(tasks).pipe(Stream.map((list) => ({ tasks: list }))),
              triggerLoad: (id, episode, unowned) =>
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((at) =>
                    Ref.update(fires, (all) => [...all, { id, episode, at, unowned }]),
                  ),
                  Effect.andThen(
                    options.triggerFails === true
                      ? Effect.fail(new ScheduledTaskError({ message: "boom", taskId: id }))
                      : Effect.void,
                  ),
                ),
            }),
            Layer.mock(HostProcesses.HostProcesses)({
              unbucketed: (input) =>
                Ref.update(walks, (all) => [...all, input]).pipe(
                  Effect.andThen(Effect.all([Ref.get(share), Ref.get(processes)])),
                  Effect.flatMap(([sharePercent, rows]) =>
                    sharePercent === "fail"
                      ? Effect.fail(new HostProcesses.HostProcessesUnavailable())
                      : Effect.succeed({
                          sharePercent,
                          sampleAgeMs: 0,
                          processes: rows,
                          buckets: [],
                        }),
                  ),
                ),
            }),
            Layer.mock(HostResources.HostResources)({
              ticks: Stream.unwrap(
                Ref.update(subscriptions, (count) => count + 1).pipe(
                  Effect.as(
                    SubscriptionRef.changes(totals).pipe(
                      Stream.filter((value): value is HostTotals => value !== null),
                    ),
                  ),
                ),
              ),
              status: SubscriptionRef.changes(verdict).pipe(
                Stream.filter((value): value is MachineVerdict => value !== null),
                Stream.map(statusFor),
              ),
            }),
          ),
        ),
      ),
    );

    return {
      setTasks: (list: ReadonlyArray<ScheduledTask>) => SubscriptionRef.set(tasks, list),
      setTotals: (value: HostTotals) => SubscriptionRef.set(totals, value),
      setVerdict: (value: MachineVerdict) => SubscriptionRef.set(verdict, value),
      setShare: (value: number | null | "fail") => Ref.set(share, value),
      setProcesses: (rows: ReadonlyArray<HostProcesses.UnbucketedProcess>) =>
        Ref.set(processes, rows),
      walks: Ref.get(walks),
      /** Runs the Scheduler's 5 s ticks up to `ms` from now. */
      advance: (ms: number) => TestClock.adjust(ms),
      fires: Ref.get(fires),
      subscriptions: Ref.get(subscriptions),
    };
  });

const cpu = (percent: number) => hostTotals({ cpuUtilization: percent / 100 });
const memory = (usedPercent: number, cpuPercent = 25) =>
  hostTotals({ memoryAvailableBytes: 1_000 - usedPercent * 10, cpuUtilization: cpuPercent / 100 });
const gaps = (fires: ReadonlyArray<Fire>) =>
  fires.slice(1).map((fire, index) => fire.at - fires[index]!.at);

describe("LoadMonitor layer", () => {
  it.effect("fires only after the condition held for sustainSeconds, and a flap restarts it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* monitorHarness();
        const task = loadTask("hot", load({ sustainSeconds: 30 }));
        yield* monitor.setTasks([task]);
        yield* monitor.setTotals(cpu(95));
        yield* monitor.advance(20_000);
        yield* monitor.setTotals(cpu(50));
        yield* monitor.advance(TICK_MS);
        yield* monitor.setTotals(cpu(95));
        const restartedAt = yield* Clock.currentTimeMillis;
        yield* monitor.advance(25_000);
        expect(yield* monitor.fires).toEqual([]);
        yield* monitor.advance(10_000);
        const fires = yield* monitor.fires;
        expect(fires).toHaveLength(1);
        expect(fires[0]!.at - restartedAt).toBeGreaterThanOrEqual(30_000);
        expect(fires[0]).toMatchObject({ id: task.id, episode: String(fires[0]!.at) });
      }),
    ),
  );

  it.effect("fires once for an episode however long the condition holds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* monitorHarness();
        yield* monitor.setTasks([loadTask("hot", load())]);
        yield* monitor.setTotals(cpu(95));
        yield* monitor.advance(10 * 60_000);
        expect(yield* monitor.fires).toHaveLength(1);
      }),
    ),
  );

  it.effect("re-fires only after a clear and the 60 s cooldown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* monitorHarness();
        yield* monitor.setTasks([loadTask("hot", load())]);
        yield* monitor.setTotals(cpu(95));
        yield* monitor.advance(2 * TICK_MS);
        const [first] = yield* monitor.fires;
        expect(first).toBeDefined();
        yield* monitor.setTotals(cpu(50));
        yield* monitor.advance(TICK_MS);
        yield* monitor.setTotals(cpu(95));
        yield* monitor.advance(
          first!.at + LOAD_COOLDOWN_MS - TICK_MS - (yield* Clock.currentTimeMillis),
        );
        expect(yield* monitor.fires).toHaveLength(1);
        yield* monitor.advance(4 * TICK_MS);
        const fires = yield* monitor.fires;
        expect(fires).toHaveLength(2);
        expect(fires[1]!.at - first!.at).toBeGreaterThanOrEqual(LOAD_COOLDOWN_MS);
        expect(fires[1]!.episode).not.toBe(first!.episode);
      }),
    ),
  );

  it.effect("flapping around the threshold fires at most once a minute, each after a clear", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* monitorHarness();
        yield* monitor.setTasks([loadTask("hot", load())]);
        for (let tick = 0; tick < 120; tick += 1) {
          yield* monitor.setTotals(cpu(tick % 2 === 0 ? 95 : 50));
          yield* monitor.advance(TICK_MS);
        }
        const fires = yield* monitor.fires;
        expect(fires.length).toBeGreaterThanOrEqual(2);
        expect(fires.length).toBeLessThanOrEqual(10);
        for (const gap of gaps(fires)) expect(gap).toBeGreaterThanOrEqual(LOAD_COOLDOWN_MS);
      }),
    ),
  );

  it.effect("releases clear-direction monitors one at a time, 20 to 40 s apart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* monitorHarness();
        const waiting = Array.from({ length: 10 }, (_, index) =>
          loadTask(`idle-${index}`, load({ metric: "memoryUsedPercent", op: "<=", threshold: 50 })),
        );
        const urgent = loadTask("urgent", load({ threshold: 90 }));
        yield* monitor.setTotals(memory(80, 25));
        yield* monitor.setTasks([...waiting, urgent]);
        yield* monitor.advance(TICK_MS);
        expect(yield* monitor.fires).toEqual([]);

        yield* monitor.setTotals(memory(20, 95));
        yield* monitor.advance(TICK_MS);
        const metAt = yield* Clock.currentTimeMillis;
        expect(yield* monitor.fires).toEqual([
          { id: urgent.id, episode: String(metAt), at: metAt },
        ]);

        yield* monitor.advance(10 * (RELEASE_JITTER_MAX_MS + TICK_MS));
        const released = (yield* monitor.fires).filter((fire) => fire.id !== urgent.id);
        expect(released.map((fire) => fire.id)).toEqual(waiting.map((task) => task.id));
        expect(new Set(released.map((fire) => fire.episode))).toEqual(new Set([String(metAt)]));
        expect(released[0]!.at - metAt).toBeGreaterThanOrEqual(RELEASE_JITTER_MIN_MS);
        expect(released[0]!.at - metAt).toBeLessThanOrEqual(RELEASE_JITTER_MAX_MS + TICK_MS);
        for (const gap of gaps(released)) {
          expect(gap).toBeGreaterThanOrEqual(RELEASE_JITTER_MIN_MS);
          expect(gap).toBeLessThanOrEqual(RELEASE_JITTER_MAX_MS + TICK_MS);
        }
      }),
    ),
  );

  it.effect("re-checks a queued monitor at its turn and passes the turn on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* monitorHarness();
        const memoryDrop = loadTask(
          "memory",
          load({ metric: "memoryUsedPercent", op: "<=", threshold: 50 }),
        );
        const cpuDrop = loadTask("cpu", load({ op: "<=", threshold: 50 }));
        yield* monitor.setTotals(memory(80, 95));
        yield* monitor.setTasks([memoryDrop, cpuDrop]);
        yield* monitor.advance(TICK_MS);
        yield* monitor.setTotals(memory(20, 25));
        yield* monitor.advance(TICK_MS);
        const metAt = yield* Clock.currentTimeMillis;
        yield* monitor.setTotals(memory(80, 25));
        yield* monitor.advance(RELEASE_JITTER_MAX_MS + TICK_MS);
        expect(yield* monitor.fires).toEqual([
          { id: cpuDrop.id, episode: String(metAt), at: expect.any(Number) },
        ]);

        // Skipped, not spent: it stays armed and queues again when memory drops.
        yield* monitor.advance(LOAD_COOLDOWN_MS);
        expect(yield* monitor.fires).toHaveLength(1);
        yield* monitor.setTotals(memory(20, 25));
        yield* monitor.advance(TICK_MS);
        const metAgainAt = yield* Clock.currentTimeMillis;
        yield* monitor.advance(RELEASE_JITTER_MAX_MS + TICK_MS);
        expect((yield* monitor.fires)[1]).toMatchObject({
          id: memoryDrop.id,
          episode: String(metAgainAt),
        });
      }),
    ),
  );

  it.effect("drops a queued monitor whose task was paused, deleted or edited", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* monitorHarness();
        const drop = load({ metric: "memoryUsedPercent", op: "<=", threshold: 50 });
        const [paused, deleted, edited, kept] = ["paused", "deleted", "edited", "kept"].map(
          (name) => loadTask(name, drop),
        );
        yield* monitor.setTotals(memory(80));
        yield* monitor.setTasks([paused!, deleted!, edited!, kept!]);
        yield* monitor.advance(TICK_MS);
        yield* monitor.setTotals(memory(20));
        yield* monitor.advance(TICK_MS);
        const metAt = yield* Clock.currentTimeMillis;
        yield* monitor.setTasks([
          { ...paused!, enabled: false },
          { ...edited!, schedule: load({ metric: "memoryUsedPercent", op: "<=", threshold: 60 }) },
          kept!,
        ]);
        yield* monitor.advance(TICK_MS);
        const editedMetAt = yield* Clock.currentTimeMillis;
        yield* monitor.advance(3 * (RELEASE_JITTER_MAX_MS + TICK_MS));
        const fires = yield* monitor.fires;
        expect(fires.map((fire) => [fire.id, fire.episode])).toEqual([
          [kept!.id, String(metAt)],
          [edited!.id, String(editedMetAt)],
        ]);
      }),
    ),
  );

  it.effect("reads no host totals while no enabled load task exists", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* monitorHarness();
        const paused = loadTask("paused", load(), { enabled: false });
        const hourly = loadTask("hourly", { type: "interval", everyMs: 3_600_000 });
        yield* monitor.setTotals(cpu(95));
        yield* monitor.setTasks([paused, hourly]);
        yield* monitor.advance(2 * 60_000);
        expect(yield* monitor.subscriptions).toBe(0);
        expect(yield* monitor.fires).toEqual([]);

        yield* monitor.setTasks([{ ...paused, enabled: true }, hourly]);
        yield* monitor.advance(TICK_MS);
        expect(yield* monitor.subscriptions).toBe(1);
        expect(yield* monitor.fires).toHaveLength(1);

        // Leaving and re-entering forgets the old episode and the old reading.
        yield* monitor.setTasks([hourly]);
        yield* monitor.advance(TICK_MS);
        yield* monitor.setTasks([{ ...paused, enabled: true }, hourly]);
        yield* monitor.advance(TICK_MS);
        expect(yield* monitor.subscriptions).toBe(2);
        expect(yield* monitor.fires).toHaveLength(2);
      }),
    ),
  );

  it.effect("never fires on a metric this machine cannot measure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* monitorHarness();
        const anything = { op: "<=", threshold: 1_000_000 } as const;
        const unmeasurable = [
          loadTask("load", load({ ...anything, metric: "loadPerCore" })),
          loadTask("swap", load({ ...anything, metric: "swapUsedPercent" })),
          loadTask("gpu", load({ ...anything, metric: "gpuUtilPercent" })),
          loadTask("vram", load({ ...anything, metric: "vramUsedPercent", gpuId: "gpu-9" })),
          loadTask("unbucketed", load({ ...anything, metric: "unbucketedSharePercent" })),
          loadTask("verdict", load({ metric: "verdict", op: ">=", threshold: 1 })),
        ];
        const memoryTask = loadTask("memory", load({ ...anything, metric: "memoryUsedPercent" }));
        yield* monitor.setTasks([...unmeasurable, memoryTask]);
        yield* monitor.advance(60_000);
        expect(yield* monitor.fires).toEqual([]);

        yield* monitor.setTotals(
          hostTotals({ load: null, swapTotalBytes: 0, gpus: [gpu("gpu-0", null, 50)] }),
        );
        yield* monitor.advance(10 * 60_000);
        expect((yield* monitor.fires).map((fire) => fire.id)).toEqual([memoryTask.id]);

        yield* monitor.setVerdict("stressed");
        yield* monitor.advance(TICK_MS);
        expect((yield* monitor.fires).map((fire) => fire.id)).toEqual([
          memoryTask.id,
          unmeasurable.at(-1)!.id,
        ]);
      }),
    ),
  );

  it.effect("reads the unbucketed share hourly, and only while a monitor uses it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* monitorHarness();
        const cpuTask = loadTask("cpu", load());
        yield* monitor.setTotals(cpu(10));
        yield* monitor.setShare(40);
        yield* monitor.setTasks([cpuTask]);
        yield* monitor.advance(10 * 60_000);
        expect(yield* monitor.walks).toEqual([]);

        const shareTask = loadTask(
          "share",
          load({ metric: "unbucketedSharePercent", threshold: 30 }),
        );
        yield* monitor.setTasks([cpuTask, shareTask]);
        yield* monitor.advance(2 * TICK_MS);
        expect(yield* monitor.walks).toEqual([
          { limit: 0, commands: false, bucketNames: new Map() },
        ]);
        // A user's task gets no unowned set, so its fire costs no second walk.
        expect((yield* monitor.fires).map(({ id, unowned }) => ({ id, unowned }))).toEqual([
          { id: shareTask.id, unowned: undefined },
        ]);

        yield* monitor.advance(UNBUCKETED_INTERVAL_MS - 4 * TICK_MS);
        expect(yield* monitor.walks).toHaveLength(1);
        yield* monitor.advance(4 * TICK_MS);
        expect(yield* monitor.walks).toHaveLength(2);

        yield* monitor.setTasks([cpuTask]);
        yield* monitor.advance(2 * UNBUCKETED_INTERVAL_MS);
        expect(yield* monitor.walks).toHaveLength(2);

        // A monitor that only clears on the share needs it too, read at once on its return.
        const clearsOnShare = loadTask(
          "clears-on-share",
          load({}, condition({ metric: "unbucketedSharePercent", op: "<=", threshold: 5 })),
        );
        yield* monitor.setTasks([cpuTask, clearsOnShare]);
        yield* monitor.advance(2 * TICK_MS);
        expect(yield* monitor.walks).toHaveLength(3);
      }),
    ),
  );

  it.effect("hands the built-in's fire the unowned top 50, by container or name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* monitorHarness();
        const builtIn = loadTask(
          "builtin",
          load({ metric: "unbucketedSharePercent", threshold: 25 }),
          {
            id: ScheduledTaskService.MACHINE_BUCKETS_TASK_ID,
          },
        );
        const row = (name: string, container?: string): HostProcesses.UnbucketedProcess => ({
          pid: 1,
          ppid: 0,
          name,
          exe: `/usr/bin/${name}`,
          user: "user",
          ...(container === undefined ? {} : { container }),
          cpuPercent: 10,
          rssBytes: 1,
        });
        yield* monitor.setTotals(cpu(10));
        yield* monitor.setShare(40);
        yield* monitor.setProcesses([row("postgres"), row("node", "acme-api-1"), row("postgres")]);
        yield* monitor.setTasks([builtIn]);
        yield* monitor.advance(2 * TICK_MS);
        expect(yield* monitor.walks).toEqual([
          { limit: 0, commands: false, bucketNames: new Map() },
          { limit: 50, commands: false, bucketNames: new Map() },
        ]);
        expect((yield* monitor.fires).map((fire) => fire.unowned)).toEqual([
          ["postgres", "container:acme-api-1", "postgres"],
        ]);
      }),
    ),
  );

  it.effect("reads the share again on the first tick after a paused task is switched back on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* monitorHarness();
        const shareTask = loadTask(
          "share",
          load({ metric: "unbucketedSharePercent", threshold: 30 }),
        );
        yield* monitor.setTotals(cpu(10));
        yield* monitor.setTasks([shareTask]);
        yield* monitor.advance(2 * TICK_MS);
        expect(yield* monitor.walks).toHaveLength(1);

        yield* monitor.setTasks([{ ...shareTask, enabled: false }]);
        yield* monitor.advance(10 * 60_000);
        yield* monitor.setTasks([shareTask]);
        yield* monitor.advance(2 * TICK_MS);
        expect(yield* monitor.walks).toHaveLength(2);
      }),
    ),
  );

  it.effect(
    "reads no share where processes cannot be listed, then fires once a later walk reads one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const monitor = yield* monitorHarness();
          const shareTask = loadTask(
            "share",
            load({ metric: "unbucketedSharePercent", threshold: 30 }),
          );
          yield* monitor.setTotals(cpu(10));
          yield* monitor.setTasks([shareTask]);
          yield* monitor.advance(UNBUCKETED_INTERVAL_MS - TICK_MS);
          expect(yield* monitor.walks).toHaveLength(1);
          expect(yield* monitor.fires).toEqual([]);

          yield* monitor.setShare(null);
          yield* monitor.advance(2 * TICK_MS);
          expect(yield* monitor.walks).toHaveLength(2);
          expect(yield* monitor.fires).toEqual([]);

          yield* monitor.setShare(55);
          yield* monitor.advance(UNBUCKETED_INTERVAL_MS + TICK_MS);
          expect(yield* monitor.walks).toHaveLength(3);
          expect((yield* monitor.fires).map((fire) => fire.id)).toEqual([shareTask.id]);
        }),
      ),
  );

  it.effect("stays fired after a failed trigger instead of retrying", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const monitor = yield* monitorHarness({ triggerFails: true });
        yield* monitor.setTasks([
          loadTask("hot", load()),
          loadTask("idle", load({ op: "<=", threshold: 50, metric: "memoryUsedPercent" })),
        ]);
        yield* monitor.setTotals(memory(20, 95));
        yield* monitor.advance(10 * 60_000);
        expect((yield* monitor.fires).map((fire) => fire.id)).toEqual([
          ScheduledTaskId.make("scheduled-task:hot"),
          ScheduledTaskId.make("scheduled-task:idle"),
        ]);
      }),
    ),
  );
});
