// @effect-diagnostics nodeBuiltinImport:off -- a stat by path, for files an answer points at.
import * as NodeFSP from "node:fs/promises";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { LanguageContext, LanguageRow } from "./LanguageRegistry.ts";
import { pathToUri, type RunningLanguageServer } from "./LanguageServerProcess.ts";
import type { LspConnectionClosedError } from "./LspConnection.ts";
import * as WorkspaceWatcher from "./WorkspaceWatcher.ts";

/** A server holds parse state for each open document, so only recently asked-about files stay open. */
const MAX_OPEN_DOCUMENTS = 24;
// A sync takes every permit; a request against the synced text takes one.
const DOCUMENT_PERMITS = 64;
const MAX_CHECKED_ANSWER_FILES = 64;
const MAX_REMEMBERED_ANSWER_FILES = 4_096;

const FILE_CHANGED = 2;
const FILE_DELETED = 3;
// LSP's FileChangeType.
const FILE_CHANGE_TYPES = { created: 1, changed: FILE_CHANGED, deleted: FILE_DELETED } as const;

interface OpenDocument {
  readonly uri: string;
  readonly lock: Semaphore.Semaphore;
  open: boolean;
  version: number;
  revision: string;
  lastUsedAt: number;
}

export interface SessionDocument {
  /** Symlinks resolved; the server is told this path. */
  readonly realPath: string;
  readonly documentLanguageId: string;
  /** The file's text as read from disk for this request. */
  readonly text: string;
  readonly revision: string;
}

