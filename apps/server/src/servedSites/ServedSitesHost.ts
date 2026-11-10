/**
 * The machine a served site touches: tailscale, the public hook, and processes. Each is a service
 * so ServedSites can be tested without a tailnet, a hook script, or real processes.
 */
import {
  ServedSiteError,
  type ResourceMonitorProcessTableEntry,
  type ServedSiteProcess,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Net from "@t3tools/shared/Net";
import {
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleServeRoutes,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as PortScanner from "../preview/PortScanner.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import { stoppableProcessTree, type TreeMember } from "./rules.ts";

const failed = (detail: string) => new ServedSiteError({ reason: "failed", detail });
const unavailable = (detail: string) => new ServedSiteError({ reason: "unavailable", detail });

const tailscaleDetail = (error: {
  readonly message: string;
  readonly stderrDiagnostic?: string;
}) =>
  error.stderrDiagnostic === undefined
    ? error.message
    : `${error.message} (${error.stderrDiagnostic})`;

export interface ServeRoutes {
  readonly ports: ReadonlySet<number>;
  /** Whether the route on `servePort` proxies to 127.0.0.1:`localPort`. */
  readonly proxies: (servePort: number, localPort: number) => boolean;
}

export class SiteTailscale extends Context.Service<
  SiteTailscale,
  {
    /** Fails when tailscale is missing, signed out, or has MagicDNS off. */
    readonly magicDnsName: Effect.Effect<string, ServedSiteError>;
    readonly routes: Effect.Effect<ServeRoutes, ServedSiteError>;
    readonly serve: (input: {
      readonly servePort: number;
      readonly localPort: number;
    }) => Effect.Effect<void, ServedSiteError>;
    readonly unserve: (servePort: number) => Effect.Effect<void, ServedSiteError>;
  }
>()("t3/servedSites/ServedSitesHost/SiteTailscale") {}

export const layerTailscale = Layer.effect(
  SiteTailscale,
  Effect.gen(function* () {
    const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
    const run = <A, E extends { readonly message: string }>(
      effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
      onError: (detail: string) => ServedSiteError,
    ) =>
      effect.pipe(
        Effect.provideContext(context),
        Effect.mapError((error) => onError(`Tailscale: ${tailscaleDetail(error)}`)),
      );
    return SiteTailscale.of({
      magicDnsName: run(readTailscaleStatus, unavailable).pipe(
        Effect.flatMap((status) =>
          status.magicDnsName === null
            ? Effect.fail(unavailable("Tailscale is not signed in, or MagicDNS is off."))
            : Effect.succeed(status.magicDnsName),
        ),
      ),
      routes: run(readTailscaleServeRoutes, unavailable),
      serve: Effect.fn("SiteTailscale.serve")((input) =>
        run(
          ensureTailscaleServe({ localPort: input.localPort, servePort: input.servePort }),
          failed,
        ),
      ),
      unserve: Effect.fn("SiteTailscale.unserve")((servePort) =>
        run(disableTailscaleServe({ servePort }), failed),
      ),
    });
  }),
);

export type HookRun =
  | {
      readonly _tag: "exited";
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly _tag: "timed-out" }
  | { readonly _tag: "spawn-failed"; readonly detail: string };

export class SiteHookRunner extends Context.Service<
  SiteHookRunner,
  {
    /** Runs argv without a shell. On timeout: SIGTERM, then SIGKILL 5 s later. */
    readonly run: (input: {
      readonly argv: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
      readonly cwd: string;
      readonly timeout: Duration.Duration;
    }) => Effect.Effect<HookRun>;
  }
>()("t3/servedSites/ServedSitesHost/SiteHookRunner") {}

const HOOK_KILL_GRACE = Duration.seconds(5);
const HOOK_MAX_OUTPUT_CHARS = 64 * 1024;
const LISTENER_TIMEOUT = Duration.seconds(5);
const STOP_GRACE_MS = 3_000;
const STOP_POLL = Duration.millis(250);

const collectText = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (text, chunk) => (text.length >= HOOK_MAX_OUTPUT_CHARS ? text : text + chunk),
    ),
  );

