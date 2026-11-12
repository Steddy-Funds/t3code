import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointRef,
  CheckpointScopeId,
  OrchestrationGetTurnDiffFileContentsError,
  RunId,
  ThreadId,
  TurnDiffFileContentsUnavailableReason,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import type { ProjectionCheckpointContext } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { VcsCheckpointFile, VcsReadCheckpointFileInput } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import {
  CheckpointFileContentsUnavailableError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
} from "./Errors.ts";

const threadId = ThreadId.make("thread:checkpoint-diff-v2");
const firstRunId = RunId.make("run:checkpoint-diff-v2:1");
const secondRunId = RunId.make("run:checkpoint-diff-v2:2");
const firstScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:1");
const secondScopeId = CheckpointScopeId.make("scope:checkpoint-diff-v2:2");
const secondRef = CheckpointRef.make("refs/t3/test/second");

function makeProjection(): ProjectionCheckpointContext {
  return {
    runs: [
      { id: firstRunId, ordinal: 1, status: "completed" },
      { id: secondRunId, ordinal: 2, status: "completed" },
    ],
    checkpointScopes: [
      { id: firstScopeId, runId: firstRunId, kind: "root_run", cwd: "/repo" },
      { id: secondScopeId, runId: secondRunId, kind: "root_run", cwd: "/repo" },
    ],
    checkpoints: [
      {
        scopeId: secondScopeId,
        runId: secondRunId,
        ordinalWithinScope: 1,
        appRunOrdinal: 2,
        status: "ready",
        ref: secondRef,
      },
    ],
  };
}

function layerFor(input: {
  readonly projection: Effect.Effect<ProjectionCheckpointContext, OrchestratorProjectionError>;
  readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
  readonly authoredPaths?: ReadonlySet<string>;
  readonly readCheckpointFile?: CheckpointStore.CheckpointStore["Service"]["readCheckpointFile"];
}) {
  return CheckpointDiffQuery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () => input.projection,
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          diffCheckpoints: input.diffCheckpoints ?? (() => Effect.succeed("diff")),
          listAuthoredPaths: () => Effect.succeed(input.authoredPaths ?? null),
          ...(input.readCheckpointFile === undefined
            ? {}
            : { readCheckpointFile: input.readCheckpointFile }),
        }),
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );
}

it.effect("excludes ready checkpoints from rolled-back runs", () => {
  const projection = makeProjection();
  const layer = layerFor({
    projection: Effect.succeed({
      ...projection,
      runs: projection.runs.map((run) =>
        run.id === secondRunId ? { ...run, status: "rolled_back" as const } : run,
      ),
      checkpoints: [
        {
          ...projection.checkpoints[0]!,
          scopeId: firstScopeId,
          runId: firstRunId,
          appRunOrdinal: 1,
          ref: CheckpointRef.make("refs/t3/test/first"),
        },
        ...projection.checkpoints,
      ],
    }),
  });

  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 })
      .pipe(Effect.flip);

    assert.instanceOf(error, CheckpointTurnRangeUnavailableError);
    assert.deepEqual(
      {
        requestedTurnCount: error.requestedTurnCount,
        availableTurnCount: error.availableTurnCount,
      },
      { requestedTurnCount: 2, availableTurnCount: 1 },
    );
  }).pipe(Effect.provide(layer));
});

function makeProjectionAfterStoppedRun(stoppedRunCheckpoint: boolean) {
  const thirdRunId = RunId.make("run:checkpoint-diff-v2:3");
  const checkpoint = (
    ordinalWithinScope: number,
    runId: RunId | null,
  ): ProjectionCheckpointContext["checkpoints"][number] => ({
    scopeId: firstScopeId,
    runId,
    ordinalWithinScope,
    appRunOrdinal: runId === null ? null : ordinalWithinScope,
    status: "ready",
    ref: CheckpointRef.make(`refs/t3/test/ordinal/${ordinalWithinScope}`),
  });
  return {
    runs: [
      { id: firstRunId, ordinal: 1, status: "completed" },
      { id: secondRunId, ordinal: 2, status: "interrupted" },
      { id: thirdRunId, ordinal: 3, status: "completed" },
    ],
    checkpointScopes: [
      { id: firstScopeId, runId: thirdRunId, kind: "root_run", cwd: "/repo" },
      { id: secondScopeId, runId: secondRunId, kind: "tool", cwd: "/repo" },
    ],
    checkpoints: [
      {
        ...checkpoint(2, null),
        scopeId: secondScopeId,
        ref: CheckpointRef.make("refs/t3/test/tool/2"),
      },
      checkpoint(0, null),
      checkpoint(1, firstRunId),
      checkpoint(2, stoppedRunCheckpoint ? secondRunId : null),
      checkpoint(3, thirdRunId),
    ],
  } satisfies ProjectionCheckpointContext;
}

