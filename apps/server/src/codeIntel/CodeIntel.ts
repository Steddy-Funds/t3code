import {
  CODE_INTEL_LINE_TEXT_MAX_LENGTH,
  CodeIntelError,
  type CodeDocument,
  type CodeIntelDefinitionInput,
  type CodeIntelDefinitionResult,
  type CodeIntelDocumentHighlightsResult,
  type CodeIntelDocumentInput,
  type CodeIntelDocumentSymbolsResult,
  type CodeIntelHoverResult,
  type CodeIntelInstallServerInput,
  type CodeIntelInstallServerResult,
  type CodeIntelPositionInput,
  type CodeIntelReferencesInput,
  type CodeIntelReferencesResult,
  type CodeIntelRestartInput,
  type CodeIntelSemanticTokensInput,
  type CodeIntelSemanticTokensResult,
  type CodeIntelStatusInput,
  type CodeIntelStatusResult,
  type CodeIntelWorkspaceSymbolsInput,
  type CodeIntelWorkspaceSymbolsResult,
  type CodeLibraryRoot,
  type CodeLocation,
  type CodeServerStatus,
  type CodeWorkspaceSymbol,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fileContentRevision } from "@t3tools/shared/fileContentRevision";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { makeIsServerInternalPath } from "../auth/serverInternalPaths.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import {
  LANGUAGE_ROWS,
  languageForPath,
  languageRow,
  type LanguageRow,
} from "./LanguageRegistry.ts";
import * as LanguageServerBinaries from "./LanguageServerBinaries.ts";
import * as LanguageServerPool from "./LanguageServerPool.ts";
import { pathToUri, uriToPath } from "./LanguageServerProcess.ts";
import type { LspError } from "./LspConnection.ts";
import * as LspResults from "./lspResults.ts";
import * as PythonEnvironment from "./PythonEnvironment.ts";
import * as TypeScriptProject from "./TypeScriptProject.ts";
import { IGNORED_DIRECTORIES } from "./WorkspaceWatcher.ts";

/** A hung child cannot hold a request: definition, hover and highlights get this long. */
const POSITION_DEADLINE = Duration.seconds(10);
/** References, symbols and semantic tokens walk more of the project. */
const SEARCH_DEADLINE = Duration.seconds(30);
// The known-workspace check reads the database; a hover every few hundred ms need not.
const KNOWN_ROOT_TTL_MS = 30_000;
const KNOWN_ROOT_CAP = 64;
const LOADING_RETRY_INTERVAL = Duration.millis(250);
const LOCATION_CONCURRENCY = 8;
const MAX_PROBED_SUBDIRECTORIES = 64;
// The document changed under the request, or the server gave up on it: asking again is right.
const RETRYABLE_LSP_CODES: ReadonlySet<number> = new Set([-32801, -32802]);
const PLANNED_STOPS: ReadonlySet<LanguageServerPool.StopReason> = new Set([
  "idle",
  "evicted",
  "restart",
  "dependencies",
]);

export class CodeIntel extends Context.Service<
  CodeIntel,
  {
    /** Never starts a language server. */
    readonly status: (
      input: CodeIntelStatusInput,
    ) => Effect.Effect<CodeIntelStatusResult, CodeIntelError>;
    readonly definition: (
      input: CodeIntelDefinitionInput,
    ) => Effect.Effect<CodeIntelDefinitionResult, CodeIntelError>;
    readonly references: (
      input: CodeIntelReferencesInput,
    ) => Effect.Effect<CodeIntelReferencesResult, CodeIntelError>;
    readonly documentHighlights: (
      input: CodeIntelPositionInput,
    ) => Effect.Effect<CodeIntelDocumentHighlightsResult, CodeIntelError>;
    readonly hover: (
      input: CodeIntelPositionInput,
    ) => Effect.Effect<CodeIntelHoverResult, CodeIntelError>;
    readonly documentSymbols: (
      input: CodeIntelDocumentInput,
    ) => Effect.Effect<CodeIntelDocumentSymbolsResult, CodeIntelError>;
    readonly workspaceSymbols: (
      input: CodeIntelWorkspaceSymbolsInput,
    ) => Effect.Effect<CodeIntelWorkspaceSymbolsResult, CodeIntelError>;
    readonly semanticTokens: (
      input: CodeIntelSemanticTokensInput,
    ) => Effect.Effect<CodeIntelSemanticTokensResult, CodeIntelError>;
    /** The only path that downloads anything. */
    readonly installServer: (
      input: CodeIntelInstallServerInput,
    ) => Effect.Effect<CodeIntelInstallServerResult, CodeIntelError>;
    /** Stops this root's language servers and clears a `failed` state; the next request starts one. */
    readonly restart: (
      input: CodeIntelRestartInput,
    ) => Effect.Effect<CodeIntelStatusResult, CodeIntelError>;
  }
