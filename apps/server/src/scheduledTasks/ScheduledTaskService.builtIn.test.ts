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
import { builtInTasksLayer } from "./LoadMonitor.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const SCRATCH = ProjectId.make("project:scratch");
const BUILT_IN = ScheduledTaskService.MACHINE_BUCKETS_TASK_ID;

type Command =
  | { readonly type: "launch"; readonly input: Record<string, unknown> }
  | { readonly type: "dispatch"; readonly input: Record<string, unknown> }
  | { readonly type: "send"; readonly input: Record<string, unknown> };

/** The service with every thread command it issues recorded in order. */
const withService = <A, E>(
  body: (input: {
    readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
    readonly commands: Array<Command>;
  }) => Effect.Effect<A, E>,
  policy?: ManagedPolicyDocument,
  /** Also runs the built-in tasks layer against these settings. */
  serverSettings?: Layer.Layer<ServerSettingsService>,
) => {
  const commands: Array<Command> = [];
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
      dispatch: (input) => record("dispatch")(input).pipe(Effect.as({} as never)),
      sendToThread: (input) => record("send")(input).pipe(Effect.as({} as never)),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      ensureScratchProject: Effect.succeed({ projectId: SCRATCH }),
      isScratchProject: (projectId) => Effect.succeed(projectId === SCRATCH),
    }),
    Layer.mock(SecretRequests.SecretRequests)({}),
    NodeCrypto.layer,
    Scheduler.layer,
  );
  const service = ScheduledTaskService.layer.pipe(Layer.provide(dependencies));
  const layer =
    serverSettings === undefined
      ? service
      : builtInTasksLayer.pipe(Layer.provideMerge(service), Layer.provide(serverSettings));
  return Effect.gen(function* () {
    const service = yield* ScheduledTaskService.ScheduledTaskService;
    return yield* body({ service, commands });
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
  withService(({ service }) =>
    Effect.gen(function* () {
      yield* service.ensureBuiltInTasks(settings({ providers: true }));
      const created = yield* builtInRow(service);
      assert.deepInclude(created, {
        title: "Machine buckets",
        prompt: MACHINE_BUCKETS_PROMPT,
        enabled: true,
        builtIn: "machine-buckets",
        runtimeMode: "auto",
        projectId: SCRATCH,
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

      yield* service.ensureBuiltInTasks(settings({ providers: true, autoBuckets: false }));
      const off = yield* builtInRow(service);
      assert.isFalse(off?.enabled);
      assert.notEqual(off?.updatedAt, created?.updatedAt);
      assert.equal(off?.createdAt, created?.createdAt);

      yield* service.ensureBuiltInTasks(settings({ providers: true }));
      assert.isTrue((yield* builtInRow(service))?.enabled);
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
  withService(({ service, commands }) =>
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
