// @effect-diagnostics nodeBuiltinImport:off -- The Glint helper is a long-lived native child process that speaks NDJSON over stdio.
// @effect-diagnostics globalTimers:off -- The ready deadline runs in child-process callbacks outside any Effect fiber.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";

import type { DesktopGlintAnchor, DesktopGlintKind, DesktopGlintOutcome } from "@t3tools/contracts";

const PROTOCOL_VERSION = 1;
const DEFAULT_READY_TIMEOUT_MS = 5_000;

export interface GlintHelper {
  readonly path: string;
  /** `anchor` is in global screen points with a top-left origin. One dialog shows at a time. */
  readonly present: (
    kind: DesktopGlintKind,
    anchor: DesktopGlintAnchor,
    params: unknown,
  ) => Promise<DesktopGlintOutcome>;
  readonly dismiss: () => void;
  readonly dispose: () => void;
}

interface Pending {
  readonly id: string;
  readonly resolve: (outcome: DesktopGlintOutcome) => void;
}

/** Spawns the helper on the first `present`, and again after it exits. */
export function makeGlintHelper(
  path: string,
  options: { readonly readyTimeoutMs?: number; readonly log?: (message: string) => void } = {},
): GlintHelper {
  const log = options.log ?? (() => {});
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  let ready: Promise<string | null> | null = null;
  let current: Pending | null = null;
  let disposed = false;

  const settle = (id: string, outcome: DesktopGlintOutcome) => {
    if (current?.id !== id) return;
    const pending = current;
    current = null;
    pending.resolve(outcome);
  };

  const send = (message: object) => {
    if (!child?.stdin.writable) return false;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  };

  const handleMessage = (message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    const { type, id } = message as { type?: unknown; id?: unknown };
    if (typeof id !== "string") return;
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
          if (version !== PROTOCOL_VERSION) {
            stop(`The Glint helper speaks protocol ${String(version)}, not ${PROTOCOL_VERSION}.`);
            proc.kill();
            return;
          }
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
    present: async (kind, anchor, params) => {
      if (disposed) return { type: "unavailable", message: "The Glint helper was stopped." };
      const failure = await start();
      if (failure !== null) return { type: "unavailable", message: failure };
      // The helper closes the old dialog itself when a new one is presented.
      if (current) settle(current.id, { type: "cancelled" });
      const id = NodeCrypto.randomUUID();
      return new Promise((resolve) => {
        current = { id, resolve };
        if (!send({ type: "present", id, kind, anchor, params })) {
          settle(id, { type: "unavailable", message: "The Glint helper is not running." });
        }
      });
    },
    dismiss: () => {
      if (!current) return;
      send({ type: "dismiss", id: current.id });
      settle(current.id, { type: "cancelled" });
    },
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