>()("t3/codeIntel/CodeIntel") {}

const DEFINITION_METHODS = {
  definition: { method: "textDocument/definition", capability: "definitionProvider" },
  typeDefinition: { method: "textDocument/typeDefinition", capability: "typeDefinitionProvider" },
  implementation: { method: "textDocument/implementation", capability: "implementationProvider" },
} as const;

const fail = (reason: CodeIntelError["reason"], message: string) =>
  new CodeIntelError({ reason, message });

const timedOut = () => fail("timeout", "The language server did not answer in time.");

/** One deadline a request, from its start: finding the file counts toward it. */
interface Deadline {
  readonly at: number;
}

const startDeadline = (duration: Duration.Duration) =>
  Effect.map(Clock.currentTimeMillis, (now): Deadline => ({
    at: now + Duration.toMillis(duration),
  }));

const remaining = (deadline: Deadline) =>
  Effect.map(Clock.currentTimeMillis, (now) => Duration.millis(Math.max(0, deadline.at - now)));

const within =
  (deadline: Deadline) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.flatMap(remaining(deadline), (duration) =>
      Effect.timeoutOrElse(effect, { duration, orElse: () => Effect.fail(timedOut()) }),
    );

const boundedBy =
  (duration: Duration.Duration) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.timeoutOrElse(effect, { duration, orElse: () => Effect.fail(timedOut()) });

interface ResolvedDocument {
  readonly root: string;
  readonly row: LanguageRow;
  readonly documentLanguageId: string;
  readonly realPath: string;
  readonly text: string;
  readonly revision: string;
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const pool = yield* LanguageServerPool.LanguageServerPool;
  const binaries = yield* LanguageServerBinaries.LanguageServerBinaries;
  const pythonEnvironment = yield* PythonEnvironment.PythonEnvironment;
  const isServerInternalPath = yield* makeIsServerInternalPath;
  const typeScriptProjects = yield* TypeScriptProject.make;
  const home = yield* HostProcess.HomeDirectory;
  const hostEnvironment = yield* HostProcess.Environment;
  const knownRoots = new Map<string, { readonly root: string; readonly expiresAt: number }>();

  /** No server starts for an arbitrary directory: the root must be a known workspace. */
  const resolveRoot = Effect.fnUntraced(function* (cwd: string) {
    const now = yield* Clock.currentTimeMillis;
    const known = knownRoots.get(cwd);
    if (known !== undefined && known.expiresAt > now) return known.root;
    const refuse = () =>
      fail("path_not_allowed", "This folder is not a project or a thread's worktree.");
    yield* knownWorkspaces.assertContains(cwd).pipe(Effect.mapError(refuse));
    const root = yield* fileSystem.realPath(path.resolve(cwd)).pipe(Effect.mapError(refuse));
    if (knownRoots.size >= KNOWN_ROOT_CAP) knownRoots.clear();
    knownRoots.set(cwd, { root, expiresAt: now + KNOWN_ROOT_TTL_MS });
    return root;
  });

