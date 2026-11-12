// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Effect's watch cannot skip a directory, and OS file events are debounced in real time on Node callbacks.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import type * as Scope from "effect/Scope";

/**
 * Never watched, at any depth. A language server learns of third-party changes from the few
 * manifest files that signal them, so these trees cost nothing.
 */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "site-packages",
  "__pycache__",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".expo",
  ".gradle",
  "Pods",
  ".t3",
  // Vendored read-only references, as this repository keeps them: 3,898 of its 4,673 folders.
  ".repos",
]);

/** One inotify watch a directory on Linux, from a per-user budget every dev server shares. */
export const WATCHED_DIRECTORY_CAP = 8_192;
const DEBOUNCE_MS = 150;
// A checkout or a bulk rewrite: telling the server file by file costs more than restarting it.
const PENDING_PATH_CAP = 5_000;
const LISTENER_BACKLOG = 64;

export interface WatchEvent {
  readonly path: string;
  /**
   * `created` is a path that was not there before. A file replaced by a rename, as an atomic
   * save does, is `changed`: a server told "created" about a file it knows keeps its old text.
   */
  readonly kind: "created" | "changed" | "deleted";
  readonly directory: boolean;
}

export type WatchBatch =
  | { readonly _tag: "events"; readonly events: ReadonlyArray<WatchEvent> }
  /** Too many paths changed at once to name them. */
  | { readonly _tag: "overflow" };

export interface WatchState {
  /** `fallback`: the root has more directories than the cap, or the OS refused a watch. */
  readonly mode: "watching" | "fallback";
  /** OS watches held: one a directory on Linux, one a tree on macOS and Windows. */
  readonly directories: number;
}

export interface WorkspaceWatch {
  readonly state: Effect.Effect<WatchState>;
  /** Runs `listener` for each debounced batch until the scope closes. */
  readonly listen: (
    listener: (batch: WatchBatch) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

interface TreeWatcherOptions {
  readonly root: string;
  /** macOS and Windows watch a tree natively; Linux needs one watch a directory. */
  readonly strategy: "native-recursive" | "per-directory" | "shallow";
  readonly directoryCap: number;
  readonly onBatch: (batch: WatchBatch) => void;
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

class TreeWatcher {
  private readonly watchers = new Map<string, NodeFS.FSWatcher>();
  private readonly pending = new Map<string, "rename" | "change">();
  /** Every file and directory seen, so a replaced file is told apart from a new one. */
  private readonly knownFiles = new Set<string>();
  private readonly knownDirectories = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  /** One flush at a time: the next waits for the lstats of the one before. */
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;
  private overflowed = false;
  private readonly options: TreeWatcherOptions;
  mode: WatchState["mode"] = "watching";

  constructor(options: TreeWatcherOptions) {
    this.options = options;
  }

  get directories(): number {
    return this.watchers.size;
  }

  async start(): Promise<void> {
    const { root, strategy } = this.options;
    if (strategy === "native-recursive" && !this.watch(root, true)) return;
    await this.walk(root, false);
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.forget();
  }

  private forget(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.pending.clear();
    this.knownFiles.clear();
    this.knownDirectories.clear();
  }

  private fallBack(): void {
    this.mode = "fallback";
    this.forget();
  }

  private watch(directory: string, recursive: boolean): boolean {
    if (this.watchers.has(directory)) return true;
    try {
      const watcher = NodeFS.watch(directory, { persistent: false, recursive }, (type, name) =>
        this.note(directory, type, name),
      );
      // A watch that broke on a directory still there would miss its changes from now on.
      watcher.on("error", () => {
        this.unwatch(directory);
        void NodeFSP.lstat(directory).then(
          () => {
            if (!this.closed) this.fallBack();
          },
          () => undefined,
        );
      });
      this.watchers.set(directory, watcher);
      return true;
    } catch (error) {
      // Out of inotify watches or descriptors; any other failure is a directory that just went away.
      if (errorCode(error) === "ENOSPC" || errorCode(error) === "EMFILE") {
        this.fallBack();
        return false;
      }
      return true;
    }
  }

  private unwatch(directory: string): void {
    this.watchers.get(directory)?.close();
    this.watchers.delete(directory);
  }

  /** Learns a tree's entries and, on Linux, watches each directory. Past the cap the root is given up. */
  private async walk(directory: string, reportFiles: boolean): Promise<void> {
    const { strategy, directoryCap } = this.options;
    const queue = [directory];
    while (queue.length > 0 && !this.closed && this.mode === "watching") {
      const current = queue.pop() as string;
      if (this.knownDirectories.size >= directoryCap) return this.fallBack();
      this.knownDirectories.add(current);
      if (strategy !== "native-recursive" && !this.watch(current, false)) return;
      const entries = await NodeFSP.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const entryPath = NodePath.join(current, entry.name);
        if (entry.isDirectory()) {
          if (strategy !== "shallow" && !IGNORED_DIRECTORIES.has(entry.name)) queue.push(entryPath);
        } else if (reportFiles) {
          this.pending.set(entryPath, "rename");
        } else {
          this.knownFiles.add(entryPath);
        }
      }
    }
    if (reportFiles) this.schedule();
  }

  private note(directory: string, type: string, name: string | Buffer | null): void {
    if (this.closed || name === null) return;
    const relative = String(name);
    if (relative.split(NodePath.sep).some((segment) => IGNORED_DIRECTORIES.has(segment))) return;
    const changedPath = NodePath.join(directory, relative);
    if (this.pending.size >= PENDING_PATH_CAP) {
      this.overflowed = true;
    } else {
      const strongest = type === "rename" || this.pending.get(changedPath) === "rename";
      this.pending.set(changedPath, strongest ? "rename" : "change");
    }
    this.schedule();
  }

  // Timed from a batch's first change, so a steady stream of writes still reaches the server.
  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushing = this.flushing.then(() => this.flush());
    }, DEBOUNCE_MS);
    this.timer.unref();
  }

  private async flush(): Promise<void> {
    if (this.closed) return;
    const batch = [...this.pending];
    this.pending.clear();
    if (this.overflowed) {
      this.overflowed = false;
      this.options.onBatch({ _tag: "overflow" });
      return;
    }
    const events: Array<WatchEvent> = [];
    for (const [changedPath, type] of batch) {
      const stat = await NodeFSP.lstat(changedPath).catch(() => undefined);
      if (this.closed || this.mode !== "watching") return;
      if (stat === undefined) {
        const directory = this.forgetUnder(changedPath);
        events.push({ path: changedPath, kind: "deleted", directory });
      } else if (!stat.isDirectory()) {
        const known = this.knownFiles.has(changedPath);
        this.knownFiles.add(changedPath);
        events.push({ path: changedPath, kind: known ? "changed" : "created", directory: false });
      } else if (type === "rename" && !this.knownDirectories.has(changedPath)) {
        // A directory's own `change` is its entries changing; they report themselves.
        events.push({ path: changedPath, kind: "created", directory: true });
        if (this.options.strategy !== "shallow") await this.walk(changedPath, true);
      }
    }
    if (events.length > 0 && !this.closed) this.options.onBatch({ _tag: "events", events });
  }

  /** Drops what was known at and under a deleted path, and says whether it was a directory. */
  private forgetUnder(deleted: string): boolean {
    this.knownFiles.delete(deleted);
    if (!this.knownDirectories.has(deleted)) return false;
    const prefix = deleted + NodePath.sep;
    const under = (known: string) => known === deleted || known.startsWith(prefix);
    for (const directory of [...this.knownDirectories].filter(under)) {
      this.knownDirectories.delete(directory);
      this.unwatch(directory);
    }
    for (const file of [...this.knownFiles].filter(under)) this.knownFiles.delete(file);
    return true;
  }
}