it.effect.each([false, true])(
  "diffs the turn after a stopped run from its parent checkpoint (stopped run captured: %s)",
  (stoppedRunCheckpoint) => {
    const diffCheckpoints = vi.fn((_input: CheckpointStore.DiffCheckpointsInput) =>
      Effect.succeed("diff --git a/file b/file"),
    );
    const layer = layerFor({
      projection: Effect.succeed(makeProjectionAfterStoppedRun(stoppedRunCheckpoint)),
      diffCheckpoints,
    });

    return Effect.gen(function* () {
      const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const result = yield* query.getTurnDiff({ threadId, fromTurnCount: 2, toTurnCount: 3 });

      assert.strictEqual(result.diff, "diff --git a/file b/file");
      yield* query.getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 3 });
      yield* query.getFullThreadDiff({ threadId, toTurnCount: 3 });
      assert.deepEqual(
        diffCheckpoints.mock.calls.map(([input]) => ({
          from: input.fromCheckpointRef,
          to: input.toCheckpointRef,
        })),
        [
          { from: "refs/t3/test/ordinal/2", to: "refs/t3/test/ordinal/3" },
          { from: "refs/t3/test/ordinal/1", to: "refs/t3/test/ordinal/3" },
          {
            from: yield* checkpointRefForScopeOrdinal({
              scopeId: firstScopeId,
              ordinalWithinScope: 0,
            }),
            to: "refs/t3/test/ordinal/3",
          },
        ],
      );
      const stoppedTurnError = yield* query
        .getTurnDiff({ threadId, fromTurnCount: 1, toTurnCount: 2 })
        .pipe(Effect.flip);
      assert.instanceOf(stoppedTurnError, CheckpointRefUnavailableError);
      assert.deepEqual(
        { checkpoint: stoppedTurnError.checkpoint, turnCount: stoppedTurnError.turnCount },
        { checkpoint: "to", turnCount: 2 },
      );
    }).pipe(Effect.provide(layer));
  },
);

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerStore = CheckpointStore.layer.pipe(
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
  Layer.provide(NodeServices.layer),
);
const layerTest = Layer.merge(layerStore, layerVcsProcess).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