  /**
   * The document as it is on disk, through the rule `projects.readFile` applies. No client text
   * is ever read here, so two clients cannot give a server different contents for one file.
   */
  const readDocument = Effect.fnUntraced(function* (root: string, relativePath: string) {
    const language = languageForPath(relativePath);
    if (language === undefined) {
      return yield* fail("unsupported_language", "No language server handles this kind of file.");
    }
    const { file, realPath } = yield* workspaceFileSystem
      .readFileWithRealPath({ cwd: root, relativePath })
      .pipe(
        Effect.catchTags({
          WorkspacePathOutsideRootError: () =>
            fail("path_not_allowed", "This path is outside what the server may read."),
          WorkspaceFilePathEscapeError: () =>
            fail("path_not_allowed", "This path resolves outside the project."),
          WorkspaceBinaryFileError: () => fail("unsupported_language", "This file is not text."),
          WorkspacePathNotFileError: () => fail("not_found", "This path is not a file."),
          WorkspaceFileSystemOperationError: () =>
            fail("not_found", "This file could not be read."),
        }),
      );
    if (realPath === null || file.exists === false) {
      return yield* fail("not_found", "This file does not exist.");
    }
    if (file.truncated) {
      return yield* fail("file_too_large", "This file is too large to analyse.");
    }
    return {
      root,
      row: language.row,
      documentLanguageId: language.documentLanguageId,
      realPath,
      text: file.contents,
      revision: fileContentRevision(file.contents),
    } satisfies ResolvedDocument;
  });

  const resolveDocument = Effect.fnUntraced(function* (document: CodeDocument) {
    const root = yield* resolveRoot(document.cwd);
    const resolved = yield* readDocument(root, document.path);
    if (document.ifRevision !== undefined && document.ifRevision !== resolved.revision) {
      return yield* fail("stale_document", "The file on disk differs from the text shown.");
    }
    return resolved;
  });

  type Send = (method: string, params: unknown) => Effect.Effect<unknown, LspError>;

  /**
   * Starts the server when needed and runs `use` under the request's deadline. A server the
   * pool stopped on purpose mid-request is started again once; a crash is `server_failed`.
   */
  const withServer = <A>(
    row: LanguageRow,
    root: string,
    deadline: Deadline,
    use: (
      live: LanguageServerPool.LiveServer,
      send: Send,
    ) => Effect.Effect<A, CodeIntelError | LspError>,
  ): Effect.Effect<A, CodeIntelError> => {
    let waitingOn: LanguageServerPool.LiveServer | undefined;
    const expire = Effect.fnUntraced(function* () {
      const hung = waitingOn;
      // A server still loading is slow, not hung: only a settled one counts toward a restart.
      if (hung !== undefined && !(yield* hung.server.isLoading)) {
        yield* pool.reportOutcome(hung, "timeout");
      }
      return yield* timedOut();
    });
    const attempt = Effect.fn("CodeIntel.attempt")(function* (
      retried: boolean,
    ): Effect.fn.Return<A, CodeIntelError> {
      const live = yield* pool.acquire(row, root);
      const send: Send = (method, params) =>
        Effect.suspend(() => {
          waitingOn = live;
          return live.server.request(method, params);
        }).pipe(
          // The deadline interrupts the request: `expire` still needs to see who never answered.
          Effect.onExit((exit) =>
            Exit.hasInterrupts(exit)
              ? Effect.void
              : Effect.sync(() => {
                  waitingOn = undefined;
                }),
          ),
          Effect.tap(() => pool.reportOutcome(live, "answered")),
        );
      return yield* live.gate
        .withPermits(1)(use(live, send))
        .pipe(
          Effect.catchTags({
            LspResponseError: (error) => Effect.fail(fail("server_failed", error.message)),
            LspConnectionClosedError: () => {
              const reason = live.stopReason;
              if (reason !== undefined && PLANNED_STOPS.has(reason) && !retried) {
                return attempt(true);
              }
              return Effect.fail(
                reason === "off" || reason === "shutdown"
                  ? fail("server_unavailable", "The language server was stopped.")
                  : fail("server_failed", "The language server stopped while answering."),
              );
            },
          }),
        );
    });
    return Effect.flatMap(remaining(deadline), (duration) =>
      attempt(false).pipe(Effect.timeoutOrElse({ duration, orElse: expire })),
    );
  };

