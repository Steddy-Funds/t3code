import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/** The SDK withholds stdout until tool results; tail task_started files for live output.
 * The private Claude layout can change; failures omit live output and retain the final result. */

const CLAUDE_TASK_OUTPUT_POLL_MS = 250;
/** Bound discovery when Claude never writes the file. */
const MAX_LOCATE_ATTEMPTS = 40;
/** A host can hold thousands of project folders; past this many the search gives up and live output is omitted. */
const MAX_SCANNED_PROJECT_FOLDERS = 500;
/** Skip ahead of fast writers; only the tail is displayed. */
const MAX_READ_BYTES = 256 * 1024;

/** Claude Code's per-user temp root, or none where it has no uid (Windows). */
export function claudeTaskOutputRoot(
  environment: Readonly<Record<string, string | undefined>> | undefined,
  path: Path.Path,
  cwd: string | null,
  platform: NodeJS.Platform,
): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  // Claude Code's macOS build falls back to /tmp and ignores the TMPDIR that
  // launchd always sets. Its other builds use `os.tmpdir()`, which reads these
  // from the environment it was launched with. A relative value is relative
  // to Claude's working directory, not this server's.
  const fallback =
    platform === "darwin"
      ? "/tmp"
      : environment?.TMPDIR || environment?.TMP || environment?.TEMP || "/tmp";
  const base = environment?.CLAUDE_CODE_TMPDIR?.trim() || fallback;
  return path.resolve(cwd ?? ".", base, `claude-${uid}`);
}

/** The folder Claude Code keeps a session's temp files in, named after its working directory. */
export function claudeTaskOutputProjectFolder(cwd: string | null | undefined): string | undefined {
  return cwd == null ? undefined : cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

const locate = Effect.fn("ClaudeTaskOutputTail.locate")(function* (input: {
  readonly root: string;
  readonly projectFolder: string | undefined;
  readonly sessionId: string;
  readonly taskId: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  let session =
    input.projectFolder === undefined
      ? undefined
      : path.join(input.root, input.projectFolder, input.sessionId);
  // Claude shortens long folder names, so the session can live under a name this cannot derive.
  // Searched once, not on every poll: each folder is a filesystem call on a busy server.
  if (session === undefined || !(yield* exists(session))) {
    const projects = yield* fileSystem
      .readDirectory(input.root)
      .pipe(Effect.orElseSucceed(() => []));
    for (const project of projects.slice(0, MAX_SCANNED_PROJECT_FOLDERS)) {
      const candidate = path.join(input.root, project, input.sessionId);
      if (yield* exists(candidate)) {
        session = candidate;
        break;
      }
    }
  }
  if (session === undefined) return Option.none<string>();
  const file = path.join(session, "tasks", `${input.taskId}.output`);
  for (let attempt = 0; attempt < MAX_LOCATE_ATTEMPTS; attempt += 1) {
    if (yield* exists(file)) return Option.some(file);
    yield* Effect.sleep(CLAUDE_TASK_OUTPUT_POLL_MS);
  }
  return Option.none<string>();
});

/** Complete stop on tool result or turn end, then await the effect; it performs a final read before returning. */
export const tailClaudeTaskOutput = Effect.fn("ClaudeTaskOutputTail.tail")(function* (input: {
  readonly root: string;
  readonly projectFolder: string | undefined;
  readonly sessionId: string;
  readonly taskId: string;
  readonly stop: Deferred.Deferred<void>;
  readonly onChunk: (chunk: string) => Effect.Effect<void>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pause = Deferred.await(input.stop).pipe(
    Effect.as(true),
    Effect.timeoutOrElse({
      duration: CLAUDE_TASK_OUTPUT_POLL_MS,
      orElse: () => Effect.succeed(false),
    }),
  );
  // The caller awaits this effect after stop while it holds the session's message lock, so a
  // search still running then is dropped: the tool result carries the output anyway.
  const file = yield* Effect.raceFirst(
    locate(input),
    Deferred.await(input.stop).pipe(Effect.as(Option.none<string>())),
  );
  if (Option.isNone(file)) return;
  const filePath = file.value;
  let decoder = new TextDecoder("utf-8", { fatal: false });
  let offset = 0;
  let last = yield* Deferred.isDone(input.stop);
  while (true) {
    const size = yield* fileSystem.stat(filePath).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => offset),
    );
    if (size < offset) {
      offset = 0;
      decoder = new TextDecoder("utf-8", { fatal: false });
    }
    if (size > offset) {
      const start = size - offset > MAX_READ_BYTES ? size - MAX_READ_BYTES : offset;
      const bytes = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fileSystem.open(filePath, { flag: "r" });
          yield* handle.seek(BigInt(start), "start");
          return yield* handle.readAlloc(size - start);
        }),
      ).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      if (Option.isSome(bytes)) {
        // Skipped output must not splice two unrelated lines together.
        const skipped = start > offset;
        // Reset partial UTF-8 bytes when skipping output.
        if (skipped) decoder = new TextDecoder("utf-8", { fatal: false });
        offset = start + bytes.value.byteLength;
        const text = (skipped ? "\n" : "") + decoder.decode(bytes.value, { stream: true });
        if (text.length > 0) yield* input.onChunk(text);
      }
    }
    if (last) {
      const rest = decoder.decode();
      if (rest.length > 0) yield* input.onChunk(rest);
      return;
    }
    last = yield* pause;
  }
});
