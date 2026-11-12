import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ManagedPolicyDocument,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskId,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { MACHINE_BUCKETS_PROMPT } from "@t3tools/shared/machineBuckets";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as HostProcesses from "../resourceTelemetry/HostProcesses.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import { builtInTasksLayer, monitorLayer, UNBUCKETED_INTERVAL_MS } from "./LoadMonitor.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const SCRATCH = ProjectId.make("project:scratch");
const BUILT_IN = ScheduledTaskService.MACHINE_BUCKETS_TASK_ID;

type Command =
  | { readonly type: "launch"; readonly input: Record<string, unknown> }
  | { readonly type: "dispatch"; readonly input: Record<string, unknown> }
  | { readonly type: "send"; readonly input: Record<string, unknown> };

/** Thread shells by id, a run's end the service waits on, and the threads it deleted. */
interface Threads {
  readonly shells: Map<string, Record<string, unknown>>;
  readonly runEnded: Deferred.Deferred<void>;
  readonly deleted: Deferred.Deferred<string>;
}
const makeThreads = (shells: Record<string, Record<string, unknown>> = {}): Threads => ({
  shells: new Map(Object.entries(shells)),
  runEnded: Deferred.makeUnsafe<void>(),
  deleted: Deferred.makeUnsafe<string>(),
});
/** An auto-buckets thread in the scratch project whose run completed. */
const bucketsThread = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  projectId: SCRATCH,
  status: "completed",
  activeRunId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  tags: ["backgrounded", "machine-buckets"],
  pendingRuntimeRequest: null,
  loadPause: null,
  limitRecovery: null,
  pinnedAt: null,
  archivedAt: null,
  latestUserAuthoredMessageAt: null,
  deletedAt: null,
  ...overrides,
});
const withWorking = (shell: Record<string, unknown>, working: ReadonlySet<string>) =>
  working.has(shell.id as string) ? { ...shell, status: "running", activeRunId: "run:1" } : shell;

/** The service, recording every thread command in order; threads in `working` are mid-run. */
const serviceLayer = (
  commands: Array<Command>,
  working: ReadonlySet<string>,
  policy?: ManagedPolicyDocument,
  scratch: { calls: number } = { calls: 0 },
  threads: Threads = makeThreads(),
) => {
  const record = (type: Command["type"]) => (input: unknown) =>
    Effect.sync(() => {
      commands.push({ type, input: input as Record<string, unknown> });
    });
  const dependencies = Layer.mergeAll(
    ManagedPolicy.layerTest(policy),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) =>
        record("launch")(input).pipe(
          Effect.as({ threadId: ThreadId.make("thread:launched"), resumed: false } as never),
        ),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch: (input) =>
        record("dispatch")(input).pipe(
          Effect.andThen(
            input.type === "thread.delete"
              ? Deferred.succeed(threads.deleted, input.threadId)
              : Effect.void,
          ),
          Effect.as({} as never),
        ),
      sendToThread: (input) =>
        record("send")(input).pipe(Effect.as({ run: { id: "run:launched" } } as never)),
      waitForThread: () =>
        Deferred.await(threads.runEnded).pipe(Effect.as({ timedOut: false } as never)),
      getThreadShell: (threadId) =>
        Effect.succeed(
          withWorking(
            { id: threadId, activeRunId: null, ...threads.shells.get(threadId) },
            working,
          ) as never,
        ),
      getShellSnapshot: (options) =>
        Effect.succeed({
          threads: [...threads.shells.values()]
            .filter(
              (shell) =>
                (shell.archivedAt != null) === ((options?.location ?? "active") === "archive"),
            )
            .map((shell) => withWorking(shell, working)),
        } as never),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      ensureScratchProject: Effect.sync(() => {
        scratch.calls += 1;
        return { projectId: SCRATCH };
      }),
      isScratchProject: (projectId) => Effect.succeed(projectId === SCRATCH),
    }),
    Layer.mock(SecretRequests.SecretRequests)({}),
    NodeCrypto.layer,
    Scheduler.layer,
  );
  return ScheduledTaskService.layer.pipe(Layer.provide(dependencies));
};

