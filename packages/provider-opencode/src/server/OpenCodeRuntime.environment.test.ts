import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { it as effectIt } from "@effect/vitest";
import { AgentScope } from "@t3tools/shared/AgentScope";
import {
  ProcessOwnershipRegistry,
  type ProcessRoot,
} from "@t3tools/shared/ProcessOwnershipRegistry";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";

describe("resolveOpenCodeServerPassword", () => {
  it("uses the settings password when local settings and environment differ", () => {
    expect(
      OpenCodeRuntime.resolveOpenCodeServerPassword(
        {
          external: false,
          serverPassword: "settings-password",
          environment: { OPENCODE_SERVER_PASSWORD: "environment-password" },
        },
        {},
      ),
    ).toBe("settings-password");
  });

  it("does not send an inherited local password to an external server", () => {
    expect(
      OpenCodeRuntime.resolveOpenCodeServerPassword(
        { external: true, environment: { OPENCODE_SERVER_PASSWORD: "local-secret" } },
        { OPENCODE_SERVER_PASSWORD: "inherited-secret" },
      ),
    ).toBeUndefined();
  });
});

function makeHealthClient(
  result: (options?: { readonly signal?: AbortSignal }) => Promise<unknown>,
): OpencodeClient {
  return {
    global: {
      health: result,
    },
  } as unknown as OpencodeClient;
}

describe("verifyOpenCodeServerVersion", () => {
  effectIt.effect("rejects a server below the supported version", () =>
    Effect.gen(function* () {
      const error = yield* OpenCodeRuntime.verifyOpenCodeServerVersion(
        makeHealthClient(() => Promise.resolve({ data: { healthy: true, version: "1.14.18" } })),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OpenCodeRuntime.OpenCodeRuntimeError);
      expect(error.detail).toContain("v1.14.18 is too old");
    }),
  );
});

describe("OpenCode serve ownership", () => {
  // Above pid_max, so the group kill on close cannot reach a real process.
  const FIRST_PID = 2_000_000_010;

  interface Registered {
    readonly root: ProcessRoot;
    releases: number;
    readonly released: Deferred.Deferred<void>;
  }

  const withRuntime = <A, E>(
    body: (
      runtime: OpenCodeRuntime.OpenCodeRuntime["Service"],
      registered: Queue.Queue<Registered>,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const registered = yield* Queue.unbounded<Registered>();
      let nextPid = FIRST_PID;
      const layer = OpenCodeRuntime.layer.pipe(
        Layer.provide(OpenCodeServerLedger.layerTest),
        Layer.provide(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            // A serve that never reports ready: its root is registered at spawn.
            ChildProcessSpawner.make(() =>
              Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(nextPid++),
                  exitCode: Effect.never,
                  isRunning: Effect.succeed(true),
                  kill: () => Effect.void,
                  stdin: Sink.drain,
                  stdout: Stream.never,
                  stderr: Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                  unref: Effect.succeed(Effect.void),
                }),
              ),
            ),
          ),
        ),
      );
      return yield* OpenCodeRuntime.OpenCodeRuntime.pipe(
        Effect.flatMap((runtime) => body(runtime, registered)),
        Effect.provide(layer),
        Effect.provideService(AgentScope, {
          ...AgentScope.defaultValue(),
          wrap: ({ command, args }) => Effect.succeed({ command, args, unit: "t3-opencode.scope" }),
          controlGroup: (unit) =>
            Effect.succeed(unit === "t3-opencode.scope" ? "/agents/t3-opencode.scope" : undefined),
        }),
        Effect.provideService(ProcessOwnershipRegistry, {
          registerRoot: (root) => {
            const entry: Registered = { root, releases: 0, released: Deferred.makeUnsafe() };
            Queue.offerUnsafe(registered, entry);
            return () => {
              entry.releases += 1;
              Deferred.doneUnsafe(entry.released, Exit.void);
            };
          },
          roots: () => [],
        }),
      );
    });

  const closeServe = (serve: { readonly scope: Scope.Closeable; readonly entry: Registered }) =>
    Effect.gen(function* () {
      const closing = yield* Scope.close(serve.scope, Exit.void).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      // The root is released just before the group kill sleeps between SIGTERM and SIGKILL.
      yield* Deferred.await(serve.entry.released);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(closing);
    });

  effectIt.effect("gives a session's serve to its thread and leaves an unowned serve shared", () =>
    withRuntime((runtime, registered) =>
      Effect.gen(function* () {
        const start = (threadId?: string) =>
          Effect.gen(function* () {
            const scope = yield* Scope.make();
            yield* runtime
              .startOpenCodeServerProcess({
                binaryPath: "opencode",
                directory: "/work/app",
                port: 4096,
                timeoutMs: 600_000,
                ...(threadId === undefined ? {} : { threadId }),
              })
              .pipe(Effect.provideService(Scope.Scope, scope), Effect.forkChild);
            return { scope, entry: yield* Queue.take(registered) };
          });
        const owned = yield* start("thread-a");
        const sameDirectory = yield* start("thread-b");
        const unowned = yield* start();

        expect(owned.entry.root).toEqual({
          pid: FIRST_PID,
          cgroup: "/agents/t3-opencode.scope",
          owner: { type: "thread", threadId: "thread-a" },
        });
        expect(sameDirectory.entry.root.owner).toEqual({ type: "thread", threadId: "thread-b" });
        expect(unowned.entry.root.owner).toEqual({
          type: "shared",
          provider: "opencode",
          label: "serve",
        });
        expect(unowned.entry.root.threads).toBeUndefined();
        expect(unowned.entry.root.splitByEnv).toBeUndefined();

        yield* closeServe(owned);
        expect(owned.entry.releases).toBe(1);
        expect(sameDirectory.entry.releases).toBe(0);
        yield* closeServe(sameDirectory);
        yield* closeServe(unowned);
        expect(unowned.entry.releases).toBe(1);
      }),
    ),
  );

  effectIt.effect("attributes nothing to an external server", () =>
    withRuntime((runtime, registered) =>
      Effect.gen(function* () {
        yield* runtime
          .connectToOpenCodeServer({
            binaryPath: "opencode",
            directory: "/work/app",
            serverUrl: "http://127.0.0.1:1",
            threadId: "thread-a",
          })
          .pipe(Effect.scoped, Effect.exit);
        expect(yield* Queue.size(registered)).toBe(0);
      }),
    ),
  );
});
