import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2LoadPausedContainer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as LoadPauseDocker from "./LoadPauseDocker.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";

const FULL_ID = "c".repeat(64);
const HOST = "ssh://builder@box";
/** Read once outside Effect code: docker without a recorded host inherits the server's. */
const SERVER_DOCKER_HOST = process.env.DOCKER_HOST;

interface Reply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

/** Answers `docker inspect` and `docker pause|unpause` from the script; records every call. */
const fakeDocker = (script: {
  readonly inspect: Reply | "spawn-error";
  readonly action?: Reply;
}) => {
  const calls: Array<{
    readonly args: ReadonlyArray<string>;
    readonly dockerHost: string | undefined;
  }> = [];
  const output = (reply: Reply): ProcessRunner.ProcessRunOutput => ({
    stdout: reply.stdout ?? "",
    stderr: reply.stderr ?? "",
    code: (reply.code ?? 0) as ChildProcessSpawner.ExitCode,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  });
  const runner: ProcessRunner.ProcessRunner["Service"] = {
    run: (input) => {
      calls.push({ args: input.args, dockerHost: input.env?.DOCKER_HOST });
      if (input.command !== "docker") return Effect.die(`unexpected command ${input.command}`);
      if (input.args[0] === "inspect") {
        return script.inspect === "spawn-error"
          ? Effect.fail(
              new ProcessRunner.ProcessSpawnError({
                command: "docker",
                argumentCount: input.args.length,
                cause: new Error("ENOENT"),
              }),
            )
          : Effect.succeed(output(script.inspect));
      }
      return Effect.succeed(output(script.action ?? {}));
    },
  };
  return { calls, runner };
};

const transition = (
  command: "pause" | "unpause",
  script: Parameters<typeof fakeDocker>[0],
  container: OrchestrationV2LoadPausedContainer = { id: FULL_ID },
) => {
  const docker = fakeDocker(script);
  return LoadPauseDocker.make.pipe(
    Effect.flatMap((service) => service[command](container)),
    Effect.provideService(ProcessRunner.ProcessRunner, docker.runner),
    Effect.result,
    Effect.map((result) => ({ result, calls: docker.calls })),
  );
};

/** "done" or "skipped", or the typed failure's reason. */
const outcome = (result: Effect.Success<ReturnType<typeof transition>>["result"]): string =>
  result._tag === "Success" ? result.success : result.failure.reason;

const inspectArgs = [
  "inspect",
  "--type",
  "container",
  "--format",
  "{{.Id}} {{.State.Status}} {{.State.Pid}}",
  FULL_ID,
];