  /**
   * A server answers empty while it loads a project. An empty answer given while it reported
   * loading is asked again, until it has something or was settled when asked.
   */
  const askUntilLoaded = Effect.fnUntraced(function* <R>(
    live: LanguageServerPool.LiveServer,
    ask: Effect.Effect<R, LspError>,
    isEmpty: (answer: R) => boolean,
  ) {
    for (;;) {
      const loading = yield* live.server.isLoading;
      const answer = yield* ask.pipe(
        Effect.map((value) => ({ retry: false as const, value })),
        Effect.catchTags({
          LspResponseError: (error) =>
            RETRYABLE_LSP_CODES.has(error.code)
              ? Effect.succeed({ retry: true as const })
              : Effect.fail(error),
        }),
      );
      if (!answer.retry && (!loading || !isEmpty(answer.value))) return answer.value;
      yield* Effect.sleep(LOADING_RETRY_INTERVAL);
    }
  });

  const isEmptyAnswer = (answer: unknown) =>
    answer === null || answer === undefined || (Array.isArray(answer) && answer.length === 0);

  /** Opens the document with its text from disk and asks about it under one lock. */
  const askDocument = <A>(
    document: ResolvedDocument,
    deadline: Deadline,
    ask: (
      live: LanguageServerPool.LiveServer,
      send: Send,
      uri: string,
    ) => Effect.Effect<A, CodeIntelError | LspError>,
  ) =>
    withServer(document.row, document.root, deadline, (live, send) =>
      live.session.withDocument(document, ask(live, send, pathToUri(document.realPath))),
    );

  const supports = (live: LanguageServerPool.LiveServer, capability: string) => {
    const value = (live.server.capabilities as Record<string, unknown>)[capability];
    return value !== undefined && value !== null && value !== false;
  };

  const libraryRootPaths = (live: LanguageServerPool.LiveServer) =>
    (live.context.python?.libraryRoots ?? []).map((root) => root.path);

  /**
   * Maps server locations to what a client may open, one result an input (`undefined` for a
   * dropped one). A location in a server-internal path is dropped, and a preview line is read
   * through the same rule as any file read. Each file is read once and only its asked-for lines
   * are kept, so a wide answer never holds hundreds of files at a time. `names` narrows ranges.
   */
  const locateEach = Effect.fnUntraced(function* (
    live: LanguageServerPool.LiveServer,
    locations: ReadonlyArray<LspResults.LspLocation>,
    options: { readonly lineText: boolean; readonly names?: ReadonlyArray<string> },
  ) {
    const rangeOf = (index: number) => (locations[index] as LspResults.LspLocation).range;
    const needsName = (index: number) => {
      const name = options.names?.[index];
      return name !== undefined && !LspResults.isNameRange(rangeOf(index), name);
    };
    const libraryRoots = libraryRootPaths(live);
    const byFile = new Map<string, Array<number>>();
    locations.forEach((location, index) => {
      const lexical = uriToPath(location.uri);
      if (lexical === undefined) return;
      const indexes = byFile.get(lexical);
      if (indexes === undefined) byFile.set(lexical, [index]);
      else indexes.push(index);
    });
    const located: Array<CodeLocation | undefined> = locations.map(() => undefined);
    yield* Effect.forEach(
      byFile,
      Effect.fnUntraced(function* ([lexical, indexes]) {
        const real = yield* fileSystem
          .realPath(lexical)
          .pipe(Effect.orElseSucceed(() => path.resolve(lexical)));
        if (yield* isServerInternalPath(real)) return;
        const lines =
          options.lineText || indexes.some(needsName)
            ? yield* workspaceFileSystem.readFile({ cwd: live.root, relativePath: real }).pipe(
                Effect.map((file) => file.contents.split(/\r?\n/)),
                Effect.orElseSucceed((): Array<string> => []),
              )
            : [];
        // A symlink inside the root that leaves it is shown by its real path, which a read allows.
        const inside =
          KnownWorkspaces.isWithinRoot(path, lexical, live.root) &&
          KnownWorkspaces.isWithinRoot(path, real, live.root);
        const external =
          !inside ||
          libraryRoots.some((root) => KnownWorkspaces.isWithinRoot(path, real, root)) ||
          real
            .split(path.sep)
            .some((segment) => segment === "node_modules" || segment === "site-packages");
        const shownPath = inside
          ? path.relative(live.root, lexical).split(path.sep).join("/")
          : real;
        for (const index of indexes) {
          const name = options.names?.[index];
          const range =
            name === undefined ? rangeOf(index) : LspResults.nameRange(lines, rangeOf(index), name);
          const lineText = options.lineText ? lines[range.start.line] : undefined;
          located[index] = {
            path: shownPath,
            external,
            range,
            ...(lineText === undefined || lineText.length === 0
              ? {}
              : { lineText: lineText.slice(0, CODE_INTEL_LINE_TEXT_MAX_LENGTH) }),
          };
        }
      }),
      { concurrency: LOCATION_CONCURRENCY, discard: true },
    );
    return located;
  });