const withService = <A, E>(
  body: (input: {
    readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
    readonly commands: Array<Command>;
    readonly working: Set<string>;
    readonly scratch: { calls: number };
    readonly threads: Threads;
  }) => Effect.Effect<A, E>,
  policy?: ManagedPolicyDocument,
  /** Also runs the built-in tasks layer against these settings. */
  serverSettings?: Layer.Layer<ServerSettingsService>,
  threads: Threads = makeThreads(),
) => {
  const commands: Array<Command> = [];
  const working = new Set<string>();
  const scratch = { calls: 0 };
  const service = serviceLayer(commands, working, policy, scratch, threads);
  const layer =
    serverSettings === undefined
      ? service
      : builtInTasksLayer.pipe(Layer.provideMerge(service), Layer.provide(serverSettings));
  return Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    return yield* body({ service, commands, working, scratch, threads });
  }).pipe(Effect.provide(layer.pipe(Layer.provide(Layer.fresh(SqlitePersistence.layerMemory)))));
};

const DRIVERS = ["codex", "claudeAgent", "cursor", "grok", "muse", "pi", "opencode", "antigravity"];

/** Settings with only Codex enabled, or no provider at all. */
const settings = (options: { providers: boolean; autoBuckets?: boolean }): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: Object.fromEntries(
    DRIVERS.map((driver) => [
      ProviderInstanceId.make(driver),
      {
        driver: ProviderDriverKind.make(driver),
        enabled: options.providers && driver === "codex",
        config: {},
      },
    ]),
  ),
  machineResources: {
    ...DEFAULT_SERVER_SETTINGS.machineResources,
    autoBuckets: {
      enabled: options.autoBuckets ?? true,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4-mini" },
    },
  },
});

const builtInRow = (service: ScheduledTaskService.ScheduledTaskService["Service"]) =>
  service.list().pipe(Effect.map(({ tasks }) => tasks.find((task) => task.id === BUILT_IN)));

const ordinaryTask = {
  id: ScheduledTaskId.make("scheduled-task:ordinary"),
  title: "Nightly",
  prompt: "Check progress",
  enabled: true,
  schedule: {
    type: "load",
    condition: { metric: "cpuPercent", op: ">=", threshold: 90, sustainSeconds: 0 },
  },
  projectId: ProjectId.make("project:test"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

it.effect("creates the built-in row from settings, follows the switch and writes it once", () =>
  withService(({ service, scratch }) =>
    Effect.gen(function* () {
      // Switched off from the start, the row is still there, off.
      yield* service.ensureBuiltInTasks(settings({ providers: true, autoBuckets: false }));
      const initial = yield* builtInRow(service);
      assert.isFalse(initial?.enabled);

      yield* TestClock.adjust("1 minute");
      yield* service.ensureBuiltInTasks(settings({ providers: true }));
      const created = yield* builtInRow(service);
      assert.deepInclude(created, {
        title: "Machine buckets",
        prompt: MACHINE_BUCKETS_PROMPT,
        enabled: true,
        builtIn: "machine-buckets",
        runtimeMode: "auto",
        projectId: ProjectId.make("builtin:scratch"),
        threadId: null,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4-mini" },
      });
      assert.deepEqual(created?.schedule, {
        type: "load",
        condition: { metric: "unbucketedSharePercent", op: ">=", threshold: 25, sustainSeconds: 0 },
        clear: { metric: "unbucketedSharePercent", op: "<=", threshold: 15, sustainSeconds: 0 },
      });
      assert.isUndefined(created?.blockedByPolicy);

      yield* TestClock.adjust("1 minute");
      yield* service.ensureBuiltInTasks(settings({ providers: true }));
      const again = yield* builtInRow(service);
      assert.equal(again?.updatedAt, created?.updatedAt);
      assert.lengthOf((yield* service.list()).tasks, 1);

      yield* TestClock.adjust("1 minute");
      yield* service.ensureBuiltInTasks(settings({ providers: true, autoBuckets: false }));
      const off = yield* builtInRow(service);
      assert.isFalse(off?.enabled);
      assert.notEqual(off?.updatedAt, created?.updatedAt);
      assert.equal(off?.createdAt, initial?.createdAt);

      yield* service.ensureBuiltInTasks(settings({ providers: true }));
      assert.isTrue((yield* builtInRow(service))?.enabled);
      // Only a run prepares the scratch project.
      assert.equal(scratch.calls, 0);
    }),
  ),
);

it.effect("keeps the built-in row off and blocked while no provider is enabled", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.ensureBuiltInTasks(settings({ providers: false }));
      const blocked = yield* builtInRow(service);
      assert.isFalse(blocked?.enabled);
      assert.equal(blocked?.blockedByPolicy, "No provider available");

      yield* service.ensureBuiltInTasks(settings({ providers: true }));
      const unblocked = yield* builtInRow(service);
      assert.isTrue(unblocked?.enabled);
      assert.isUndefined(unblocked?.blockedByPolicy);
    }),
  ),
);

