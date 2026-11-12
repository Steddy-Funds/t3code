// @effect-diagnostics nodeBuiltinImport:off -- the fixture is launched by path and its record is read as a file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerSettings as ServerSettingsValue } from "@t3tools/contracts";
import type { DeepPartial } from "@t3tools/shared/Struct";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as KnownWorkspaces from "../../workspace/KnownWorkspaces.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as CodeIntel from "../CodeIntel.ts";
import * as LanguageServerBinaries from "../LanguageServerBinaries.ts";
import * as LanguageServerPool from "../LanguageServerPool.ts";
import * as PythonEnvironment from "../PythonEnvironment.ts";
import * as WorkspaceWatcher from "../WorkspaceWatcher.ts";

export const FIXTURE = NodeURL.fileURLToPath(
  new URL("./fakeLanguageServer.fixture.mjs", import.meta.url),
);
export const UNKNOWN_WORKSPACE_PREFIX = "t3code-code-intel-unknown-";

export interface RecordedMessage {
  readonly method?: string;
  readonly id?: number | string;
  // The fixture's record is read back as JSON: what a test looks at is checked where it is read.
  readonly params?: Record<string, any>;
}

export interface LogEntry {
  readonly level: string;
  readonly text: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface ScenarioOptions {
  /** Fixture switches for every language, after `--record`. */
  readonly flags?: ReadonlyArray<string>;
  readonly settings?: DeepPartial<ServerSettingsValue>;
  /** Places the server's state and secrets directories, e.g. inside a workspace. */
  readonly baseDir?: string;
}

/** Holds an effect at one point: it says it got there, then waits to be let go. */
export interface Gate {
  /** Done once `expected` callers are held. */
  readonly began: Deferred.Deferred<void>;
  readonly letGo: Deferred.Deferred<void>;
  readonly expected: number;
  arrived: number;
}

export const makeGate = (expected = 1): Gate => ({
  began: Deferred.makeUnsafe<void>(),
  letGo: Deferred.makeUnsafe<void>(),
  expected,
  arrived: 0,
});

const passGate = (gate: Gate | undefined) =>
  gate === undefined
    ? Effect.void
    : Effect.suspend(() => {
        gate.arrived += 1;
        return gate.arrived >= gate.expected ? Deferred.succeed(gate.began, undefined) : Effect.void;
      }).pipe(Effect.andThen(Deferred.await(gate.letGo)));

export const isAlive = (pid: number) => {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Whole lines only: the fixture may be in the middle of a write. */
export const recorded = (file: string): ReadonlyArray<RecordedMessage> => {
  let text: string;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .slice(0, -1)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordedMessage);
};

export const methodsOf = (file: string) => recorded(file).map((message) => message.method);

export const countOf = (file: string, method: string) =>
  recorded(file).filter((message) => message.method === method).length;

export const startedPids = (file: string): ReadonlyArray<number> =>
  recorded(file)
    .filter((message) => message.method === "$/test/started")
    .map((message) => message.params?.pid as number);

/** Completes once the record satisfies `until`, from the file's own change events. */
export const waitForRecord = (
  file: string,
  until: (messages: ReadonlyArray<RecordedMessage>) => boolean,
) =>
  Effect.callback<ReadonlyArray<RecordedMessage>>((resume) => {
    let done = false;
    const check = () => {
      if (done) return;
      const messages = recorded(file);
      if (!until(messages)) return;
      done = true;
      watcher.close();
      resume(Effect.succeed(messages));
    };
    const watcher = NodeFS.watch(NodePath.dirname(file), { persistent: false }, check);
    check();
    return Effect.sync(() => {
      done = true;
      watcher.close();
    });
  });

export const waitForMethod = (file: string, method: string, count = 1) =>
  waitForRecord(file, (messages) => messages.filter((m) => m.method === method).length >= count);

export const makeWorkspace = Effect.fn("makeWorkspace")(function* (
  files: Readonly<Record<string, string>> = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const cwd = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-code-intel-" }),
  );
  yield* writeFiles(cwd, files);
  return cwd;
});

export const writeFiles = Effect.fn("writeFiles")(function* (
  cwd: string,
  files: Readonly<Record<string, string>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* fileSystem.writeFileString(absolutePath, contents);
  }
});