  const locateAll = (
    live: LanguageServerPool.LiveServer,
    locations: ReadonlyArray<LspResults.LspLocation>,
  ) =>
    locateEach(live, locations, { lineText: true }).pipe(
      Effect.map((located) => located.filter((location) => location !== undefined)),
    );

  /**
   * Without a watcher the server may have answered from a stale file. The files the answer
   * points at are checked once and the question asked again when one changed.
   */
  const askLocations = Effect.fnUntraced(function* (
    live: LanguageServerPool.LiveServer,
    ask: Effect.Effect<unknown, LspError>,
  ) {
    const first = LspResults.toLocations(yield* askUntilLoaded(live, ask, isEmptyAnswer));
    const paths = first.map((location) => uriToPath(location.uri)).filter((p) => p !== undefined);
    if (!(yield* live.session.refreshChangedFiles(paths))) return first;
    return LspResults.toLocations(yield* ask);
  });

  const definition: CodeIntel["Service"]["definition"] = Effect.fn("CodeIntel.definition")(
    function* (input) {
      const deadline = yield* startDeadline(POSITION_DEADLINE);
      const document = yield* resolveDocument(input.document).pipe(within(deadline));
      const { method, capability } = DEFINITION_METHODS[input.kind];
      const locations = yield* askDocument(document, deadline, (live, send, uri) =>
        supports(live, capability)
          ? askLocations(
              live,
              send(method, { textDocument: { uri }, position: input.position }),
            ).pipe(Effect.flatMap((found) => locateAll(live, found)))
          : Effect.succeed([]),
      );
      return { locations, revision: document.revision };
    },
  );

  const references: CodeIntel["Service"]["references"] = Effect.fn("CodeIntel.references")(
    function* (input) {
      const deadline = yield* startDeadline(SEARCH_DEADLINE);
      const document = yield* resolveDocument(input.document).pipe(within(deadline));
      const found = yield* askDocument(document, deadline, (live, send, uri) =>
        supports(live, "referencesProvider")
          ? askLocations(
              live,
              send("textDocument/references", {
                textDocument: { uri },
                position: input.position,
                context: { includeDeclaration: input.includeDeclaration },
              }),
            ).pipe(
              Effect.flatMap((all) =>
                locateAll(live, all.slice(0, input.limit)).pipe(
                  Effect.map((locations) => ({ locations, truncated: all.length > input.limit })),
                ),
              ),
            )
          : Effect.succeed({ locations: [], truncated: false }),
      );
      return { ...found, revision: document.revision };
    },
  );

  const documentHighlights: CodeIntel["Service"]["documentHighlights"] = Effect.fn(
    "CodeIntel.documentHighlights",
  )(function* (input) {
    const deadline = yield* startDeadline(POSITION_DEADLINE);
    const document = yield* resolveDocument(input.document).pipe(within(deadline));
    const ranges = yield* askDocument(document, deadline, (live, send, uri) =>
      supports(live, "documentHighlightProvider")
        ? askUntilLoaded(
            live,
            send("textDocument/documentHighlight", {
              textDocument: { uri },
              position: input.position,
            }),
            isEmptyAnswer,
          ).pipe(Effect.map(LspResults.toHighlights))
        : Effect.succeed([]),
    );
    return { ranges, revision: document.revision };
  });