it.effect("shares the turn and full-thread diff budget across real Git batches", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const process = yield* VcsProcess.VcsProcess;
    const store = yield* CheckpointStore.CheckpointStore;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-diff-aggregate-" });
    const git = (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
      process.run({
        operation: "CheckpointDiffQuery.test.git",
        command: "git",
        cwd,
        args,
        ...(env === undefined ? {} : { env }),
      });
    yield* git(["init"]);
    yield* git(["config", "user.email", "test@test.com"]);
    yield* git(["config", "user.name", "Test"]);
    yield* fs.writeFileString(path.join(cwd, "README.md"), "initial\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "initial"]);

    const threadId = ThreadId.make("thread:aggregate-runtime");
    const runId = RunId.make("run:aggregate-runtime");
    const scopeId = CheckpointScopeId.make("scope:aggregate-runtime");
    const fromCheckpointRef = yield* checkpointRefForScopeOrdinal({
      scopeId,
      ordinalWithinScope: 0,
    });
    const toCheckpointRef = CheckpointRef.make("refs/t3/test/aggregate-after");
    yield* store.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });
    // The old commit models files imported by a pull after the baseline was captured.
    yield* fs.writeFileString(path.join(cwd, "upstream.ts"), "imported\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "imported"], {
      ...globalThis.process.env,
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    });
    const ownPaths = Array.from({ length: 1_600 }, (_, index) => `src/module-${index}/file.ts`);
    yield* Effect.forEach(
      ownPaths,
      (file) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(path.join(cwd, file)), { recursive: true });
          yield* fs.writeFileString(path.join(cwd, file), `${"x".repeat(12_000)}\n`);
        }),
      { concurrency: 16, discard: true },
    );
    yield* store.captureCheckpoint({ cwd, checkpointRef: toCheckpointRef });

    const patchSizes: number[] = [];
    const query = yield* CheckpointDiffQuery.make.pipe(
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [{ id: runId, ordinal: 1, status: "completed" }],
              checkpointScopes: [{ id: scopeId, runId, kind: "root_run", cwd }],
              checkpoints: [
                {
                  scopeId,
                  runId,
                  ordinalWithinScope: 1,
                  appRunOrdinal: 1,
                  status: "ready",
                  ref: toCheckpointRef,
                },
              ],
            }),
        }),
      ),
      Effect.provideService(CheckpointStore.CheckpointStore, {
        ...store,
        diffCheckpoints: (input) =>
          store.diffCheckpoints(input).pipe(
            Effect.tap((patch) =>
              Effect.sync(() => {
                if (input.format !== "numstat") {
                  patchSizes.push(Buffer.byteLength(patch));
                }
              }),
            ),
          ),
      }),
    );
    const turn = yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 1 });
    const turnPatchSizes = patchSizes.splice(0);
    const fullThread = yield* query.getFullThreadDiff({ threadId, toTurnCount: 1 });
    assert.isTrue(fullThread.diff === turn.diff);
    assert.isAtMost(Buffer.byteLength(turn.diff), 10_000_000);
    assert.isTrue(turn.diff.endsWith("\n\n[truncated]"));
    assert.include(turn.diff, "src/module-0/file.ts");
    assert.notInclude(turn.diff, "upstream.ts");
    assert.lengthOf(turnPatchSizes, 2);
    assert.deepEqual(patchSizes, turnPatchSizes);
    assert.isBelow(turnPatchSizes[0]!, 10_000_000);
    assert.strictEqual(
      turnPatchSizes.reduce((sum, size) => sum + size, 0),
      10_000_001,
    );
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("truncates a storage-cut UTF-8 character without replacement text", () => {
  const prefix = "x".repeat(9_999_985);
  const layer = layerFor({
    projection: Effect.succeed(makeProjection()),
    diffCheckpoints: (input) =>
      Effect.succeed(
        Buffer.from(`${prefix}😀${"x".repeat(9)}😀tail`)
          .subarray(0, input.maxOutputBytes)
          .toString("utf8"),
      ),
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getTurnDiff({ threadId, fromTurnCount: 0, toTurnCount: 2 });
    assert.isAtMost(Buffer.byteLength(result.diff), 10_000_000);
    assert.isTrue(result.diff === `${prefix}\n\n[truncated]`);
  }).pipe(Effect.provide(layer));
});

it.effect("preserves an exact-fit filtered patch across batches without a marker", () => {
  const ownPaths = Array.from({ length: 1_000 }, (_, index) => `src/module-${index}/file.ts`);
  const patches = ["é".repeat(3_000_000), "x".repeat(4_000_000)];
  let patchReads = 0;
  const layer = layerFor({
    projection: Effect.succeed(makeProjection()),
    authoredPaths: new Set(ownPaths),
    diffCheckpoints: (input) =>
      Effect.sync(() =>
        input.format === "numstat"
          ? [...ownPaths, "upstream.ts"].map((path) => `1\t0\t${path}\0`).join("")
          : patches[patchReads++]!,
      ),
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getFullThreadDiff({ threadId, toTurnCount: 2 });
    assert.isTrue(result.diff === patches.join(""));
    assert.strictEqual(patchReads, 2);
  }).pipe(Effect.provide(layer));
});

const fileContentsRequest = (path: string, previousPath?: string) => ({
  threadId,
  fromTurnCount: 0,
  toTurnCount: 2,
  path,
  ...(previousPath === undefined ? {} : { previousPath }),
});

const text = (contents: string): VcsCheckpointFile => ({ kind: "text", contents });

/** What `git diff --numstat -z` prints: a rename is `counts<TAB>NUL old NUL new NUL`. */
const numstatOf = (...files: ReadonlyArray<{ path: string; previousPath?: string }>) =>
  files
    .map((file) =>
      file.previousPath === undefined
        ? `1\t0\t${file.path}\0`
        : `1\t1\t\0${file.previousPath}\0${file.path}\0`,
    )
    .join("");

