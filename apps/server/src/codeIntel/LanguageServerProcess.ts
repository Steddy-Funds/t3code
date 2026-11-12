// @effect-diagnostics nodeBuiltinImport:off -- LSP names files by URL, and the child learns this process's PID.
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { InitializeParams, ServerCapabilities } from "vscode-languageserver-protocol";

import type { LanguageContext, LanguageRow } from "./LanguageRegistry.ts";
import type { LaunchSpec } from "./LanguageServerBinaries.ts";
import * as LspConnection from "./LspConnection.ts";

const INITIALIZE_DEADLINE = "30 seconds";
// `shutdown` and `exit` get this long; after it the process group is signalled.
const SHUTDOWN_GRACE = "1500 millis";
const KILL_GRACE = "2 seconds";
const STDERR_TAIL_MAX_CHARS = 4_096;
const STDERR_EXCERPT_MAX_CHARS = 300;
const STDERR_DRAIN_GRACE = "250 millis";
// How long a server whose output ended gets to exit by itself.
const CONNECTION_END_GRACE = "2 seconds";
// Bridges the gap between opening a document and the server's first progress report.
const DOCUMENT_OPEN_SETTLE_MS = 3_000;
// Past this, a progress report that never ended no longer excuses timeouts.
const PROGRESS_GRACE_MS = 5 * 60_000;
// Above the agents' own score, so the kernel picks a language server before a provider CLI.
const LANGUAGE_SERVER_OOM_SCORE_ADJ = 900;
const RAISE_OOM_SCORE_SCRIPT = `{ echo ${LANGUAGE_SERVER_OOM_SCORE_ADJ} >/proc/self/oom_score_adj; } 2>/dev/null\nexec "$@"`;

// The child gets no secrets and no ambient virtualenv: only what a native binary needs to start.
const INHERITED_ENVIRONMENT = [
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "SystemRoot",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
];
const POSIX_PATH = "/usr/bin:/bin";

// Both servers pick UTF-8 when offered; client offsets are UTF-16, so nothing else is offered.
const POSITION_ENCODING = "utf-16";

// TypeScript derives its legend from this list and returns no tokens for an empty one.
const SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
];
const SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary",
];

export interface LanguageServerExit {
  readonly code: number | undefined;
  readonly signal: string | undefined;
  /** Set when the process outlived its broken connection: the pool's kill ends it. */
  readonly connection?: LspConnection.LspConnectionClosedError["reason"];
}

export class LanguageServerStartError extends Schema.TaggedError<LanguageServerStartError>()(
  "LanguageServerStartError",
  {
    languageId: Schema.String,
    stage: Schema.Literals(["spawn", "initialize", "initialize_timeout", "exited", "encoding"]),
    exitCode: Schema.optional(Schema.Number),
    signal: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "spawn":
        return "The language server could not be started.";
      case "initialize_timeout":
        return "The language server did not answer `initialize` in time.";
      case "exited":
        return `The language server exited while starting (${describeExit(this)}).`;
      case "encoding":
        return "The language server does not support UTF-16 positions.";
      case "initialize":
        return "The language server refused `initialize`.";
    }
  }
}

const describeExit = (exit: {
  readonly exitCode?: number | undefined;
  readonly signal?: string | undefined;
}) => (exit.signal === undefined ? `code ${exit.exitCode ?? "unknown"}` : `signal ${exit.signal}`);

export interface LanguageServerLaunch {
  readonly row: LanguageRow;
  readonly spec: LaunchSpec;
  readonly context: LanguageContext;
  /** Names this server's scope for memory-kill diagnosis; unique per (language, root). */
  readonly scopeKey: string;
}

/** A spawned child that has not answered `initialize` yet. */
export interface SpawnedLanguageServer {
  readonly pid: number;
  /** Completes when the process is gone. */
  readonly exited: Effect.Effect<LanguageServerExit>;
  /** The last line the child wrote to stderr, bounded: for the status message, never logged. */
  readonly stderrExcerpt: Effect.Effect<string | undefined>;
  /** Completes `initialize`. The spawn's scope must still be open. */
  readonly initialize: Effect.Effect<RunningLanguageServer, LanguageServerStartError, Scope.Scope>;
}

export interface RunningLanguageServer {
  readonly pid: number;
  readonly name: string;
  readonly version: string | undefined;
  readonly capabilities: ServerCapabilities;
  /** Clock millis just before the spawn: the server may not know of a file changed after it. */
  readonly startedAt: number;
  readonly request: LspConnection.LspConnection["request"];
  readonly notify: LspConnection.LspConnection["notify"];
  /** True while the server reports work begun in the last five minutes, or a document was just opened. */
  readonly isLoading: Effect.Effect<boolean>;
  readonly noteDocumentOpened: Effect.Effect<void>;
  /** Completes when the process is gone, or can no longer be talked to. */
  readonly exited: Effect.Effect<LanguageServerExit>;
  /** The last line the child wrote to stderr, bounded: for the status message, never logged. */
  readonly stderrExcerpt: Effect.Effect<string | undefined>;
}