  // A hover carries text only from files a server loads as modules. The server's own files
  // (`secrets/*.bin`, `*.sqlite`) never are; a secret with a module extension would need a filter here.
  const hover: CodeIntel["Service"]["hover"] = Effect.fn("CodeIntel.hover")(function* (input) {
    const deadline = yield* startDeadline(POSITION_DEADLINE);
    const document = yield* resolveDocument(input.document).pipe(within(deadline));
    const answer = yield* askDocument(document, deadline, (live, send, uri) =>
      supports(live, "hoverProvider")
        ? askUntilLoaded(
            live,
            send("textDocument/hover", { textDocument: { uri }, position: input.position }),
            isEmptyAnswer,
          )
        : Effect.succeed(null),
    );
    const contents =
      typeof answer === "object" && answer !== null
        ? (answer as { readonly contents?: unknown; readonly range?: unknown })
        : {};
    const range = LspResults.toRange(contents.range);
    return {
      markdown: LspResults.toHoverMarkdown(contents.contents),
      ...(range === undefined ? {} : { range }),
      revision: document.revision,
    };
  });

  const documentSymbols: CodeIntel["Service"]["documentSymbols"] = Effect.fn(
    "CodeIntel.documentSymbols",
  )(function* (input) {
    const deadline = yield* startDeadline(SEARCH_DEADLINE);
    const document = yield* resolveDocument(input.document).pipe(within(deadline));
    const symbols = yield* askDocument(document, deadline, (live, send, uri) =>
      supports(live, "documentSymbolProvider")
        ? askUntilLoaded(
            live,
            send("textDocument/documentSymbol", { textDocument: { uri } }),
            isEmptyAnswer,
          ).pipe(Effect.map((result) => LspResults.toDocumentSymbols(result, uri)))
        : Effect.succeed([]),
    );
    return { symbols, revision: document.revision };
  });

  const semanticTokens: CodeIntel["Service"]["semanticTokens"] = Effect.fn(
    "CodeIntel.semanticTokens",
  )(function* (input) {
    const deadline = yield* startDeadline(SEARCH_DEADLINE);
    const document = yield* resolveDocument(input.document).pipe(within(deadline));
    const tokens = yield* askDocument(document, deadline, (live, send, uri) => {
      const provider = live.server.capabilities.semanticTokensProvider;
      const legend = LspResults.toSemanticTokensLegend(provider);
      if (legend === undefined) return Effect.undefined;
      const ranged = input.range !== undefined && LspResults.supportsRange(provider);
      return askUntilLoaded(
        live,
        send(ranged ? "textDocument/semanticTokens/range" : "textDocument/semanticTokens/full", {
          textDocument: { uri },
          ...(ranged ? { range: input.range } : {}),
        }),
        (answer) => LspResults.toSemanticTokenData(answer).length === 0,
      ).pipe(Effect.map((answer) => ({ legend, data: LspResults.toSemanticTokenData(answer) })));
    });
    return tokens === undefined
      ? { legend: null, revision: document.revision }
      : { ...tokens, revision: document.revision };
  });

  // Once a server, not on every keystroke of a picker.
  const seeded = new WeakSet<LanguageServerPool.LiveServer["session"]>();

  /**
   * tsc answers a workspace question about loaded projects alone, and loads one only when a file
   * of it opens. Before a server's first question a file of each chosen project is: a file already
   * open may be in no project, or in one of many.
   */
  const loadProjects = Effect.fnUntraced(function* (live: LanguageServerPool.LiveServer) {
    if (live.row.id !== "typescript" || seeded.has(live.session)) return;
    const files = yield* typeScriptProjects.seedFiles(live.root);
    yield* Effect.forEach(
      files,
      (file) =>
        // Relative, so the read rule refuses a file outside the root, through a link too.
        readDocument(live.root, path.relative(live.root, file)).pipe(
          Effect.flatMap((document) => live.session.withDocument(document, Effect.void)),
          Effect.ignore,
        ),
      { discard: true },
    );
    seeded.add(live.session);
  });

  // A row whose files or manifests sit in the root or one folder down.
  const detectRows = Effect.fnUntraced(function* (root: string) {
    const names = yield* fileSystem.readDirectory(root).pipe(Effect.orElseSucceed(() => []));
    const nested = yield* Effect.forEach(
      names
        .filter((name) => !name.startsWith(".") && !IGNORED_DIRECTORIES.has(name))
        .slice(0, MAX_PROBED_SUBDIRECTORIES),
      (name) =>
        fileSystem.readDirectory(path.join(root, name)).pipe(Effect.orElseSucceed(() => [])),
      { concurrency: LOCATION_CONCURRENCY },
    );
    const all = [...names, ...nested.flat()];
    return LANGUAGE_ROWS.filter((row) =>
      all.some((name) => row.restartsOn(name) || languageForPath(name)?.row === row),
    );
  });