describe("LoadPauseDocker", () => {
  it.effect.each([
    ["pause", "running"],
    ["unpause", "paused"],
  ] as const)(
    "%s inspects under the claim's DOCKER_HOST, then acts on the full id",
    ([command, state]) =>
      Effect.gen(function* () {
        const { result, calls } = yield* transition(
          command,
          { inspect: { stdout: `${FULL_ID} ${state} 4242\n` } },
          { id: FULL_ID, dockerHost: HOST },
        );
        assert.equal(outcome(result), "done");
        assert.deepEqual(calls, [
          { args: inspectArgs, dockerHost: HOST },
          { args: [command, FULL_ID], dockerHost: HOST },
        ]);
      }),
  );

  it.effect("leaves DOCKER_HOST as the server's own without a recorded host", () =>
    Effect.gen(function* () {
      const { calls } = yield* transition("pause", {
        inspect: { stdout: `${FULL_ID} running 4242` },
      });
      assert.deepEqual(
        calls.map((call) => call.dockerHost),
        [SERVER_DOCKER_HOST, SERVER_DOCKER_HOST],
      );
    }),
  );

  it.effect.each([
    ["pause", "another container now holds the name", `${"d".repeat(64)} running 4242`],
    ["pause", "already paused", `${FULL_ID} paused 4242`],
    ["pause", "exited", `${FULL_ID} exited 0`],
    ["unpause", "running again", `${FULL_ID} running 4242`],
    ["unpause", "recreated under another id", `${"d".repeat(64)} paused 4242`],
    ["pause", "init is pid 1", `${FULL_ID} running 1`],
    ["pause", "no pid", `${FULL_ID} running 0`],
    ["pause", "the container's init is this server", `${FULL_ID} running ${process.pid}`],
    ["unpause", "the container's init is this server", `${FULL_ID} paused ${process.pid}`],
    ["pause", "empty inspect output", ""],
  ] as const)("%s is skipped with no docker action when %s", ([command, _why, stdout]) =>
    Effect.gen(function* () {
      const { result, calls } = yield* transition(command, { inspect: { stdout } });
      assert.equal(outcome(result), "skipped");
      assert.deepEqual(
        calls.map((call) => call.args[0]),
        ["inspect"],
      );
    }),
  );

  it.effect.each([
    ["pause", "Error response from daemon: Container abc is already paused", "skipped"],
    ["unpause", "Error response from daemon: Container abc is not paused", "skipped"],
    ["pause", "Error response from daemon: Container abc is not running", "skipped"],
    ["pause", "Error: No such container: abc", "not-found"],
    [
      "pause",
      "permission denied while trying to connect to the Docker daemon socket",
      "permission",
    ],
    ["unpause", "failed to thaw: operation not permitted", "permission"],
    ["pause", "write /sys/fs/cgroup/freezer: EPERM", "permission"],
    ["pause", "something else went wrong", "failed"],
  ] as const)("%s failing with %j → %s", ([command, stderr, expected]) =>
    Effect.gen(function* () {
      const state = command === "pause" ? "running" : "paused";
      const { result } = yield* transition(command, {
        inspect: { stdout: `${FULL_ID} ${state} 4242` },
        action: { code: 1, stderr },
      });
      assert.equal(outcome(result), expected);
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, LoadPauseDocker.LoadPauseDockerError);
        assert.equal(result.failure.containerId, FULL_ID);
      }
    }),
  );

  it.effect.each([
    [
      "a missing container at inspect",
      { inspect: { code: 1, stderr: "Error: No such object: abc" } },
      "not-found",
    ],
    [
      "a refused daemon socket at inspect",
      { inspect: { code: 1, stderr: "permission denied" } },
      "permission",
    ],
    ["no docker binary", { inspect: "spawn-error" }, "failed"],
  ] as const)("%s fails typed (%s) without a pause", ([_name, script, reason]) =>
    Effect.gen(function* () {
      const { result, calls } = yield* transition("pause", script);
      assert.equal(outcome(result), reason);
      assert.deepEqual(
        calls.map((call) => call.args[0]),
        ["inspect"],
      );
    }),
  );

  it.effect("cleanup unpauses every recorded container past one that fails", () =>
    Effect.gen(function* () {
      const failures: Record<string, string> = {
        ["a".repeat(64)]: "Error response from daemon: No such container: aaa",
        ["b".repeat(64)]: "Error response from daemon: operation not permitted (EPERM)",
        ["c".repeat(64)]: "Error response from daemon: something broke",
      };
      const unpaused: Array<string> = [];
      const runner: ProcessRunner.ProcessRunner["Service"] = {
        run: (input) => {
          const id = input.args.at(-1)!;
          const reply =
            input.args[0] === "inspect"
              ? { stdout: `${id} paused 4242`, stderr: "", code: 0 }
              : { stdout: "", stderr: failures[id] ?? "", code: id in failures ? 1 : 0 };
          if (input.args[0] === "unpause") unpaused.push(id);
          return Effect.succeed({
            ...reply,
            code: reply.code as ChildProcessSpawner.ExitCode,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          });
        },
      };
      const ids = ["a", "b", "c", "d"].map((letter) => letter.repeat(64));
      const result = yield* Effect.gen(function* () {
        const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
        yield* cleanup.unpauseLoadPausedContainers(ids.map((id) => ({ id })));
      }).pipe(
        Effect.provide(
          ResourceCleanupService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(TerminalManager.TerminalManager)({}),
                Layer.mock(PreviewManager.PreviewManager)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
                Layer.succeed(ProcessRunner.ProcessRunner, runner),
              ),
            ),
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-load-pause-" })),
            Layer.provide(NodeServices.layer),
          ),
        ),
        Effect.result,
      );
      assert.equal(result._tag, "Success");
      assert.deepEqual(unpaused, ids);
    }),
  );
});