it.effect("shows a managed policy that denies auto mode as the built-in row's block", () =>
  withService(
    ({ service }) =>
      Effect.gen(function* () {
        yield* service.ensureBuiltInTasks(settings({ providers: true }));
        const blocked = yield* builtInRow(service);
        assert.isFalse(blocked?.enabled);
        assert.equal(blocked?.blockedByPolicy, "Example Corp limits threads to Auto-accept edits.");
      }),
    {
      schemaVersion: 1,
      organization: "Example Corp",
      limits: { maxRuntimeMode: "auto-accept-edits" },
    },
  ),
);

it.effect("refuses to edit, switch or delete the built-in row, and only that row", () =>
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.ensureBuiltInTasks(settings({ providers: true }));
      const before = yield* builtInRow(service);
      const refusals = [
        yield* service.upsert({ ...ordinaryTask, id: BUILT_IN }).pipe(Effect.flip),
        yield* service.setEnabled({ id: BUILT_IN, enabled: false }).pipe(Effect.flip),
        yield* service.delete({ id: BUILT_IN }).pipe(Effect.flip),
      ];
      for (const refusal of refusals) {
        assert.match(refusal.message, /^This task is built in\./);
      }
      assert.deepEqual(yield* builtInRow(service), before);

      yield* service.upsert(ordinaryTask);
      yield* service.setEnabled({ id: ordinaryTask.id, enabled: false });
      yield* service.delete({ id: ordinaryTask.id });
      assert.deepEqual(
        (yield* service.list()).tasks.map((task) => task.id),
        [BUILT_IN],
      );
    }),
  ),
);

it.effect("starts the built-in run's thread, tags it, then sends the prompt", () =>
  withService(({ service, commands, scratch }) =>
    Effect.gen(function* () {
      yield* service.ensureBuiltInTasks(settings({ providers: true }));
      yield* service.triggerLoad(BUILT_IN, "1000");
      const commandId = `scheduled-task:${BUILT_IN}:load:1000`;
      assert.deepEqual(
        commands.map(({ type, input }) => [type, input.commandId]),
        [
          ["launch", commandId],
          ["dispatch", `${commandId}:tag:backgrounded`],
          ["dispatch", `${commandId}:tag:machine-buckets`],
          ["send", `${commandId}:message`],
        ],
      );
      const [launch, backgrounded, machineBuckets, send] = commands.map(({ input }) => input);
      assert.equal(scratch.calls, 1);
      assert.equal(launch?.projectId, SCRATCH);
      assert.equal(send?.projectId, SCRATCH);
      assert.equal(launch?.title, "Machine buckets");
      assert.equal(launch?.runtimeMode, "auto");
      assert.notProperty(launch, "initialMessage");
      for (const [tagged, tag] of [
        [backgrounded, "backgrounded"],
        [machineBuckets, "machine-buckets"],
      ] as const) {
        assert.deepInclude(tagged, {
          type: "thread.tag.set",
          threadId: "thread:launched",
          tag,
          tagged: true,
        });
      }
      assert.deepInclude(send, {
        threadId: "thread:launched",
        scheduledTaskId: BUILT_IN,
        text: MACHINE_BUCKETS_PROMPT,
      });
    }),
  ),
);

it.effect("still starts an ordinary load task with its prompt as the first message", () =>
  withService(({ service, commands }) =>
    Effect.gen(function* () {
      yield* service.upsert(ordinaryTask);
      yield* service.triggerLoad(ordinaryTask.id, "1000");
      assert.deepEqual(
        commands.map(({ type }) => type),
        ["launch"],
      );
      assert.deepInclude(commands[0]?.input.initialMessage as object, {
        scheduledTaskId: ordinaryTask.id,
        text: "Check progress",
      });
    }),
  ),
);