  /** The languages a workspace-wide question goes to: the running ones and the ones the root shows. */
  const workspaceRows = Effect.fnUntraced(function* (root: string, languageId: string | undefined) {
    if (languageId !== undefined) {
      const row = languageRow(languageId);
      return row === undefined
        ? yield* fail("unsupported_language", "No language server handles this language.")
        : [row];
    }
    const snapshots = yield* Effect.forEach(LANGUAGE_ROWS, (row) => pool.snapshot(row, root));
    const running = snapshots
      .filter(({ state }) => state === "starting" || state === "indexing" || state === "ready")
      .map(({ row }) => row);
    if (running.length === LANGUAGE_ROWS.length) return running;
    const detected = yield* detectRows(root);
    return LANGUAGE_ROWS.filter((row) => running.includes(row) || detected.includes(row));
  });

  const workspaceSymbols: CodeIntel["Service"]["workspaceSymbols"] = Effect.fn(
    "CodeIntel.workspaceSymbols",
  )(function* (input) {
    const deadline = yield* startDeadline(SEARCH_DEADLINE);
    const { root, rows } = yield* Effect.gen(function* () {
      const root = yield* resolveRoot(input.cwd);
      return { root, rows: yield* workspaceRows(root, input.languageId) };
    }).pipe(within(deadline));
    const kinds = input.kinds === undefined ? undefined : new Set(input.kinds);
    const perRow = yield* Effect.forEach(
      rows,
      (row) =>
        withServer(row, root, deadline, (live, send) =>
          Effect.gen(function* () {
            if (!supports(live, "workspaceSymbolProvider")) return [];
            yield* loadProjects(live);
            const answer = yield* askUntilLoaded(
              live,
              send("workspace/symbol", { query: input.query }),
              isEmptyAnswer,
            );
            const matching = LspResults.toWorkspaceSymbols(answer).filter(
              (symbol) => kinds === undefined || kinds.has(symbol.kind),
            );
            // One more than the limit, so truncation shows without locating every hit.
            const ranked = LspResults.rankWorkspaceSymbols(matching, input.query).slice(
              0,
              input.limit + 1,
            );
            const locations = yield* locateEach(
              live,
              ranked.map((symbol) => symbol.location),
              { lineText: false, names: ranked.map((symbol) => symbol.name) },
            );
            const located = ranked.map((symbol, index) => {
              const location = locations[index];
              return location === undefined
                ? undefined
                : ({
                    name: symbol.name,
                    kind: symbol.kind,
                    ...(symbol.containerName === undefined
                      ? {}
                      : { containerName: symbol.containerName }),
                    location,
                  } satisfies CodeWorkspaceSymbol);
            });
            return located.filter((symbol) => symbol !== undefined);
          }),
        ).pipe(Effect.result),
      { concurrency: "unbounded" },
    );
    const answered = perRow.flatMap((result) =>
      result._tag === "Success" ? [result.success] : [],
    );
    // A language that cannot answer leaves the others' answers; the status chip says why.
    const failure = perRow.find((result) => result._tag === "Failure");
    if (answered.length === 0 && failure !== undefined) return yield* failure.failure;
    const merged = LspResults.rankWorkspaceSymbols(answered.flat(), input.query);
    return { symbols: merged.slice(0, input.limit), truncated: merged.length > input.limit };
  });