/** A request running in the background, whose end a test can look at without waiting for it. */
export const forkRequest = Effect.fn("forkRequest")(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) {
  const done = yield* Deferred.make<
    { readonly _tag: "Success"; readonly value: A } | { readonly _tag: "Failure"; readonly error: E }
  >();
  yield* effect.pipe(
    Effect.matchEffect({
      onSuccess: (value) => Deferred.succeed(done, { _tag: "Success" as const, value }),
      onFailure: (error) => Deferred.succeed(done, { _tag: "Failure" as const, error }),
    }),
    Effect.forkChild,
  );
  return {
    settled: Deferred.isDone(done),
    /** Waits for the end of the request; its failure is a value. */
    outcome: Deferred.await(done),
  };
});

export const makeScenario = Effect.fn("makeScenario")(function* (options: ScenarioOptions = {}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const scratch = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-code-intel-scratch-" }),
  );
  const recordFile = (name = "server") => NodePath.join(scratch, `${name}.jsonl`);
  const record = recordFile();
  const resolved = yield* Queue.unbounded<string>();
  const changes = yield* Queue.unbounded<ServerSettingsValue>();

  const state = {
    scratch,
    record,
    recordFile,
    /** Fixture switches for every language, read at each start. */
    flags: [`--record=${record}`, ...(options.flags ?? [])] as Array<string>,
    /** Replaces `flags` for one language. */
    flagsByLanguage: new Map<string, ReadonlyArray<string>>(),
    /** Languages whose binary is missing. */
    missing: new Set<string>(),
    /** What `installServer` asked the binaries to install, and whether that fails. */
    installs: [] as Array<string>,
    installFails: true,
    python: { source: "none", libraryRoots: [] } as PythonEnvironment.PythonEnvironmentLocation,
    /** Each language the binaries were asked about, as the pool does at a start and a status. */
    resolved,
    knownChecks: 0,
    openWatchers: new Map<string, number>(),
    /** Set, a watch handle's release says it began, then waits to be let go. */
    watcherRelease: undefined as Gate | undefined,
    /** Set, the pool's binary lookup says it began, then waits to be let go. */
    resolveGate: undefined as Gate | undefined,
    /** Set, the known-workspace check says it began, then waits to be let go. */
    knownGate: undefined as Gate | undefined,
    history: [] as Array<LogEntry>,
    waiters: new Set<{
      readonly match: (entry: LogEntry) => boolean;
      readonly resume: (effect: Effect.Effect<LogEntry>) => void;
    }>(),
  };

  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    const parts = Array.isArray(message) ? message : [message];
    const fields = parts[1];
    const entry: LogEntry = {
      level: String(logLevel),
      text: String(parts[0]),
      fields: typeof fields === "object" && fields !== null ? (fields as Record<string, unknown>) : {},
    };
    state.history.push(entry);
    for (const waiter of [...state.waiters]) {
      if (!waiter.match(entry)) continue;
      state.waiters.delete(waiter);
      waiter.resume(Effect.succeed(entry));
    }
  });

  const launchSpec = (languageId: string) =>
    ({
      _tag: "LaunchSpec",
      languageId,
      name: "fake",
      version: "1.2.3",
      command: NodeProcess.execPath,
      args: [FIXTURE, ...(state.flagsByLanguage.get(languageId) ?? state.flags)],
      source: "managed",
    }) as const;

  const binaries = Layer.succeed(
    LanguageServerBinaries.LanguageServerBinaries,
    LanguageServerBinaries.LanguageServerBinaries.of({
      resolve: (languageId) =>
        Effect.suspend(() => passGate(state.resolveGate)).pipe(Effect.andThen(Effect.sync(() => {
          Queue.offerUnsafe(resolved, languageId);
          return state.missing.has(languageId)
            ? ({
                _tag: "Unavailable",
                languageId,
                name: "fake",
                reason: "not_installed",
                installable: true,
                message: "fake is not installed. Install it to navigate this language.",
              } as const)
            : launchSpec(languageId);
        }))),
      install: (languageId) =>
        Effect.suspend(() => {
          state.installs.push(languageId);
          if (state.installFails) {
            return Effect.fail(
              new LanguageServerBinaries.LanguageServerInstallError({
                languageId,
                reason: "download_failed",
              }),
            );
          }
          state.missing.delete(languageId);
          return Effect.succeed(launchSpec(languageId));
        }),
      installProgress: () => Effect.undefined,
    }),
  );

  const python = Layer.succeed(
    PythonEnvironment.PythonEnvironment,
    PythonEnvironment.PythonEnvironment.of({ locate: () => Effect.sync(() => state.python) }),
  );

  const refusal = (cwd: string) =>
    cwd.includes(UNKNOWN_WORKSPACE_PREFIX)
      ? Effect.fail(new KnownWorkspaces.UnknownWorkspaceError({ cwd }))
      : Effect.void;
  const knownForCodeIntel = Layer.mock(KnownWorkspaces.KnownWorkspaces)({
    assertContains: (cwd) =>
      Effect.suspend(() => {
        state.knownChecks += 1;
        return passGate(state.knownGate).pipe(Effect.andThen(refusal(cwd)));
      }),
  });
  const knownForFiles = Layer.mock(KnownWorkspaces.KnownWorkspaces)({ assertContains: refusal });

  const workspaceFileSystem = WorkspaceFileSystem.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(Layer.mock(WorkspaceEntries.WorkspaceEntries)({})),
    Layer.provide(knownForFiles),
  );

  // Settings whose changes reach `subscribeChanges`, as the live service's do. One reader: the pool.
  const settings = Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const base = yield* ServerSettings.ServerSettingsService;
      return {
        ...base,
        updateSettings: (patch) =>
          base.updateSettings(patch).pipe(Effect.tap((next) => Queue.offer(changes, next))),
        subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
      } satisfies ServerSettings.ServerSettingsService["Service"];
    }),
  ).pipe(Layer.provide(ServerSettings.ServerSettingsService.layerTest(options.settings)));

  // Counts the watch handles a language server holds, to see them released with it.
  const watcher = Layer.effect(
    WorkspaceWatcher.WorkspaceWatcher,
    Effect.gen(function* () {
      const real = yield* WorkspaceWatcher.WorkspaceWatcher;
      const hold = (key: string) =>
        Effect.acquireRelease(
          Effect.sync(() => state.openWatchers.set(key, (state.openWatchers.get(key) ?? 0) + 1)),
          () =>
            Effect.suspend(() => passGate(state.watcherRelease)).pipe(
              Effect.andThen(
                Effect.sync(() =>
                  state.openWatchers.set(key, (state.openWatchers.get(key) ?? 1) - 1),
                ),
              ),
            ),
        );
      return WorkspaceWatcher.WorkspaceWatcher.of({
        watchTree: (root) => Effect.andThen(hold(root), real.watchTree(root)),
        watchDirectory: (directory) =>
          Effect.andThen(hold(directory), real.watchDirectory(directory)),
      });
    }),
  ).pipe(Layer.provide(WorkspaceWatcher.layer));

  const layer = CodeIntel.layer.pipe(
    Layer.provideMerge(LanguageServerPool.layer),
    Layer.provide(watcher),
    Layer.provide(Layer.mergeAll(binaries, python)),
    Layer.provideMerge(settings),
    Layer.provide(workspaceFileSystem),
    Layer.provide(knownForCodeIntel),
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(
        NodeProcess.cwd(),
        options.baseDir ?? { prefix: "t3-code-intel-test-" },
      ),
    ),
    Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
    Layer.provideMerge(NodeServices.layer),
  );

  const waitForLog = (match: (entry: LogEntry) => boolean, from = 0) =>
    Effect.callback<LogEntry>((resume) => {
      const found = state.history.slice(from).find(match);
      if (found !== undefined) return resume(Effect.succeed(found));
      const waiter = { match, resume };
      state.waiters.add(waiter);
      return Effect.sync(() => {
        state.waiters.delete(waiter);
      });
    });

  // The state itself, extended: a test assigns `flags` or `python` and reads `knownChecks` live.
  return Object.assign(state, {
    layer,
    /** Runs `effect` with its own code intelligence service, torn down when it ends. */
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, layer),
    /** Where the log is now: `waitForLog` from here sees only what happens after. */
    mark: () => state.history.length,
    waitForLog,
    waitForStop: (reason: string, from = 0) =>
      waitForLog(
        (entry) => entry.text === "Language server stopped" && entry.fields.reason === reason,
        from,
      ),
    /** The handles held right now, over every root. */
    heldWatchers: () => [...state.openWatchers.values()].reduce((sum, count) => sum + count, 0),
    /** Turns code intelligence on or off the way a settings change does. */
    setEnabled: (enabled: boolean) =>
      Effect.gen(function* () {
        const service = yield* ServerSettings.ServerSettingsService;
        yield* service.updateSettings({ codeIntel: { enabled } });
      }),
  });
});

export type Scenario = Effect.Success<ReturnType<typeof makeScenario>>;

/** Runs `body` in a fresh scenario with a fresh service. */
export const inScenario = <A, E, R>(
  options: ScenarioOptions,
  body: (scenario: Scenario) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const scenario = yield* makeScenario(options);
    return yield* scenario.provide(body(scenario));
  }).pipe(Effect.provide(NodeServices.layer));

export const noWorkspaceStarted = (record: string) => NodeFS.existsSync(record) === false;