it.effect("keeps the built-in row in step with settings from startup on", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make(settings({ providers: true }));
    const changes = yield* PubSub.unbounded<ServerSettings>();
    const serverSettings = Layer.mock(ServerSettingsService)({
      getSettings: Ref.get(current),
      subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    });
    const change = (next: ServerSettings) =>
      Ref.set(current, next).pipe(Effect.andThen(PubSub.publish(changes, next)));

    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          const rowWhen = (matches: (task: ScheduledTask | undefined) => boolean) =>
            service.subscribeList().pipe(
              Stream.map(({ tasks }) => tasks.find((task) => task.id === BUILT_IN)),
              Stream.filter(matches),
              Stream.runHead,
            );
          const started = yield* rowWhen((task) => task?.enabled === true);
          assert.equal(started._tag, "Some");

          yield* change(settings({ providers: true, autoBuckets: false }));
          yield* rowWhen((task) => task?.enabled === false);

          yield* change(settings({ providers: false }));
          yield* rowWhen((task) => task?.blockedByPolicy === "No provider available");

          yield* change(settings({ providers: true }));
          const back = yield* rowWhen(
            (task) => task?.enabled === true && task.blockedByPolicy === undefined,
          );
          assert.equal(back._tag, "Some");
        }),
      undefined,
      serverSettings,
    );
  }),
);

const launches = (commands: ReadonlyArray<Command>) =>
  commands.filter((command) => command.type === "launch").length;
const PROCESSES = [
  "postgres",
  "redis",
  "next-server",
  "vite",
  "esbuild",
  "tsc",
  "git",
  "zsh",
  "ssh",
  "make",
];

it("counts an unowned set as changed once 30 % of its distinct keys are new", () => {
  const cases: ReadonlyArray<[ReadonlySet<string> | null, ReadonlyArray<string>, boolean]> = [
    [null, ["postgres"], true],
    [null, [], false],
    [new Set(PROCESSES), [...PROCESSES, ...PROCESSES], false],
    [new Set(PROCESSES), [...PROCESSES.slice(0, 8), "docker-proxy", "containerd"], false],
    [new Set(PROCESSES), [...PROCESSES.slice(0, 7), "docker-proxy", "containerd", "nginx"], true],
  ];
  for (const [previous, next, changed] of cases) {
    assert.equal(ScheduledTaskService.unownedSetChanged(previous, next), changed, next.join());
  }
  assert.equal(
    ScheduledTaskService.unownedProcessKey({ name: "node", container: "acme-api-1" }),
    "container:acme-api-1",
  );
});

it.effect("runs the built-in in the background at most every 6 hours, across a restart", () =>
  Effect.gen(function* () {
    const commands: Array<Command> = [];
    const database = yield* Layer.build(Layer.fresh(SqlitePersistence.layerMemory));
    const start = <E>(
      run: (
        service: ScheduledTaskService.ScheduledTaskService["Service"],
      ) => Effect.Effect<void, E>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            serviceLayer(commands, new Set()).pipe(Layer.provide(Layer.succeedContext(database))),
          );
          yield* run(Context.get(context, ScheduledTaskService.ScheduledTaskService));
        }),
      );

    yield* start((service) =>
      Effect.gen(function* () {
        yield* service.ensureBuiltInTasks(settings({ providers: true }));
        yield* service.upsert(ordinaryTask);
        yield* service.triggerLoad(BUILT_IN, "1", ["postgres"]);
        yield* service.triggerLoad(ordinaryTask.id, "1");
        yield* service.triggerLoad(ordinaryTask.id, "2");
      }),
    );
    // The built-in once; a user's load task is never held back.
    assert.equal(launches(commands), 3);

    yield* TestClock.adjust("1 hour");
    yield* start((service) =>
      Effect.gen(function* () {
        // A restart forgets the episode and the last unowned set, but not the last run.
        yield* service.triggerLoad(BUILT_IN, "2", ["redis"]);
        assert.equal(launches(commands), 3);
        yield* service.runNow({ id: BUILT_IN });
        assert.equal(launches(commands), 4);
        yield* TestClock.adjust("5 hours");
        yield* service.triggerLoad(BUILT_IN, "3", ["redis"]);
        assert.equal(launches(commands), 4);
        yield* TestClock.adjust("1 hour");
        yield* service.triggerLoad(BUILT_IN, "4", ["redis"]);
        assert.equal(launches(commands), 5);
      }),
    );
  }).pipe(Effect.scoped),
);