export const layerHookRunner = Layer.effect(
  SiteHookRunner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return SiteHookRunner.of({
      run: Effect.fn("SiteHookRunner.run")(function* (input) {
        const [command = "", ...args] = input.argv;
        const spawnFailed = (cause: unknown): HookRun => ({
          _tag: "spawn-failed",
          detail: cause instanceof Error ? cause.message : String(cause),
        });
        return yield* Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(command, args, {
              cwd: input.cwd,
              env: input.env,
              extendEnv: true,
              forceKillAfter: HOOK_KILL_GRACE,
            }),
          );
          const [stdout, stderr, code] = yield* Effect.all(
            [collectText(child.stdout), collectText(child.stderr), child.exitCode],
            { concurrency: "unbounded" },
          );
          return { _tag: "exited", code: Number(code), stdout, stderr } satisfies HookRun;
        }).pipe(
          Effect.scoped,
          Effect.timeoutOption(input.timeout),
          Effect.map(Option.getOrElse((): HookRun => ({ _tag: "timed-out" }))),
          Effect.catch((cause) => Effect.succeed(spawnFailed(cause))),
          // Synchronous spawn throws arrive as defects.
          Effect.catchDefect((cause) => Effect.succeed(spawnFailed(cause))),
        );
      }),
    });
  }),
);

export interface StopCommandResult {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly stderr: string;
}

export class SiteProcesses extends Context.Service<
  SiteProcesses,
  {
    /** The host's processes with start times; fails rather than reading as everything exited. */
    readonly table: Effect.Effect<ReadonlyArray<ResourceMonitorProcessTableEntry>, ServedSiteError>;
    readonly isListening: (port: number) => Effect.Effect<boolean>;
    /** The pid and name of the process a thread started that listens on `port`. */
    readonly portOwner: (
      port: number,
    ) => Effect.Effect<{ readonly pid: number; readonly processName: string | null } | null>;
    /** Pids holding a listening socket on `port`; null when no tool could tell. */
    readonly listenerPids: (port: number) => Effect.Effect<ReadonlyArray<number> | null>;
    /** SIGTERM to the pinned pids still running and their descendants, then SIGKILL after 3 s. */
    readonly stopProcessTrees: (
      pinned: ReadonlyArray<ServedSiteProcess>,
    ) => Effect.Effect<void, ServedSiteError>;
    readonly runStopCommand: (input: {
      readonly command: string;
      readonly cwd: string;
      readonly timeout: Duration.Duration;
    }) => Effect.Effect<StopCommandResult, ServedSiteError>;
  }
>()("t3/servedSites/ServedSitesHost/SiteProcesses") {}

const isNoSuchProcess = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ESRCH";

/** What went wrong running the stop command, without its command line or path. */
const stopCommandDetail = (error: ProcessRunner.ProcessRunError) => {
  switch (error._tag) {
    case "ProcessSpawnError":
      return "The shell could not start.";
    case "ProcessStdinError":
      return "Its input could not be written.";
    case "ProcessOutputLimitError":
      return "It printed too much output.";
    case "ProcessReadError":
      return "Its output could not be read.";
    case "ProcessTimeoutError":
      return "It timed out.";
  }
};

