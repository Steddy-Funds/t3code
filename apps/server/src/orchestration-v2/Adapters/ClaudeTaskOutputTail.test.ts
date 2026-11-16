import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import {
  claudeTaskOutputProjectFolder,
  claudeTaskOutputRoot,
  tailClaudeTaskOutput,
} from "./ClaudeTaskOutputTail.ts";

const SESSION_ID = "0c91bb28-9e89-4889-bd22-3de9880233d3";
const TASK_ID = "bk6xreeye";
const PROJECT_FOLDER = "-private-tmp-project";

const makeTaskFile = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-task-output-" });
  const tasks = path.join(root, PROJECT_FOLDER, SESSION_ID, "tasks");
  return { root, tasks, file: path.join(tasks, `${TASK_ID}.output`) };
});

// TestClock cannot interleave with real filesystem I/O; tests that wait on a poll use the live clock.
describe("tailClaudeTaskOutput", () => {
  it.live("follows a file that appears after the task starts, across split characters", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        const chunks = yield* Queue.unbounded<string>();
        yield* tailClaudeTaskOutput({
          root,
          projectFolder: PROJECT_FOLDER,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop: yield* Deferred.make<void>(),
          onChunk: (chunk) => Queue.offer(chunks, chunk),
        }).pipe(Effect.forkScoped);

        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        // Split the two-byte é across writes.
        const encoded = new TextEncoder().encode("café 1\n");
        yield* fileSystem.writeFile(file, encoded.subarray(0, 4));
        assert.equal(yield* Queue.take(chunks), "caf");

        yield* fileSystem.writeFile(file, encoded);
        assert.equal(yield* Queue.take(chunks), "é 1\n");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("drops a split character when the file is truncated and rewritten", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        // End the first read inside the two-byte é.
        yield* fileSystem.writeFile(file, new TextEncoder().encode("café").subarray(0, 4));
        const chunks = yield* Queue.unbounded<string>();
        const stop = yield* Deferred.make<void>();
        yield* tailClaudeTaskOutput({
          root,
          projectFolder: PROJECT_FOLDER,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop,
          onChunk: (chunk) => Queue.offer(chunks, chunk),
        }).pipe(Effect.forkScoped);
        assert.equal(yield* Queue.take(chunks), "caf");

        yield* fileSystem.writeFileString(file, "ok\n");
        yield* Deferred.succeed(stop, undefined);
        assert.equal(yield* Queue.take(chunks), "ok\n");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("skips ahead when the command writes faster than it is read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        yield* fileSystem.writeFileString(file, "start\n");
        const chunks = yield* Queue.unbounded<string>();
        yield* tailClaudeTaskOutput({
          root,
          projectFolder: PROJECT_FOLDER,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop: yield* Deferred.make<void>(),
          onChunk: (chunk) => Queue.offer(chunks, chunk),
        }).pipe(Effect.forkScoped);
        assert.equal(yield* Queue.take(chunks), "start\n");

        yield* fileSystem.writeFileString(file, `start\n${"y\n".repeat(1_000_000)}end\n`);
        const flooded = yield* Queue.take(chunks);
        assert.isAtMost(flooded.length, 256 * 1024 + 1);
        assert.isTrue(flooded.startsWith("\n"));
        assert.isTrue(flooded.endsWith("y\nend\n"));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reads what was written last when the tool result stops it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, tasks, file } = yield* makeTaskFile;
        yield* fileSystem.makeDirectory(tasks, { recursive: true });
        yield* fileSystem.writeFileString(file, "one\n");
        const chunks: Array<string> = [];
        const stop = yield* Deferred.make<void>();
        const first = yield* Deferred.make<void>();
        const fiber = yield* tailClaudeTaskOutput({
          root,
          projectFolder: PROJECT_FOLDER,
          sessionId: SESSION_ID,
          taskId: TASK_ID,
          stop,
          onChunk: (chunk) =>
            Effect.sync(() => chunks.push(chunk)).pipe(
              Effect.andThen(Deferred.succeed(first, undefined)),
            ),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(first);
        yield* fileSystem.writeFileString(file, "one\ntwo\n");
        yield* Deferred.succeed(stop, undefined);
        yield* Fiber.join(fiber);
        assert.deepEqual(chunks, ["one\n", "two\n"]);
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});

// A host that has run Claude in thousands of checkouts: every folder checked is a filesystem call.
describe("tailClaudeTaskOutput on a host with many project folders", () => {
  const ROOT = "/tmp/claude-1001";
  const OTHER_FOLDERS = Array.from({ length: 5_000 }, (_, index) => `-other-project-${index}`);
  const OWN_SESSION = `${ROOT}/${PROJECT_FOLDER}/${SESSION_ID}`;

  const makeHost = (exists: (target: string, checked: number) => Effect.Effect<boolean>) => {
    const calls = { exists: 0, readDirectory: 0 };
    const layer = Layer.merge(
      Path.layer,
      FileSystem.layerNoop({
        exists: (target) => {
          calls.exists += 1;
          return exists(target, calls.exists);
        },
        readDirectory: () => {
          calls.readDirectory += 1;
          return Effect.succeed(OTHER_FOLDERS);
        },
      }),
    );
    return { calls, layer };
  };
  const tail = (stop: Deferred.Deferred<void>) =>
    tailClaudeTaskOutput({
      root: ROOT,
      projectFolder: PROJECT_FOLDER,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
      stop,
      onChunk: () => Effect.void,
    });

  it.effect("looks only in the session's own folder when it is there", () =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<void>();
      const host = makeHost((target, checked) =>
        // The session folder exists; the task's file never does, and the second poll stops the tail.
        checked === 3
          ? Deferred.succeed(stop, undefined).pipe(Effect.as(false))
          : Effect.succeed(target === OWN_SESSION),
      );
      const fiber = yield* tail(stop).pipe(Effect.provide(host.layer), Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      assert.deepEqual(host.calls, { exists: 3, readDirectory: 0 });
    }),
  );

  it.effect("stops searching the other folders once the tool result stops it", () =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<void>();
      // Each check settles on a later tick, as a real filesystem call does.
      const host = makeHost((_target, checked) =>
        Effect.promise(() => Promise.resolve(false)).pipe(
          Effect.tap(() => (checked === 3 ? Deferred.succeed(stop, undefined) : Effect.void)),
        ),
      );
      yield* tail(stop).pipe(Effect.provide(host.layer));
      assert.isAtMost(host.calls.exists, 4);
    }),
  );

  it.effect("searches a bounded number of folders, once, when the session is not found", () =>
    Effect.gen(function* () {
      const host = makeHost(() => Effect.succeed(false));
      const fiber = yield* tail(yield* Deferred.make<void>()).pipe(
        Effect.provide(host.layer),
        Effect.forkChild,
      );
      yield* TestClock.adjust("11 seconds");
      yield* Fiber.join(fiber);
      // Its own folder, 500 others, then 40 polls for the task's file.
      assert.deepEqual(host.calls, { exists: 541, readDirectory: 1 });
    }),
  );
});

describe("claudeTaskOutputRoot", () => {
  it("names a session's folder as Claude Code does", () => {
    assert.equal(
      claudeTaskOutputProjectFolder("/home/dev/.t3/worktrees/steddyfunds.ai/pod_1"),
      "-home-dev--t3-worktrees-steddyfunds-ai-pod-1",
    );
    assert.isUndefined(claudeTaskOutputProjectFolder(null));
  });

  it.effect.skipIf(process.getuid === undefined)(
    "uses the temp dir Claude Code resolves from its environment on each platform",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const user = `claude-${process.getuid?.()}`;
        const root = (
          environment: Record<string, string>,
          platform: NodeJS.Platform,
          cwd: string | null = null,
        ) => claudeTaskOutputRoot(environment, path, cwd, platform);
        assert.equal(root({ TMPDIR: "/var/folders/x/T/" }, "linux"), `/var/folders/x/T/${user}`);
        assert.equal(root({ TMP: "/tmp/user/1000" }, "linux"), `/tmp/user/1000/${user}`);
        assert.equal(root({}, "linux"), `/tmp/${user}`);
        assert.equal(root({ TMPDIR: "/var/folders/x/T/" }, "darwin"), `/tmp/${user}`);
        assert.equal(
          root({ CLAUDE_CODE_TMPDIR: "/srv/claude", TMPDIR: "/var/folders/x/T/" }, "linux"),
          `/srv/claude/${user}`,
        );
        assert.equal(
          root({ CLAUDE_CODE_TMPDIR: "/srv/claude", TMPDIR: "/var/folders/x/T/" }, "darwin"),
          `/srv/claude/${user}`,
        );
        assert.equal(
          root({ TMPDIR: "tmp" }, "linux", "/work/project"),
          `/work/project/tmp/${user}`,
        );
        assert.equal(
          root({ CLAUDE_CODE_TMPDIR: "../claude" }, "darwin", "/work/project"),
          `/work/claude/${user}`,
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