export interface ServerSession {
  /**
   * Gives the server `document.text` when it holds another text, then runs `use`. The server
   * holds exactly that text for as long as `use` runs, so the answer belongs to `revision`.
   */
  readonly withDocument: <A, E>(
    document: SessionDocument,
    use: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | LspConnectionClosedError>;
  readonly watchState: Effect.Effect<WorkspaceWatcher.WatchState>;
  /**
   * Without a watcher an edit on disk is invisible to the server. Checks the files an answer
   * points at, tells the server about the changed ones, and says whether to ask again.
   */
  readonly refreshChangedFiles: (paths: ReadonlyArray<string>) => Effect.Effect<boolean>;
}

export interface ServerSessionOptions {
  readonly server: RunningLanguageServer;
  readonly row: LanguageRow;
  readonly context: LanguageContext;
  /** Third-party code changed, or too much changed to name: the server should start over. */
  readonly requestRestart: Effect.Effect<void>;
}

export const make = Effect.fn("ServerSession.make")(function* (
  options: ServerSessionOptions,
): Effect.fn.Return<
  ServerSession,
  never,
  Scope.Scope | WorkspaceWatcher.WorkspaceWatcher | Path.Path
> {
  const { server, row, context } = options;
  const watcher = yield* WorkspaceWatcher.WorkspaceWatcher;
  const path = yield* Path.Path;
  const sessionScope = yield* Effect.scope;
  const documents = new Map<string, OpenDocument>();
  const answerFileStats = new Map<string, string>();

  const closeHeld = (document: OpenDocument) =>
    Effect.suspend(() => {
      if (documents.get(document.uri) === document) documents.delete(document.uri);
      if (!document.open) return Effect.void;
      document.open = false;
      return Effect.ignore(
        server.notify("textDocument/didClose", { textDocument: { uri: document.uri } }),
      );
    });

  const close = (document: OpenDocument) =>
    document.lock.withPermits(DOCUMENT_PERMITS)(closeHeld(document));

  const closeLeastRecentlyUsed = (keep: OpenDocument) =>
    Effect.suspend(() => {
      if (documents.size <= MAX_OPEN_DOCUMENTS) return Effect.void;
      let oldest: OpenDocument | undefined;
      for (const candidate of documents.values()) {
        if (candidate === keep) continue;
        if (oldest === undefined || candidate.lastUsedAt < oldest.lastUsedAt) oldest = candidate;
      }
      return oldest === undefined ? Effect.void : close(oldest);
    });

  const sync = Effect.fnUntraced(function* (open: OpenDocument, document: SessionDocument) {
    if (open.open && open.revision === document.revision) return;
    if (open.open) {
      open.version += 1;
      yield* server.notify("textDocument/didChange", {
        textDocument: { uri: open.uri, version: open.version },
        contentChanges: [{ text: document.text }],
      });
    } else {
      yield* server.notify("textDocument/didOpen", {
        textDocument: {
          uri: open.uri,
          languageId: document.documentLanguageId,
          version: open.version,
          text: document.text,
        },
      });
      open.open = true;
      yield* server.noteDocumentOpened;
    }
    open.revision = document.revision;
  });

  const entryFor = (uri: string) => {
    let entry = documents.get(uri);
    if (entry === undefined) {
      entry = {
        uri,
        lock: Semaphore.makeUnsafe(DOCUMENT_PERMITS),
        open: false,
        version: 1,
        revision: "",
        lastUsedAt: 0,
      };
      documents.set(uri, entry);
    }
    return entry;
  };

  const withDocument: ServerSession["withDocument"] = Effect.fnUntraced(function* (document, use) {
    const uri = pathToUri(document.realPath);
    // A close can remove the entry while a request waits on its lock: that request starts over
    // on the entry that replaced it, so the server never holds two copies of one document.
    while (true) {
      const current = entryFor(uri);
      current.lastUsedAt = yield* Clock.currentTimeMillis;
      const owned = () => documents.get(uri) === current;
      const holdsRevision = () => owned() && current.open && current.revision === document.revision;

      if (holdsRevision()) {
        const shared = yield* current.lock.withPermits(1)(
          Effect.suspend(() =>
            holdsRevision() ? Effect.asSome(use) : Effect.succeed(Option.none<never>()),
          ),
        );
        if (Option.isSome(shared)) return shared.value;
      }
      const exclusive = yield* current.lock.withPermits(DOCUMENT_PERMITS)(
        Effect.suspend(() =>
          owned()
            ? sync(current, document).pipe(
                Effect.andThen(Effect.forkIn(closeLeastRecentlyUsed(current), sessionScope)),
                Effect.andThen(Effect.asSome(use)),
              )
            : Effect.succeed(Option.none<never>()),
        ),
      );
      if (Option.isSome(exclusive)) return exclusive.value;
    }
  });

  const notifyChanged = (
    changes: ReadonlyArray<{ readonly uri: string; readonly type: number }>,
  ) =>
    changes.length === 0
      ? Effect.void
      : Effect.ignore(server.notify("workspace/didChangeWatchedFiles", { changes }));

  // An open document hides the file on disk from the server: closing it makes the disk the
  // truth again. A document a request holds is closed after it: that request read its text from
  // disk, and waiting here could wait on a request that waits on this one.
  const closeIfOpen = (uri: string) => {
    const open = documents.get(uri);
    if (open === undefined) return Effect.void;
    return open.lock
      .withPermitsIfAvailable(DOCUMENT_PERMITS)(closeHeld(open))
      .pipe(
        Effect.flatMap((closed) =>
          Option.isSome(closed)
            ? Effect.void
            : Effect.asVoid(Effect.forkIn(close(open), sessionScope)),
        ),
      );
  };

  const onBatch = Effect.fnUntraced(function* (batch: WorkspaceWatcher.WatchBatch) {
    if (batch._tag === "overflow") return yield* options.requestRestart;
    const changes: Array<{ uri: string; type: number }> = [];
    for (const event of batch.events) {
      const name = path.basename(event.path);
      if (row.restartsOn(name)) return yield* options.requestRestart;
      // A directory the server never hears about keeps its old entries resolvable.
      if (!event.directory && !row.watches(name)) continue;
      const uri = pathToUri(event.path);
      yield* closeIfOpen(uri);
      changes.push({ uri, type: FILE_CHANGE_TYPES[event.kind] });
    }
    yield* notifyChanged(changes);
  });

  const tree = yield* watcher.watchTree(context.root);
  yield* tree.listen(onBatch);
  const environment = context.python?.environment;
  if (environment !== undefined) {
    // The virtualenv is skipped by the tree watch, or lies outside it: its `pyvenv.cfg` alone is watched.
    const environmentWatch = yield* watcher.watchDirectory(environment);
    yield* environmentWatch.listen(onBatch);
  }

  const refreshChangedFiles: ServerSession["refreshChangedFiles"] = Effect.fnUntraced(
    function* (paths) {
      if ((yield* tree.state).mode === "watching") return false;
      const changes: Array<{ uri: string; type: number }> = [];
      for (const filePath of [...new Set(paths)].slice(0, MAX_CHECKED_ANSWER_FILES)) {
        const stat = yield* Effect.promise(() => NodeFSP.stat(filePath).catch(() => undefined));
        const signature = stat === undefined ? "missing" : `${stat.mtimeMs}:${stat.size}`;
        const known = answerFileStats.get(filePath);
        if (answerFileStats.size >= MAX_REMEMBERED_ANSWER_FILES) answerFileStats.clear();
        answerFileStats.set(filePath, signature);
        // A file first seen here may have changed after the server last read it.
        const unchanged =
          known === undefined
            ? stat !== undefined && stat.mtimeMs < server.startedAt
            : known === signature;
        if (unchanged) continue;
        const uri = pathToUri(filePath);
        yield* closeIfOpen(uri);
        changes.push({ uri, type: stat === undefined ? FILE_DELETED : FILE_CHANGED });
      }
      yield* notifyChanged(changes);
      return changes.length > 0;
    },
  );

  return { withDocument, watchState: tree.state, refreshChangedFiles };
});