export const layerProcesses = Layer.effect(
  SiteProcesses,
  Effect.gen(function* () {
    const native = yield* NativeTelemetryClient.NativeTelemetryClient;
    const ports = yield* PortScanner.PortDiscovery;
    const net = yield* Net.NetService;
    const runner = yield* ProcessRunner.ProcessRunner;
    const platform = yield* HostProcess.Platform;
    const table = native.processTable.pipe(
      Effect.mapError(() =>
        unavailable("Served sites need the resource monitor to track processes."),
      ),
    );
    /** Signals every pid; one that refuses (EPERM) does not stop the rest. */
    const signal = (
      tree: ReadonlyArray<ResourceMonitorProcessTableEntry>,
      name: "SIGTERM" | "SIGKILL",
      refused: Set<number>,
    ) =>
      Effect.sync(() => {
        for (const { pid } of tree) {
          try {
            process.kill(pid, name);
          } catch (cause) {
            if (!isNoSuchProcess(cause)) refused.add(pid);
          }
        }
      });
    /** null when the tree holds the T3 server, its ancestors or an agent. */
    const readTree = (members: ReadonlyArray<TreeMember>) =>
      table.pipe(Effect.map((current) => stoppableProcessTree(current, members, process.pid)));
    const guardTripped = failed(
      "Its processes include the T3 server or an agent, so they were not all signaled.",
    );
    return SiteProcesses.of({
      table,
      isListening: Effect.fn("SiteProcesses.isListening")((port) =>
        net.hasListenerOnHost(port, "127.0.0.1"),
      ),
      portOwner: Effect.fn("SiteProcesses.portOwner")(function* (port) {
        const server = (yield* ports.scan()).find(
          (each) => each.port === port && each.pid !== null,
        );
        return server?.pid == null ? null : { pid: server.pid, processName: server.processName };
      }),
      listenerPids: Effect.fn("SiteProcesses.listenerPids")(function* (port) {
        if (platform === "win32") return null;
        const read = (command: string, args: ReadonlyArray<string>, pattern: RegExp) =>
          runner.run({ command, args, timeout: LISTENER_TIMEOUT, maxOutputBytes: 64 * 1024 }).pipe(
            // lsof exits 1 when nothing matches, so the exit code is not checked.
            Effect.map((result) => [...result.stdout.matchAll(pattern)].map((m) => Number(m[1]))),
            Effect.option,
          );
        const fromLsof = yield* read(
          "lsof",
          ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
          /^(\d+)$/gm,
        );
        if (Option.isSome(fromLsof) && fromLsof.value.length > 0) return fromLsof.value;
        if (platform !== "linux") return Option.getOrNull(fromLsof);
        const fromSs = yield* read("ss", ["-Hltnp", `sport = :${port}`], /pid=(\d+)/g);
        return Option.getOrNull(fromSs);
      }),
      stopProcessTrees: Effect.fn("SiteProcesses.stopProcessTrees")(function* (pinned) {
        if (platform === "win32") {
          return yield* failed("Stopping processes is not supported on this platform.");
        }
        const tree = yield* readTree(pinned);
        if (tree === null) return yield* guardTripped;
        if (tree.length === 0) return;
        const refused = new Set<number>();
        yield* signal(tree, "SIGTERM", refused);
        // Each re-read seeds from every member seen so far, so a process started during the grace
        // period stays tracked after its parent exits and it is reparented.
        const seen = new Map(tree.map((entry) => [entry.pid, entry]));
        let left = tree;
        let tripped = false;
        const deadline = (yield* Clock.currentTimeMillis) + STOP_GRACE_MS;
        while (left.length > 0 && (yield* Clock.currentTimeMillis) < deadline) {
          yield* Effect.sleep(STOP_POLL);
          const next = yield* readTree([...seen.values()]);
          if (next === null) {
            // SIGTERM already went out: still kill the last good read, then report the guard.
            tripped = true;
            break;
          }
          left = next;
          for (const entry of next) if (!seen.has(entry.pid)) seen.set(entry.pid, entry);
        }
        if (left.length > 0) yield* signal(left, "SIGKILL", refused);
        if (tripped) return yield* guardTripped;
        if (refused.size === 0) return;
        const after = (yield* readTree([...seen.values()])) ?? [...seen.values()];
        if (after.some((entry) => refused.has(entry.pid))) {
          return yield* failed("Could not signal some of its processes.");
        }
      }),
      runStopCommand: Effect.fn("SiteProcesses.runStopCommand")((input) =>
        runner
          .run({
            command: platform === "win32" ? "cmd.exe" : "sh",
            args: platform === "win32" ? ["/d", "/s", "/c", input.command] : ["-c", input.command],
            cwd: input.cwd,
            timeout: input.timeout,
            timeoutBehavior: "timedOutResult",
            outputMode: "truncate",
            maxOutputBytes: HOOK_MAX_OUTPUT_CHARS,
          })
          .pipe(
            Effect.map((result): StopCommandResult => ({
              code: result.code === null ? null : Number(result.code),
              timedOut: result.timedOut,
              stderr: result.stderr,
            })),
            // Killed by a signal, as on a server shutdown: it ended; the exit wait decides the rest.
            Effect.catchIf(
              (error) => error._tag === "ProcessReadError" && error.stream === "exitCode",
              () => Effect.succeed<StopCommandResult>({ code: null, timedOut: false, stderr: "" }),
            ),
            Effect.mapError((error) =>
              failed(`Could not run the stop command.\n${stopCommandDetail(error)}`),
            ),
          ),
      ),
    });
  }),
);