  const existingDirectory = (directory: string) =>
    fileSystem.stat(directory).pipe(
      Effect.map((stat) => stat.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const serverStatus = Effect.fnUntraced(function* (row: LanguageRow, root: string) {
    const snapshot = yield* pool.snapshot(row, root);
    const messages = snapshot.message === undefined ? [] : [snapshot.message];
    const libraryRoots: Array<CodeLibraryRoot> = [];
    let interpreter: CodeServerStatus["interpreter"];
    if (row.id === "python") {
      const python = snapshot.live?.context.python ?? (yield* pythonEnvironment.locate(root));
      interpreter = python.interpreter;
      libraryRoots.push(...python.libraryRoots);
      // ty unpacks its bundled stubs here; `declaration`-style answers point into it.
      const stubs = path.join(
        hostEnvironment.XDG_CACHE_HOME ?? path.join(home, ".cache"),
        "ty",
        "vendored",
        "typeshed",
      );
      if (yield* existingDirectory(stubs)) {
        libraryRoots.push({ path: stubs, label: "typeshed stubs", kind: "stubs" });
      }
      if (snapshot.state !== "unavailable" && snapshot.state !== "failed") {
        if (python.problem === "setting_path_missing") {
          messages.push("The Python environment set for this project does not exist.");
        } else if (python.source === "none") {
          messages.push(
            "No Python environment was found: only the standard library and stubs resolve.",
          );
        }
      }
    } else {
      // A package's own `node_modules` resolves before the root's, so each is a library root.
      for (const nodeModules of yield* typeScriptProjects.nodeModulesRoots(root)) {
        const label = path.relative(root, nodeModules).split(path.sep).join("/");
        libraryRoots.push({ path: nodeModules, label, kind: "node_modules" });
      }
    }
    if (
      snapshot.live !== undefined &&
      (yield* snapshot.live.session.watchState).mode === "fallback"
    ) {
      messages.push(
        "This project has too many folders to watch: changes on disk are picked up when an answer points at them.",
      );
    }
    // A virtualenv's files name these roots, so a workspace could point one at the server's own state.
    const readableRoots: Array<CodeLibraryRoot> = [];
    for (const libraryRoot of libraryRoots) {
      if (!(yield* isServerInternalPath(libraryRoot.path))) readableRoots.push(libraryRoot);
    }
    return {
      languageId: row.id,
      name: snapshot.name,
      ...(snapshot.version === undefined ? {} : { version: snapshot.version }),
      state: snapshot.state,
      ...(messages.length === 0 ? {} : { message: messages.join(" ") }),
      ...(interpreter === undefined ? {} : { interpreter }),
      libraryRoots: readableRoots,
    } satisfies CodeServerStatus;
  });

  const statusOf = Effect.fnUntraced(function* (root: string) {
    return {
      enabled: yield* pool.isEnabled,
      servers: yield* Effect.forEach(LANGUAGE_ROWS, (row) => serverStatus(row, root)),
    };
  });

  const status: CodeIntel["Service"]["status"] = Effect.fn("CodeIntel.status")(function* (input) {
    const root = yield* resolveRoot(input.cwd);
    return yield* statusOf(root);
  }, boundedBy(POSITION_DEADLINE));

  const installServer: CodeIntel["Service"]["installServer"] = Effect.fn("CodeIntel.installServer")(
    function* (input) {
      if (languageRow(input.languageId) === undefined) {
        return yield* fail("unsupported_language", "No language server handles this language.");
      }
      yield* pool.assertEnabled;
      return yield* binaries.install(input.languageId).pipe(
        Effect.match({
          onSuccess: (): CodeIntelInstallServerResult => ({ state: "stopped" }),
          // An install that fails leaves nothing behind; the message says which step failed.
          onFailure: (error): CodeIntelInstallServerResult => ({
            state: "unavailable",
            message: error.message,
          }),
        }),
      );
    },
  );

  const restart: CodeIntel["Service"]["restart"] = Effect.fn("CodeIntel.restart")(function* (
    input,
  ) {
    const root = yield* resolveRoot(input.cwd);
    if (input.languageId !== undefined && languageRow(input.languageId) === undefined) {
      return yield* fail("unsupported_language", "No language server handles this language.");
    }
    yield* pool.restart(root, input.languageId);
    return yield* statusOf(root);
  }, boundedBy(POSITION_DEADLINE));

  return CodeIntel.of({
    status,
    definition,
    references,
    documentHighlights,
    hover,
    documentSymbols,
    workspaceSymbols,
    semanticTokens,
    installServer,
    restart,
  });
});

export const layer = Layer.effect(CodeIntel, make);
