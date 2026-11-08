import type { OrchestrationV2LoadPausedContainer } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";

const PAUSE_TIMEOUT = Duration.seconds(10);
// A loaded daemon can be slow to thaw a container, and a timed-out unpause leaves it frozen.
const UNPAUSE_TIMEOUT = Duration.seconds(30);

/** A `docker pause`/`unpause` that did not happen; the thread pauses or resumes regardless. */
export class LoadPauseDockerError extends Schema.TaggedError<LoadPauseDockerError>()(
  "LoadPauseDockerError",
  {
    reason: Schema.Literals(["not-found", "permission", "failed"]),
    containerId: Schema.String,
    detail: Schema.String,
  },
) {}

const errorReason = (stderr: string): LoadPauseDockerError["reason"] =>
  /no such/i.test(stderr)
    ? "not-found"
    : /permission denied|operation not permitted|EPERM/i.test(stderr)
      ? "permission"
      : "failed";

type Outcome = "done" | "skipped";

export class LoadPauseDocker extends Context.Service<
  LoadPauseDocker,
  {
    /** Pauses only while `stillWanted` holds, before and after the pause; false undoes it. */
    readonly pause: <R>(
      container: OrchestrationV2LoadPausedContainer,
      stillWanted: Effect.Effect<boolean, never, R>,
    ) => Effect.Effect<Outcome, LoadPauseDockerError, R>;
    readonly unpause: (
      container: OrchestrationV2LoadPausedContainer,
    ) => Effect.Effect<Outcome, LoadPauseDockerError>;
  }
>()("t3/orchestration-v2/LoadPauseDocker") {}

export const containerKey = (container: OrchestrationV2LoadPausedContainer) =>
  `${container.dockerHost ?? ""}\u0000${container.id}`;

/**
 * Pause and unpause by recorded full id, each after a fresh `docker inspect` under the claim's
 * `DOCKER_HOST` shows the same container in the expected state. Anything else is skipped.
 * One lock per container keeps the pause worker and resume cleanups from interleaving.
 */
export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; holders: number }>();

  const withContainerLock = <A, E, R>(
    container: OrchestrationV2LoadPausedContainer,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.suspend(() => {
      const key = containerKey(container);
      const entry = locks.get(key) ?? { lock: Semaphore.makeUnsafe(1), holders: 0 };
      locks.set(key, entry);
      entry.holders += 1;
      return entry.lock.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.holders -= 1;
            if (entry.holders === 0) locks.delete(key);
          }),
        ),
      );
    });

  const docker = (
    container: OrchestrationV2LoadPausedContainer,
    args: ReadonlyArray<string>,
    timeout = PAUSE_TIMEOUT,
  ) =>
    runner
      .run({
        command: "docker",
        args,
        env: {
          ...process.env,
          ...(container.dockerHost === undefined ? {} : { DOCKER_HOST: container.dockerHost }),
        },
        timeout,
        maxOutputBytes: 64 * 1024,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new LoadPauseDockerError({
              reason: "failed",
              containerId: container.id,
              detail: `Could not run docker: ${cause.message}`,
            }),
        ),
      );

  const inspect = Effect.fn("LoadPauseDocker.inspect")(function* (
    container: OrchestrationV2LoadPausedContainer,
  ) {
    const result = yield* docker(container, [
      "inspect",
      "--type",
      "container",
      "--format",
      "{{.Id}} {{.State.Status}} {{.State.Pid}}",
      container.id,
    ]);
    if (result.code !== 0) {
      return yield* new LoadPauseDockerError({
        reason: errorReason(result.stderr),
        containerId: container.id,
        detail: result.stderr.trim() || "docker inspect failed.",
      });
    }
    const [id = "", status = "", pid = "0"] = result.stdout.trim().split(/\s+/);
    return { id, status, pid: Number(pid) || 0 };
  });

  const transition = Effect.fn("LoadPauseDocker.transition")(function* (
    container: OrchestrationV2LoadPausedContainer,
    command: "pause" | "unpause",
  ) {
    const state = yield* inspect(container);
    const expected = command === "pause" ? "running" : "paused";
    // The pid check keeps a container that would be the host's init (or this server) running.
    if (
      state.id !== container.id ||
      state.status !== expected ||
      state.pid <= 1 ||
      state.pid === process.pid
    ) {
      return "skipped";
    }
    const result = yield* docker(
      container,
      [command, container.id],
      command === "pause" ? PAUSE_TIMEOUT : UNPAUSE_TIMEOUT,
    );
    if (result.code === 0) return "done";
    if (/is not paused|is already paused|is not running/i.test(result.stderr)) return "skipped";
    return yield* new LoadPauseDockerError({
      reason: errorReason(result.stderr),
      containerId: container.id,
      detail: result.stderr.trim() || `docker ${command} failed.`,
    });
  });

  const pause = Effect.fn("LoadPauseDocker.pause")(
    function* <R>(
      container: OrchestrationV2LoadPausedContainer,
      stillWanted: Effect.Effect<boolean, never, R>,
    ) {
      if (!(yield* stillWanted)) return "skipped" as const;
      const paused = yield* transition(container, "pause");
      if (paused === "skipped" || (yield* stillWanted)) return paused;
      // The pause ended, or another thread claimed the container, while docker ran.
      yield* transition(container, "unpause");
      return "skipped" as const;
    },
    (effect, container) => withContainerLock(container, effect),
  );

  const unpause = Effect.fn("LoadPauseDocker.unpause")(
    (container: OrchestrationV2LoadPausedContainer) => transition(container, "unpause"),
    (effect, container) => withContainerLock(container, effect),
  );

  return LoadPauseDocker.of({ pause, unpause });
});

export const layer = Layer.effect(LoadPauseDocker, make);
