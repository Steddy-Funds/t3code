// @effect-diagnostics nodeBuiltinImport:off -- The Glint helper is a long-lived native child process that speaks NDJSON over stdio.
// @effect-diagnostics globalTimers:off -- The ready deadline runs in child-process callbacks outside any Effect fiber.

import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import type {
  DesktopGlintAnchor,
  DesktopGlintKind,
  DesktopGlintMessage,
  DesktopGlintOutcome,
} from "@t3tools/contracts";

// Version 2 adds `input` to `ready`: the keys and clicks T3 forwards while a dialog is up.
const PROTOCOL_VERSIONS: ReadonlySet<unknown> = new Set([1, 2]);
const DEFAULT_READY_TIMEOUT_MS = 5_000;
/** How long a forwarded Return or Escape may go unanswered before T3 closes the dialog itself. */
const GLINT_INPUT_WATCHDOG_MS = 3_000;
// The protocol's own lifecycle; every other message is a dialog's, passed through untouched.
const LIFECYCLE_TYPES: ReadonlySet<string> = new Set([
  "ready",
  "present",
  "result",
  "cancelled",
  "error",
]);

export interface GlintHelper {
  readonly path: string;
  /** `anchor` is in global screen points with a top-left origin. One dialog shows at a time. */
  readonly present: (
    id: string,
    kind: DesktopGlintKind,
    anchor: DesktopGlintAnchor,
    params: unknown,
  ) => Promise<DesktopGlintOutcome>;
  /** Sends a message such as `update`, `input`, `key` or `dismiss` to the open dialog `id`. */
  readonly send: (message: DesktopGlintMessage) => boolean;
  /**
   * Input T3 swallowed while dialog `id` is up. Forwarded when the helper lists its type in
   * `ready.input`; otherwise Escape dismisses and the rest is dropped.
   */
  readonly sendInput: (message: GlintInputMessage) => boolean;
  readonly dispose: () => void;
}

export type GlintInputMessage =
  | {
      readonly type: "key";
      readonly id: string;
      readonly key: string;
      readonly text?: string;
      readonly modifiers?: ReadonlyArray<string>;
    }
  | { readonly type: "click"; readonly id: string };

interface Pending {
  readonly id: string;
  readonly resolve: (outcome: DesktopGlintOutcome) => void;
  /** Messages sent before the helper was ready, written after `present`. */
  queue: Array<{ readonly message: DesktopGlintMessage; readonly input: boolean }> | null;
  watchdog: ReturnType<typeof setTimeout> | null;
}