it.effect("skips the built-in while its last run's thread is still working", () =>
  withService(({ service, commands, working }) =>
    Effect.gen(function* () {
      yield* service.ensureBuiltInTasks(settings({ providers: true }));
      yield* service.triggerLoad(BUILT_IN, "1", ["postgres"]);
      working.add("thread:launched");
      yield* TestClock.adjust("7 hours");
      yield* service.triggerLoad(BUILT_IN, "2", ["redis"]);
      assert.equal(launches(commands), 1);
      working.delete("thread:launched");
      yield* service.triggerLoad(BUILT_IN, "3", ["redis"]);
      assert.equal(launches(commands), 2);
    }),
  ),
);

it.effect("skips the built-in when the unowned processes are mostly the ones it last saw", () =>
  withService(({ service, commands }) =>
    Effect.gen(function* () {
      yield* service.ensureBuiltInTasks(settings({ providers: true }));
      yield* service.triggerLoad(BUILT_IN, "1", PROCESSES);
      yield* TestClock.adjust("7 hours");
      yield* service.triggerLoad(BUILT_IN, "2", [...PROCESSES.slice(0, 8), "nginx", "caddy"]);
      yield* service.triggerLoad(BUILT_IN, "3", []);
      assert.equal(launches(commands), 1);
      yield* service.triggerLoad(BUILT_IN, "4", [
        ...PROCESSES.slice(0, 7),
        "nginx",
        "caddy",
        "java",
      ]);
      assert.equal(launches(commands), 2);
    }),
  ),
);

it.effect(
  "re-fires the built-in at each hourly read while the share holds, so only the caps limit it",
  () =>
    Effect.gen(function* () {
      const commands: Array<Command> = [];
      const unowned = yield* Ref.make<ReadonlyArray<string>>(["postgres"]);
      const host = Layer.mergeAll(
        Scheduler.layer,
        Layer.mock(HostResources.HostResources)({ ticks: Stream.never, status: Stream.never }),
        Layer.mock(HostProcesses.HostProcesses)({
          unbucketed: () =>
            Ref.get(unowned).pipe(
              Effect.map((names) => ({
                sharePercent: 40,
                sampleAgeMs: 0,
                buckets: [],
                processes: names.map((name, pid) => ({
                  pid,
                  ppid: 1,
                  name,
                  exe: `/usr/bin/${name}`,
                  user: "user",
                  cpuPercent: 10,
                  rssBytes: 1,
                })),
              })),
            ),
        }),
      );
      const context = yield* Layer.build(
        monitorLayer.pipe(
          Layer.provideMerge(serviceLayer(commands, new Set())),
          Layer.provide(host),
          Layer.provide(Layer.fresh(SqlitePersistence.layerMemory)),
        ),
      );
      const service = Context.get(context, ScheduledTaskService.ScheduledTaskService);
      yield* service.ensureBuiltInTasks(settings({ providers: true }));
      yield* TestClock.adjust("10 seconds");
      assert.equal(launches(commands), 1);

      // The next hourly read fires again; the 6 h cooldown skips it.
      yield* TestClock.adjust(UNBUCKETED_INTERVAL_MS);
      assert.equal(launches(commands), 1);

      // Past 6 h the same set is skipped, and a changed set runs.
      yield* TestClock.adjust(5 * UNBUCKETED_INTERVAL_MS);
      assert.equal(launches(commands), 1);
      yield* Ref.set(unowned, ["redis"]);
      yield* TestClock.adjust(UNBUCKETED_INTERVAL_MS);
      assert.equal(launches(commands), 2);
    }).pipe(Effect.scoped),
);

const deletes = (commands: ReadonlyArray<Command>) =>
  commands.flatMap(({ type, input }) =>
    type === "dispatch" && input.type === "thread.delete" ? [input.threadId] : [],
  );

it.effect("deletes the built-in run's thread once its run ends", () =>
  withService(({ service, commands, threads }) =>
    Effect.gen(function* () {
      yield* service.ensureBuiltInTasks(settings({ providers: true }));
      yield* service.triggerLoad(BUILT_IN, "1000");
      threads.shells.set("thread:launched", bucketsThread("thread:launched"));
      assert.deepEqual(deletes(commands), []);
      yield* Deferred.succeed(threads.runEnded, undefined);
      assert.equal(yield* Deferred.await(threads.deleted), "thread:launched");
      assert.deepEqual(deletes(commands), ["thread:launched"]);
    }),
  ),
);