function fileContentsFixture(input: {
  readonly numstat: string;
  readonly from?: Readonly<Record<string, VcsCheckpointFile>>;
  readonly to?: Readonly<Record<string, VcsCheckpointFile>>;
  readonly authoredPaths?: ReadonlySet<string>;
  readonly projection?: ProjectionCheckpointContext;
  readonly diffCheckpoints?: CheckpointStore.CheckpointStore["Service"]["diffCheckpoints"];
  readonly readCheckpointFile?: CheckpointStore.CheckpointStore["Service"]["readCheckpointFile"];
}) {
  const diffCheckpoints = vi.fn(
    input.diffCheckpoints ??
      ((_input: CheckpointStore.DiffCheckpointsInput) => Effect.succeed(input.numstat)),
  );
  const readCheckpointFile = vi.fn(
    input.readCheckpointFile ??
      ((read: VcsReadCheckpointFileInput) =>
        Effect.succeed<VcsCheckpointFile>(
          (read.checkpointRef === secondRef ? input.to : input.from)?.[read.path] ?? {
            kind: "missing",
          },
        )),
  );
  const layer = layerFor({
    projection: Effect.succeed(input.projection ?? makeProjection()),
    diffCheckpoints,
    readCheckpointFile,
    ...(input.authoredPaths === undefined ? {} : { authoredPaths: input.authoredPaths }),
  });
  /** `from:path` / `to:path`, sorted: the two sides are read concurrently. */
  const reads = () =>
    readCheckpointFile.mock.calls
      .map(([read]) => `${read.checkpointRef === secondRef ? "to" : "from"}:${read.path}`)
      .toSorted();
  return { layer, diffCheckpoints, readCheckpointFile, reads };
}

function assertRefused(
  error: unknown,
  reason: TurnDiffFileContentsUnavailableReason,
  path = "src/a.ts",
) {
  assert.instanceOf(error, CheckpointFileContentsUnavailableError);
  assert.deepEqual(
    { threadId: error.threadId, path: error.path, reason: error.reason },
    { threadId, path, reason },
  );
}

