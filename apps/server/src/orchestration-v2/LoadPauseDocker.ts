import type { OrchestrationV2LoadPausedContainer } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const DOCKER_TIMEOUT = Duration.seconds(10);

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

/**
 * Pause and unpause by recorded full id, each after a fresh `docker inspect` under the claim's
 * `DOCKER_HOST` shows the same container in the expected state. Anything else is skipped.
 */
export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;

  const docker = (container: OrchestrationV2LoadPausedContainer, args: ReadonlyArray<string>) =>
    runner
      .run({
        command: "docker",
        args,
        env: {
          ...process.env,
          ...(container.dockerHost === undefined ? {} : { DOCKER_HOST: container.dockerHost }),
        },
        timeout: DOCKER_TIMEOUT,
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
    const result = yield* docker(container, [command, container.id]);
    if (result.code === 0) return "done";
    if (/is not paused|is already paused|is not running/i.test(result.stderr)) return "skipped";
    return yield* new LoadPauseDockerError({
      reason: errorReason(result.stderr),
      containerId: container.id,
      detail: result.stderr.trim() || `docker ${command} failed.`,
    });
  });

  return {
    pause: (container: OrchestrationV2LoadPausedContainer) => transition(container, "pause"),
    unpause: (container: OrchestrationV2LoadPausedContainer) => transition(container, "unpause"),
  };
});