export const pathToUri = (absolutePath: string) => NodeURL.pathToFileURL(absolutePath).href;

/** `undefined` for anything that is not a local file. */
export const uriToPath = (uri: string): string | undefined => {
  if (!uri.startsWith("file:")) return undefined;
  try {
    return NodeURL.fileURLToPath(uri);
  } catch {
    return undefined;
  }
};

const initializeParams = (launch: LanguageServerLaunch, rootName: string): InitializeParams => {
  const rootUri = pathToUri(launch.context.root);
  return {
    // The server watches this PID and exits when it is gone: no orphan after a hard kill.
    processId: NodeProcess.pid,
    clientInfo: { name: "t3-code" },
    rootUri,
    rootPath: launch.context.root,
    workspaceFolders: [{ uri: rootUri, name: rootName }],
    initializationOptions: launch.row.initializationOptions(launch.context),
    capabilities: {
      general: { positionEncodings: [POSITION_ENCODING] },
      window: { workDoneProgress: true },
      workspace: {
        workspaceFolders: true,
        configuration: true,
        didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
        symbol: { dynamicRegistration: false },
        semanticTokens: { refreshSupport: true },
      },
      // No `publishDiagnostics` and no `diagnostic`: pushed diagnostics are dropped unread.
      textDocument: {
        synchronization: { dynamicRegistration: false, didSave: false },
        definition: { linkSupport: true },
        typeDefinition: { linkSupport: true },
        implementation: { linkSupport: true },
        references: {},
        documentHighlight: {},
        hover: { contentFormat: ["markdown", "plaintext"] },
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        semanticTokens: {
          requests: { full: { delta: false }, range: true },
          tokenTypes: SEMANTIC_TOKEN_TYPES,
          tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
          formats: ["relative"],
          multilineTokenSupport: false,
          overlappingTokenSupport: false,
        },
      },
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Spawns one language server. The scope owns the child: closing it signals the process group
 * and kills it after a grace, and an initialized server is asked to `shutdown` and `exit` first.
 */
export const spawn = Effect.fn("LanguageServerProcess.spawn")(function* (
  launch: LanguageServerLaunch,
): Effect.fn.Return<
  SpawnedLanguageServer,
  LanguageServerStartError,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | Path.Path
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const agentScope = yield* AgentScope;
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;
  const path = yield* Path.Path;
  const { row, spec, context } = launch;

  const environment: Record<string, string> = { ...row.environment };
  for (const name of INHERITED_ENVIRONMENT) {
    const value = hostEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  const hostPath = hostEnvironment.PATH;
  if (platform !== "win32") environment.PATH = POSIX_PATH;
  else if (hostPath !== undefined) environment.PATH = hostPath;

  const command =
    platform === "linux"
      ? {
          command: "/bin/sh",
          args: ["-c", RAISE_OOM_SCORE_SCRIPT, "t3-language-server", spec.command, ...spec.args],
        }
      : { command: spec.command, args: spec.args };
  const wrapped = yield* agentScope.wrap({
    ...command,
    name: `lsp-${row.id}`,
    threadId: launch.scopeKey,
    env: environment,
    memoryMaxBytes: row.memoryMaxBytes,
  });
  // Registered before the spawn, so it runs after the group is killed and reaps what is left.
  yield* Effect.addFinalizer(() =>
    wrapped.unit === undefined
      ? Effect.void
      : agentScope.stop(wrapped.unit).pipe(Effect.andThen(agentScope.clear(launch.scopeKey))),
  );

  const startError = (
    stage: LanguageServerStartError["stage"],
    detail: { readonly exit?: LanguageServerExit; readonly cause?: unknown } = {},
  ) =>
    new LanguageServerStartError({
      languageId: row.id,
      stage,
      ...(detail.exit?.code === undefined ? {} : { exitCode: detail.exit.code }),
      ...(detail.exit?.signal === undefined ? {} : { signal: detail.exit.signal }),
      ...(detail.cause === undefined ? {} : { cause: detail.cause }),
    });

  const startedAt = yield* Clock.currentTimeMillis;
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(wrapped.command, wrapped.args, {
        cwd: context.root,
        env: environment,
        extendEnv: false,
        forceKillAfter: KILL_GRACE,
      }),
    )
    .pipe(Effect.mapError((cause) => startError("spawn", { cause })));

  let stderrTail = "";
  const stderrDrain = yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_MAX_CHARS);
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  const exited = yield* Deferred.make<LanguageServerExit>();
  yield* handle.exitCode.pipe(
    Effect.match({
      onSuccess: (code): LanguageServerExit => ({ code: Number(code), signal: undefined }),
      // A signalled process has no code; the spawner names the signal in its error text.
      onFailure: (error): LanguageServerExit => ({
        code: undefined,
        signal: /signal: '([A-Z0-9]+)'/.exec(`${error.message} ${String(error.cause)}`)?.[1],
      }),
    }),
    Effect.flatMap((exit) => Deferred.succeed(exited, exit)),
    Effect.forkScoped,
  );

  const activeProgress = new Map<string | number, number>();
  let settlesAt = 0;
  const rootUri = pathToUri(context.root);
  const rootName = path.basename(context.root);

  const connection = yield* LspConnection.make({
    input: handle.stdout,
    output: handle.stdin,
    onRequest: (method, params) =>
      Effect.sync(() => {
        if (method === "workspace/configuration" && isRecord(params)) {
          const items = Array.isArray(params.items) ? params.items : [];
          return items.map((item: unknown) =>
            row.configuration(
              isRecord(item) && typeof item.section === "string" ? item.section : undefined,
              context,
            ),
          );
        }
        if (method === "workspace/workspaceFolders") return [{ uri: rootUri, name: rootName }];
        if (method === "workspace/applyEdit") return { applied: false };
        // Capability registrations, progress tokens and refresh requests need only an answer.
        return null;
      }),
    onNotification: (method, params) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        if (method !== "$/progress" || !isRecord(params) || !isRecord(params.value)) return;
        const { token } = params;
        if (typeof token !== "string" && typeof token !== "number") return;
        if (params.value.kind === "begin") activeProgress.set(token, now);
        if (params.value.kind === "end") activeProgress.delete(token);
      }),
  });

  // A dead child's stderr ends by itself; the grace covers a grandchild holding the pipe open.
  const stderrExcerpt = Deferred.isDone(exited).pipe(
    Effect.flatMap((gone) =>
      gone
        ? Fiber.join(stderrDrain).pipe(Effect.timeoutOption(STDERR_DRAIN_GRACE), Effect.asVoid)
        : Effect.void,
    ),
    Effect.map(() =>
      stderrTail
        .split(/\r?\n/)
        .map((line) => line.trim())
        .findLast((line) => line.length > 0)
        ?.slice(0, STDERR_EXCERPT_MAX_CHARS),
    ),
  );

  const initialize = Effect.gen(function* () {
    const initialized = yield* connection
      .request("initialize", initializeParams(launch, rootName))
      .pipe(
        Effect.mapError((cause) => startError("initialize", { cause })),
        Effect.timeoutOrElse({
          duration: INITIALIZE_DEADLINE,
          orElse: () => Effect.fail(startError("initialize_timeout")),
        }),
        Effect.raceFirst(
          Deferred.await(exited).pipe(
            Effect.flatMap((exit) => Effect.fail(startError("exited", { exit }))),
          ),
        ),
      );
    const capabilities: ServerCapabilities =
      isRecord(initialized) && isRecord(initialized.capabilities) ? initialized.capabilities : {};
    if ((capabilities.positionEncoding ?? POSITION_ENCODING) !== POSITION_ENCODING) {
      return yield* startError("encoding");
    }
    const serverInfo =
      isRecord(initialized) && isRecord(initialized.serverInfo) ? initialized.serverInfo : {};
    yield* connection
      .notify("initialized", {})
      .pipe(Effect.mapError((cause) => startError("initialize", { cause })));

    // Only an initialized server may be asked to shut down. Registered after the spawn, so it
    // runs before the process group is signalled.
    yield* Effect.addFinalizer(() =>
      connection
        .request("shutdown")
        .pipe(
          Effect.andThen(connection.notify("exit")),
          Effect.andThen(Deferred.await(exited)),
          Effect.timeoutOption(SHUTDOWN_GRACE),
          Effect.ignore,
        ),
    );

    return {
      pid: Number(handle.pid),
      name: spec.name,
      version:
        spec.version ?? (typeof serverInfo.version === "string" ? serverInfo.version : undefined),
      capabilities,
      startedAt,
      request: connection.request,
      notify: connection.notify,
      isLoading: Effect.map(
        Clock.currentTimeMillis,
        (now) =>
          now < settlesAt ||
          [...activeProgress.values()].some((beganAt) => now - beganAt < PROGRESS_GRACE_MS),
      ),
      noteDocumentOpened: Effect.map(Clock.currentTimeMillis, (now) => {
        settlesAt = now + DOCUMENT_OPEN_SETTLE_MS;
      }),
      exited: Effect.raceFirst(
        Deferred.await(exited),
        connection.closed.pipe(
          Effect.flatMap((closed) =>
            (closed.reason === "ended"
              ? Deferred.await(exited).pipe(Effect.timeoutOption(CONNECTION_END_GRACE))
              : Effect.succeedNone
            ).pipe(
              Effect.map(
                Option.getOrElse((): LanguageServerExit => ({
                  code: undefined,
                  signal: undefined,
                  connection: closed.reason,
                })),
              ),
            ),
          ),
        ),
      ),
      stderrExcerpt,
    } satisfies RunningLanguageServer;
  });

  return { pid: Number(handle.pid), exited: Deferred.await(exited), stderrExcerpt, initialize };
});