it.effect("keeps a finished built-in thread the user pinned or wrote in", () =>
  withService(({ service, commands, threads }) =>
    Effect.gen(function* () {
      yield* service.ensureBuiltInTasks(settings({ providers: true }));
      yield* service.triggerLoad(BUILT_IN, "1000");
      threads.shells.set(
        "thread:launched",
        bucketsThread("thread:launched", { latestUserAuthoredMessageAt: "2026-11-12T00:00:00Z" }),
      );
      yield* Deferred.succeed(threads.runEnded, undefined);
      yield* TestClock.adjust("7 hours");
      // The next run's sweep sees it too, and keeps it.
      yield* service.triggerLoad(BUILT_IN, "2000", ["redis"]);
      assert.deepEqual(deletes(commands), []);
    }),
  ),
);

it.effect("sweeps finished auto-buckets threads left behind, at startup and before each run", () =>
  withService(
    ({ service, commands, threads, working }) =>
      Effect.gen(function* () {
        assert.equal(yield* Deferred.await(threads.deleted), "thread:stale");
        threads.shells.set("thread:stale-later", bucketsThread("thread:stale-later"));
        threads.shells.set("thread:running", bucketsThread("thread:running"));
        working.add("thread:running");
        yield* service.ensureBuiltInTasks(settings({ providers: true }));
        yield* service.triggerLoad(BUILT_IN, "1000");
        assert.sameMembers(
          [...new Set(deletes(commands))],
          ["thread:stale", "thread:failed", "thread:stale-later"],
        );
      }),
    undefined,
    undefined,
    makeThreads({
      "thread:stale": bucketsThread("thread:stale"),
      "thread:failed": bucketsThread("thread:failed", { status: "failed" }),
      // A user's Stop and a load pause both leave the run interrupted.
      "thread:interrupted": bucketsThread("thread:interrupted", { status: "interrupted" }),
      "thread:load-paused": bucketsThread("thread:load-paused", {
        status: "interrupted",
        loadPause: { pausedAt: "2026-11-12T00:00:00Z" },
      }),
      "thread:limit-recovery": bucketsThread("thread:limit-recovery", {
        status: "failed",
        limitRecovery: { resumeAt: "2026-11-12T00:00:00Z" },
      }),
      "thread:queued": bucketsThread("thread:queued", { status: "queued" }),
      "thread:asking": bucketsThread("thread:asking", {
        status: "waiting",
        pendingRuntimeRequest: { id: "request:1" },
      }),
      "thread:pinned": bucketsThread("thread:pinned", { pinnedAt: "2026-11-12T00:00:00Z" }),
      "thread:archived": bucketsThread("thread:archived", { archivedAt: "2026-11-12T00:00:00Z" }),
      "thread:user-wrote": bucketsThread("thread:user-wrote", {
        latestUserAuthoredMessageAt: "2026-11-12T00:00:00Z",
      }),
      "thread:side-chatted": bucketsThread("thread:side-chatted"),
      "thread:side-chat": bucketsThread("thread:side-chat", {
        tags: [],
        lineage: {
          parentThreadId: "thread:side-chatted",
          relationshipToParent: "fork",
          rootThreadId: "thread:side-chatted",
          sideChat: true,
        },
      }),
      // Deleting a thread deletes its side chats, archived ones too.
      "thread:archived-side-chatted": bucketsThread("thread:archived-side-chatted"),
      "thread:archived-side-chat": bucketsThread("thread:archived-side-chat", {
        tags: [],
        archivedAt: "2026-11-12T00:00:00Z",
        lineage: {
          parentThreadId: "thread:archived-side-chatted",
          relationshipToParent: "fork",
          rootThreadId: "thread:archived-side-chatted",
          sideChat: true,
        },
      }),
      // Tags carry over to a fork, so the fork is tagged too.
      "thread:forked": bucketsThread("thread:forked"),
      "thread:fork": bucketsThread("thread:fork", {
        lineage: {
          parentThreadId: "thread:forked",
          relationshipToParent: "fork",
          rootThreadId: "thread:forked",
        },
      }),
      "thread:untagged": bucketsThread("thread:untagged", { tags: ["backgrounded"] }),
      "thread:elsewhere": bucketsThread("thread:elsewhere", {
        projectId: ProjectId.make("project:test"),
      }),
    }),
  ),
);