/** Spawns the helper on the first `present`, and again after it exits. */
export function makeGlintHelper(
  path: string,
  options: {
    readonly readyTimeoutMs?: number;
    readonly watchdogMs?: number;
    readonly log?: (message: string) => void;
    /** The open dialog's own messages, such as `changed`. */
    readonly onEvent?: (message: DesktopGlintMessage) => void;
  } = {},
): GlintHelper {
  const log = options.log ?? (() => {});
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  let ready: Promise<string | null> | null = null;
  let current: Pending | null = null;
  let disposed = false;
  /** What the running helper takes from `sendInput`, per its `ready`. */
  let inputTypes: ReadonlySet<string> = new Set();

  const settle = (id: string, outcome: DesktopGlintOutcome) => {
    if (current?.id !== id) return;
    const pending = current;
    current = null;
    if (pending.watchdog) clearTimeout(pending.watchdog);
    pending.resolve(outcome);
  };

  const write = (message: object) => {
    if (!child?.stdin.writable) return false;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  };

  const handleMessage = (message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    const { type, id } = message as { type?: unknown; id?: unknown };
    // A line the helper could not read (a malformed `key` or `click`) belongs to no dialog.
    if (type === "error" && id === null) {
      log(`glint: protocol warning: ${String((message as { message?: unknown }).message)}`);
      return;
    }
    if (typeof id !== "string" || typeof type !== "string") return;
    if (!LIFECYCLE_TYPES.has(type)) {
      if (current?.id === id) options.onEvent?.(message as DesktopGlintMessage);
      return;
    }
    if (type === "result") {
      settle(id, { type: "result", value: (message as { value?: unknown }).value ?? null });
    } else if (type === "cancelled") {
      settle(id, { type: "cancelled" });
    } else if (type === "error") {
      const text = (message as { message?: unknown }).message;
      settle(id, {
        type: "unavailable",
        message: typeof text === "string" ? text : "The Glint helper reported an error.",
      });
    }
  };

  function send(message: DesktopGlintMessage): boolean {
    const pending = current;
    if (pending?.id !== message.id || LIFECYCLE_TYPES.has(message.type)) return false;
    if (message.type === "click") return sendInput({ type: "click", id: message.id });
    if (pending.queue) {
      pending.queue.push({ message, input: false });
      if (message.type === "dismiss") settle(message.id, { type: "cancelled" });
      return true;
    }
    if (!write(message)) return false;
    if (message.type === "dismiss") settle(message.id, { type: "cancelled" });
    return true;
  }

  function sendInput(message: GlintInputMessage): boolean {
    const pending = current;
    if (pending?.id !== message.id) return false;
    if (pending.queue) {
      pending.queue.push({ message, input: true });
      return true;
    }
    if (!inputTypes.has(message.type)) {
      return message.type === "key" && message.key === "escape"
        ? send({ type: "dismiss", id: message.id })
        : false;
    }
    if (!write(message)) return false;
    // These should close the dialog; a helper that never answers must not leave T3 locked.
    if (message.type === "key" && (message.key === "return" || message.key === "escape")) {
      pending.watchdog ??= setTimeout(() => {
        if (current !== pending) return;
        write({ type: "dismiss", id: pending.id });
        settle(pending.id, { type: "cancelled" });
      }, options.watchdogMs ?? GLINT_INPUT_WATCHDOG_MS);
    }
    return true;
  }

  /** Resolves null once ready, or the reason it could not start. */
  const start = (): Promise<string | null> => {
    if (ready) return ready;
    let proc: NodeChildProcess.ChildProcessWithoutNullStreams;
    try {
      proc = NodeChildProcess.spawn(path, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      return Promise.resolve(`Could not start the Glint helper: ${String(error)}`);
    }
    child = proc;
    ready = new Promise((resolve) => {
      let started = false;
      const stop = (reason: string) => {
        clearTimeout(timer);
        if (child === proc) {
          child = null;
          ready = null;
        }
        if (!started) {
          resolve(reason);
          return;
        }
        if (current) settle(current.id, { type: "unavailable", message: reason });
      };
      const timer = setTimeout(() => {
        stop("The Glint helper did not report ready.");
        proc.kill();
      }, options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);

      NodeReadline.createInterface({ input: proc.stdout }).on("line", (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          log(`glint: ignored a line that is not JSON: ${line.slice(0, 200)}`);
          return;
        }
        if (!started && (message as { type?: unknown } | null)?.type === "ready") {
          const version = (message as { version?: unknown }).version;
          if (!PROTOCOL_VERSIONS.has(version)) {
            stop(`The Glint helper speaks protocol ${String(version)}, not 1 or 2.`);
            proc.kill();
            return;
          }
          const input = (message as { input?: unknown }).input;
          inputTypes = new Set(
            version === 2 && Array.isArray(input)
              ? input.filter((type): type is string => typeof type === "string")
              : [],
          );
          started = true;
          clearTimeout(timer);
          resolve(null);
          return;
        }
        handleMessage(message);
      });
      proc.stderr.on("data", (chunk: Buffer) => log(`glint: ${chunk.toString().trimEnd()}`));
      // A write after the helper exits raises EPIPE here; exit reports it.
      proc.stdin.on("error", () => {});
      proc.on("error", (error) => stop(`The Glint helper failed: ${error.message}`));
      proc.on("exit", (code, signal) =>
        stop(`The Glint helper exited (${signal ?? `code ${String(code)}`}).`),
      );
    });
    return ready;
  };

  return {
    path,
    present: (id, kind, anchor, params) => {
      if (disposed) {
        return Promise.resolve({ type: "unavailable", message: "The Glint helper was stopped." });
      }
      // The helper closes the old dialog itself when a new one is presented.
      if (current) settle(current.id, { type: "cancelled" });
      const { promise: outcome, resolve } = Promise.withResolvers<DesktopGlintOutcome>();
      const pending: Pending = { id, resolve, queue: [], watchdog: null };
      current = pending;
      void start().then((failure) => {
        if (current !== pending) return;
        if (failure !== null) {
          settle(id, { type: "unavailable", message: failure });
          return;
        }
        if (!write({ type: "present", id, kind, anchor, params })) {
          settle(id, { type: "unavailable", message: "The Glint helper is not running." });
          return;
        }
        const queued = pending.queue ?? [];
        pending.queue = null;
        for (const entry of queued) {
          if (entry.input) sendInput(entry.message as GlintInputMessage);
          else send(entry.message);
        }
      });
      return outcome;
    },
    send,
    sendInput,
    dispose: () => {
      disposed = true;
      if (current) settle(current.id, { type: "cancelled" });
      child?.stdin.end();
      child?.kill();
      child = null;
      ready = null;
    },
  };
}

/** Converts a renderer rect (CSS px, viewport-relative) to global screen points. */
export function toScreenAnchor(
  rect: DesktopGlintAnchor,
  contentBounds: { readonly x: number; readonly y: number },
  zoomFactor: number,
): DesktopGlintAnchor {
  return {
    x: Math.round(contentBounds.x + rect.x * zoomFactor),
    y: Math.round(contentBounds.y + rect.y * zoomFactor),
    width: Math.round(rect.width * zoomFactor),
    height: Math.round(rect.height * zoomFactor),
  };
}