export class WorkspaceWatcher extends Context.Service<
  WorkspaceWatcher,
  {
    /** One watcher a root, shared by every language server of it and closed with the last. */
    readonly watchTree: (root: string) => Effect.Effect<WorkspaceWatch, never, Scope.Scope>;
    /** One directory, not its subdirectories: a virtualenv's `pyvenv.cfg` outside the tree. */
    readonly watchDirectory: (
      directory: string,
    ) => Effect.Effect<WorkspaceWatch, never, Scope.Scope>;
  }
>()("t3/codeIntel/WorkspaceWatcher") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const treeStrategy =
    platform === "darwin" || platform === "win32" ? "native-recursive" : "per-directory";

  const open = Effect.fn("WorkspaceWatcher.open")(function* (
    root: string,
    strategy: TreeWatcherOptions["strategy"],
  ) {
    const listeners = new Set<Queue.Queue<WatchBatch>>();
    const watcher = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new TreeWatcher({
            root,
            strategy,
            directoryCap: WATCHED_DIRECTORY_CAP,
            // Called from a Node callback: an unsafe offer needs no runtime.
            onBatch: (batch) => {
              for (const listener of listeners) Queue.offerUnsafe(listener, batch);
            },
          }),
      ),
      (opened) => Effect.sync(() => opened.close()),
    );
    // The walk of a large tree takes seconds; a start never waits for it.
    yield* Effect.promise(() => watcher.start()).pipe(Effect.forkScoped);

    const watch: WorkspaceWatch = {
      state: Effect.sync(() => ({ mode: watcher.mode, directories: watcher.directories })),
      listen: Effect.fn("WorkspaceWatcher.listen")(function* (listener) {
        const queue = yield* Queue.sliding<WatchBatch>(LISTENER_BACKLOG);
        yield* Effect.acquireRelease(
          Effect.sync(() => listeners.add(queue)),
          () => Effect.sync(() => listeners.delete(queue)),
        );
        yield* Queue.take(queue).pipe(Effect.flatMap(listener), Effect.forever, Effect.forkScoped);
      }),
    };
    return watch;
  });

  const trees = yield* RcMap.make({ lookup: (root: string) => open(root, treeStrategy) });

  return WorkspaceWatcher.of({
    watchTree: Effect.fn("WorkspaceWatcher.watchTree")((root) => RcMap.get(trees, root)),
    watchDirectory: Effect.fn("WorkspaceWatcher.watchDirectory")((directory) =>
      open(directory, "shallow"),
    ),
  });
});

export const layer = Layer.effect(WorkspaceWatcher, make);