it.effect.each([
  {
    name: "a changed file",
    files: [{ path: "src/a.ts" }],
    from: { "src/a.ts": text("old\n") },
    to: { "src/a.ts": text("new\n") },
    request: fileContentsRequest("src/a.ts"),
    expected: { oldContents: "old\n", newContents: "new\n" },
    reads: ["from:src/a.ts", "to:src/a.ts"],
  },
  {
    name: "a renamed file",
    files: [{ path: "src/b.ts", previousPath: "src/a.ts" }],
    from: { "src/a.ts": text("old\n"), "src/b.ts": text("not this\n") },
    to: { "src/b.ts": text("new\n"), "src/a.ts": text("nor this\n") },
    request: fileContentsRequest("src/b.ts", "src/a.ts"),
    expected: { oldContents: "old\n", newContents: "new\n" },
    reads: ["from:src/a.ts", "to:src/b.ts"],
  },
  {
    name: "an added file",
    files: [{ path: "src/a.ts" }],
    from: {},
    to: { "src/a.ts": text("new\n") },
    request: fileContentsRequest("src/a.ts"),
    expected: { oldContents: "", newContents: "new\n" },
    reads: ["from:src/a.ts", "to:src/a.ts"],
  },
  {
    name: "a deleted file",
    files: [{ path: "src/a.ts" }],
    from: { "src/a.ts": text("old\n") },
    to: {},
    request: fileContentsRequest("src/a.ts"),
    expected: { oldContents: "old\n", newContents: "" },
    reads: ["from:src/a.ts", "to:src/a.ts"],
  },
])("reads both sides of $name from the range's refs", (row) => {
  const fixture = fileContentsFixture({ numstat: numstatOf(...row.files), ...row });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getTurnDiffFileContents(row.request);

    assert.deepEqual(result, row.expected);
    assert.deepEqual(fixture.reads(), row.reads);
    // Whitespace-only changes are files of the diff too, so the listing must not ignore them.
    assert.lengthOf(fixture.diffCheckpoints.mock.calls, 1);
    const [listing] = fixture.diffCheckpoints.mock.calls[0]!;
    assert.deepEqual(
      {
        cwd: listing.cwd,
        to: listing.toCheckpointRef,
        format: listing.format,
        filePaths: listing.filePaths,
        ignoreWhitespace: listing.ignoreWhitespace,
        fallbackFromToHead: listing.fallbackFromToHead,
      },
      {
        cwd: "/repo",
        to: secondRef,
        format: "numstat",
        // The whole range, never a path-limited listing.
        filePaths: undefined,
        ignoreWhitespace: false,
        fallbackFromToHead: false,
      },
    );
    assert.strictEqual(
      listing.fromCheckpointRef,
      yield* checkpointRefForScopeOrdinal({ scopeId: firstScopeId, ordinalWithinScope: 0 }),
    );
    assert.isTrue(
      fixture.readCheckpointFile.mock.calls.every(([read]) => read.maxBytes === 1_048_576),
    );
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("reads the turn after a stopped run from its parent checkpoint", () => {
  const fixture = fileContentsFixture({
    numstat: numstatOf({ path: "src/a.ts" }),
    projection: makeProjectionAfterStoppedRun(false),
    from: { "src/a.ts": text("old\n") },
    to: { "src/a.ts": text("new\n") },
    // The refs differ from makeProjection's, so key the sides by the ref read.
    readCheckpointFile: (read) =>
      Effect.succeed<VcsCheckpointFile>(text(`${read.checkpointRef}|${read.cwd}|${read.path}`)),
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const result = yield* query.getTurnDiffFileContents({
      ...fileContentsRequest("src/a.ts"),
      fromTurnCount: 2,
      toTurnCount: 3,
    });
    assert.deepEqual(result, {
      oldContents: "refs/t3/test/ordinal/2|/repo|src/a.ts",
      newContents: "refs/t3/test/ordinal/3|/repo|src/a.ts",
    });
  }).pipe(Effect.provide(fixture.layer));
});

it.effect.each([
  {
    name: "a path the range did not change",
    numstat: "",
    request: fileContentsRequest("src/a.ts"),
  },
  {
    name: "a path whose listing names only another file",
    numstat: numstatOf({ path: "src/other.ts" }),
    request: fileContentsRequest("src/a.ts"),
  },
  {
    name: "a previousPath that is not the file's rename source",
    numstat: numstatOf({ path: "src/b.ts", previousPath: "src/a.ts" }),
    request: fileContentsRequest("src/b.ts", "src/elsewhere.ts"),
    path: "src/b.ts",
  },
  {
    name: "a previousPath for a file that was not renamed",
    numstat: numstatOf({ path: "src/a.ts" }),
    request: fileContentsRequest("src/a.ts", "src/old.ts"),
  },
  {
    name: "a file a git import brought in",
    numstat: numstatOf({ path: "src/a.ts" }),
    authoredPaths: new Set(["src/other.ts"]),
    request: fileContentsRequest("src/a.ts"),
  },
  {
    name: "a renamed file where a git import brought in both paths",
    numstat: numstatOf({ path: "src/b.ts", previousPath: "src/a.ts" }),
    authoredPaths: new Set(["src/other.ts"]),
    request: fileContentsRequest("src/b.ts", "src/a.ts"),
    path: "src/b.ts",
  },
])("refuses $name as not in the diff, though both checkpoints hold it", (row) => {
  const everything = {
    "src/a.ts": text("exists\n"),
    "src/b.ts": text("exists\n"),
    "src/other.ts": text("exists\n"),
  };
  const fixture = fileContentsFixture({ ...row, from: everything, to: everything });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query.getTurnDiffFileContents(row.request).pipe(Effect.flip);

    assertRefused(error, "not_in_diff", row.path);
    assert.deepEqual(fixture.reads(), []);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect.each([
  {
    name: "the new path was authored",
    authoredPaths: new Set(["src/b.ts"]),
  },
  {
    name: "only the rename source was authored",
    authoredPaths: new Set(["src/a.ts"]),
  },
])("keeps a renamed file when $name", ({ authoredPaths }) => {
  const fixture = fileContentsFixture({
    numstat: numstatOf({ path: "src/b.ts", previousPath: "src/a.ts" }),
    authoredPaths,
    from: { "src/a.ts": text("old\n") },
    to: { "src/b.ts": text("new\n") },
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    assert.deepEqual(
      yield* query.getTurnDiffFileContents(fileContentsRequest("src/b.ts", "src/a.ts")),
      { oldContents: "old\n", newContents: "new\n" },
    );
  }).pipe(Effect.provide(fixture.layer));
});

it.effect("refuses an empty range without reading the thread or the store", () => {
  const getCheckpointContext = vi.fn(() => Effect.die("an empty range must not load the thread"));
  const fixture = fileContentsFixture({ numstat: numstatOf({ path: "src/a.ts" }) });
  const layer = CheckpointDiffQuery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({ getCheckpointContext }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          diffCheckpoints: fixture.diffCheckpoints,
          listAuthoredPaths: () => Effect.succeed(null),
          readCheckpointFile: fixture.readCheckpointFile,
        }),
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    for (const turnCount of [0, 2]) {
      const error = yield* query
        .getTurnDiffFileContents({
          ...fileContentsRequest("src/a.ts"),
          fromTurnCount: turnCount,
          toTurnCount: turnCount,
        })
        .pipe(Effect.flip);
      assertRefused(error, "not_in_diff");
    }
    assert.lengthOf(getCheckpointContext.mock.calls, 0);
    assert.lengthOf(fixture.diffCheckpoints.mock.calls, 0);
    assert.lengthOf(fixture.readCheckpointFile.mock.calls, 0);
  }).pipe(Effect.provide(layer));
});

it.effect.each(
  (["too_large", "binary", "not_a_file"] as const).flatMap((kind) =>
    (["from", "to"] as const).map((side) => ({
      kind,
      side,
      reason: kind === "not_a_file" ? ("unavailable" as const) : kind,
    })),
  ),
)("refuses a file whose $side side is $kind as $reason", ({ kind, side, reason }) => {
  const fixture = fileContentsFixture({
    numstat: numstatOf({ path: "src/a.ts" }),
    from: { "src/a.ts": side === "from" ? { kind } : text("fine\n") },
    to: { "src/a.ts": side === "to" ? { kind } : text("fine\n") },
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiffFileContents(fileContentsRequest("src/a.ts"))
      .pipe(Effect.flip);
    assertRefused(error, reason);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect.each([
  {
    name: "an unknown thread",
    projection: Effect.fail(new OrchestratorProjectionError({ threadId })),
    from: 0,
    to: 2,
  },
  { name: "a range past the last completed turn", from: 0, to: 3 },
  {
    name: "a turn whose checkpoint was never captured",
    projection: Effect.succeed(makeProjectionAfterStoppedRun(false)),
    from: 1,
    to: 2,
  },
  { name: "a missing from checkpoint", from: 1, to: 2 },
])("fails $name exactly as the turn diff does", ({ projection, from, to }) => {
  const fixture = fileContentsFixture({ numstat: numstatOf({ path: "src/a.ts" }) });
  const layer = layerFor({
    projection: projection ?? Effect.succeed(makeProjection()),
    diffCheckpoints: fixture.diffCheckpoints,
    readCheckpointFile: fixture.readCheckpointFile,
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const range = { threadId, fromTurnCount: from, toTurnCount: to };
    const diffError = yield* query.getTurnDiff(range).pipe(Effect.flip);
    const contentsError = yield* query
      .getTurnDiffFileContents({ ...range, path: "src/a.ts" })
      .pipe(Effect.flip);

    assert.notInstanceOf(contentsError, CheckpointFileContentsUnavailableError);
    assert.strictEqual(contentsError._tag, diffError._tag);
    assert.strictEqual(
      contentsError.message.replaceAll("getTurnDiffFileContents", "getTurnDiff"),
      diffError.message,
    );
    if ("operation" in contentsError) {
      assert.strictEqual(contentsError.operation, "CheckpointDiffQuery.getTurnDiffFileContents");
    }
    assert.lengthOf(fixture.diffCheckpoints.mock.calls, 0);
    assert.lengthOf(fixture.readCheckpointFile.mock.calls, 0);
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  { name: "listing the range", failing: "diffCheckpoints" },
  { name: "reading a side", failing: "readCheckpointFile" },
])("passes a store failure while $name through as that failure", ({ failing }) => {
  const failure = new VcsProcessExitError({
    operation: "test",
    command: "git",
    cwd: "/repo",
    exitCode: 128,
    detail: "boom",
  });
  const fixture = fileContentsFixture({
    numstat: numstatOf({ path: "src/a.ts" }),
    ...(failing === "diffCheckpoints"
      ? { diffCheckpoints: () => Effect.fail(failure) }
      : { readCheckpointFile: () => Effect.fail(failure) }),
  });
  return Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    const error = yield* query
      .getTurnDiffFileContents(fileContentsRequest("src/a.ts"))
      .pipe(Effect.flip);
    assert.strictEqual(error, failure);
  }).pipe(Effect.provide(fixture.layer));
});

it.effect.each(TurnDiffFileContentsUnavailableReason.literals)(
  "keeps the reason and message of a %s refusal over the wire",
  (reason) => {
    const refusal = new CheckpointFileContentsUnavailableError({
      threadId,
      path: "src/a.ts",
      reason,
    });
    const mapped = CheckpointDiffQuery.turnDiffFileContentsRpcError(refusal);
    assert.instanceOf(mapped, OrchestrationGetTurnDiffFileContentsError);
    assert.deepEqual(
      { reason: mapped.reason, message: mapped.message, cause: mapped.cause },
      { reason, message: refusal.message, cause: undefined },
    );
    return Effect.void;
  },
);

it.effect.each([
  new CheckpointThreadNotFoundError({
    operation: "CheckpointDiffQuery.getTurnDiffFileContents",
    threadId,
  }),
  new VcsProcessExitError({
    operation: "test",
    command: "git",
    cwd: "/secret/worktree",
    exitCode: 128,
    detail: "fatal: bad object",
  }),
])("reports $_tag as unavailable without its message", (failure) => {
  const mapped = CheckpointDiffQuery.turnDiffFileContentsRpcError(failure);
  assert.instanceOf(mapped, OrchestrationGetTurnDiffFileContentsError);
  assert.deepEqual(
    { reason: mapped.reason, message: mapped.message, cause: mapped.cause },
    { reason: "unavailable", message: "Failed to load turn diff file contents", cause: failure },
  );
  return Effect.void;
});

it.effect("reads whole files of a real turn range from its checkpoints", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const process = yield* VcsProcess.VcsProcess;
    const store = yield* CheckpointStore.CheckpointStore;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-diff-contents-" });
    const git = (args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
      process.run({
        operation: "CheckpointDiffQuery.test.git",
        command: "git",
        cwd,
        args,
        ...(env === undefined ? {} : { env }),
      });
    const write = (file: string, contents: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(path.join(cwd, file)), { recursive: true });
        yield* fs.writeFileString(path.join(cwd, file), contents);
      });
    yield* git(["init"]);
    yield* git(["config", "user.email", "test@test.com"]);
    yield* git(["config", "user.name", "Test"]);
    yield* write("README.md", "initial\n");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "initial"]);

    const runId = RunId.make("run:contents-runtime");
    const scopeId = CheckpointScopeId.make("scope:contents-runtime");
    const fromCheckpointRef = yield* checkpointRefForScopeOrdinal({
      scopeId,
      ordinalWithinScope: 0,
    });
    const toCheckpointRef = CheckpointRef.make("refs/t3/test/contents-after");
    const renameBody = Array.from({ length: 8 }, (_, index) => `kept line ${index}\n`).join("");
    yield* write("changed.txt", "one\ntwo\nthree\n");
    yield* write("deleted.txt", "gone\n");
    yield* write("unchanged.txt", "same\n");
    yield* write("whitespace.txt", "a b\n");
    yield* write("old name.txt", `${renameBody}before\n`);
    yield* write("binary.bin", "\0before");
    yield* write("big.txt", "small\n");
    // Two near-twins renamed apart: a path-limited diff would pair them the other way.
    const twinBody = Array.from({ length: 12 }, (_, index) => `twin line ${index}\n`).join("");
    yield* write("twin a.txt", `${twinBody}a\n`);
    yield* write("twin c.txt", `${twinBody}c\n`);
    yield* store.captureCheckpoint({ cwd, checkpointRef: fromCheckpointRef });

    // The old commit models a file a pull brought in after the baseline was captured.
    yield* write("upstream.ts", "imported\n");
    yield* git(["add", "upstream.ts"]);
    yield* git(["commit", "-m", "imported"], {
      ...globalThis.process.env,
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    });
    yield* write("changed.txt", "one\n2 é\nthree\n");
    yield* fs.remove(path.join(cwd, "deleted.txt"));
    yield* write("whitespace.txt", "a  b\n");
    yield* write("added.txt", "added\n");
    yield* fs.remove(path.join(cwd, "old name.txt"));
    yield* write("moved/new name.txt", `${renameBody}after\n`);
    yield* write("binary.bin", "\0after");
    yield* write("big.txt", "y".repeat(1_048_577));
    yield* fs.rename(path.join(cwd, "twin a.txt"), path.join(cwd, "twin b.txt"));
    yield* fs.rename(path.join(cwd, "twin c.txt"), path.join(cwd, "twin d.txt"));
    yield* store.captureCheckpoint({ cwd, checkpointRef: toCheckpointRef });
    // The checkpoint's text must come back, not the file as it is now.
    yield* write("changed.txt", "WORKING TREE\n");
    yield* write("unchanged.txt", "WORKING TREE\n");
    yield* fs.remove(path.join(cwd, "added.txt"));

    const query = yield* CheckpointDiffQuery.make.pipe(
      Effect.provide(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getCheckpointContext: () =>
            Effect.succeed({
              runs: [{ id: runId, ordinal: 1, status: "completed" }],
              checkpointScopes: [{ id: scopeId, runId, kind: "root_run", cwd }],
              checkpoints: [
                {
                  scopeId,
                  runId,
                  ordinalWithinScope: 1,
                  appRunOrdinal: 1,
                  status: "ready",
                  ref: toCheckpointRef,
                },
              ],
            }),
        }),
      ),
    );
    const read = (file: string, previousPath?: string) =>
      query.getTurnDiffFileContents({
        threadId,
        fromTurnCount: 0,
        toTurnCount: 1,
        path: file,
        ...(previousPath === undefined ? {} : { previousPath }),
      });

    assert.deepEqual(yield* read("changed.txt"), {
      oldContents: "one\ntwo\nthree\n",
      newContents: "one\n2 é\nthree\n",
    });
    assert.deepEqual(yield* read("added.txt"), { oldContents: "", newContents: "added\n" });
    assert.deepEqual(yield* read("deleted.txt"), { oldContents: "gone\n", newContents: "" });
    assert.deepEqual(yield* read("whitespace.txt"), {
      oldContents: "a b\n",
      newContents: "a  b\n",
    });
    assert.deepEqual(yield* read("twin d.txt", "twin c.txt"), {
      oldContents: `${twinBody}c\n`,
      newContents: `${twinBody}c\n`,
    });
    assert.deepEqual(yield* read("moved/new name.txt", "old name.txt"), {
      oldContents: `${renameBody}before\n`,
      newContents: `${renameBody}after\n`,
    });

    const refusals = {
      unchanged: yield* read("unchanged.txt").pipe(Effect.flip),
      neverExisted: yield* read("nothing.txt").pipe(Effect.flip),
      imported: yield* read("upstream.ts").pipe(Effect.flip),
      wrongSource: yield* read("moved/new name.txt", "changed.txt").pipe(Effect.flip),
      missingSource: yield* read("moved/new name.txt", "nothing.txt").pipe(Effect.flip),
      notRenamed: yield* read("changed.txt", "old name.txt").pipe(Effect.flip),
      otherTwin: yield* read("twin b.txt", "twin c.txt").pipe(Effect.flip),
      renameSourceAlone: yield* read("twin c.txt").pipe(Effect.flip),
      binary: yield* read("binary.bin").pipe(Effect.flip),
      big: yield* read("big.txt").pipe(Effect.flip),
    };
    assert.deepEqual(
      Object.entries(refusals).map(([name, error]) => {
        assert.instanceOf(error, CheckpointFileContentsUnavailableError);
        return [name, error.reason];
      }),
      [
        ["unchanged", "not_in_diff"],
        ["neverExisted", "not_in_diff"],
        ["imported", "not_in_diff"],
        ["wrongSource", "not_in_diff"],
        ["missingSource", "not_in_diff"],
        ["notRenamed", "not_in_diff"],
        ["otherTwin", "not_in_diff"],
        ["renameSourceAlone", "not_in_diff"],
        ["binary", "binary"],
        ["big", "too_large"],
      ],
    );
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);
