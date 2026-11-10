/**
 * The machine a served site touches: tailscale, the public hook, and processes. Each is a service
 * so ServedSites can be tested without a tailnet, a hook script, or real processes.
 */
import { ServedSiteError, type ResourceMonitorProcessTableEntry } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Net from "@t3tools/shared/Net";
import {
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleServePorts,
  readTailscaleStatus,
} from "@t3tools/tailscale";
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

const failed = (detail: string) => new ServedSiteError({ reason: "failed", detail });
const unavailable = (detail: string) => new ServedSiteError({ reason: "unavailable", detail });

const tailscaleDetail = (error: {
  readonly message: string;
  readonly stderrDiagnostic?: string;
}) =>
  error.stderrDiagnostic === undefined
    ? error.message
    : `${error.message} (${error.stderrDiagnostic})`;

export class SiteTailscale extends Context.Service<
  SiteTailscale,
  {
    /** Fails when tailscale is missing, signed out, or has MagicDNS off. */
    readonly magicDnsName: Effect.Effect<string, ServedSiteError>;
    readonly servePorts: Effect.Effect<ReadonlySet<number>, ServedSiteError>;
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
      servePorts: run(readTailscaleServePorts, unavailable),
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
    readonly stopProcessGroups: (
      pids: ReadonlyArray<number>,
    ) => Effect.Effect<void, ServedSiteError>;
    readonly runStopCommand: (input: {
      readonly command: string;
      readonly cwd: string;
      readonly timeout: Duration.Duration;
    }) => Effect.Effect<StopCommandResult, ServedSiteError>;
  }
>()("t3/servedSites/ServedSitesHost/SiteProcesses") {}

const stopFailure = (reason: string) => {
  switch (reason) {
    case "shared-group":
      return "Its process group also holds the T3 server or an agent, so it was not signaled.";
    case "unsupported":
      return "Stopping processes is not supported on this platform.";
    default:
      return "Could not signal its processes.";
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
    return SiteProcesses.of({
      table: native.processTable.pipe(
        Effect.mapError(() =>
          unavailable("Served sites need the resource monitor to track processes."),
        ),
      ),
      isListening: Effect.fn("SiteProcesses.isListening")((port) =>
        net.hasListenerOnHost(port, "127.0.0.1"),
      ),
      portOwner: Effect.fn("SiteProcesses.portOwner")(function* (port) {
        const server = (yield* ports.scan()).find(
          (each) => each.port === port && each.pid !== null,
        );
        return server?.pid == null ? null : { pid: server.pid, processName: server.processName };
      }),
      stopProcessGroups: Effect.fn("SiteProcesses.stopProcessGroups")((pids) =>
        ports
          .stopProcessGroups(pids)
          .pipe(Effect.mapError((error) => failed(stopFailure(error.reason)))),
      ),
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
            Effect.map((result) => ({
              code: result.code === null ? null : Number(result.code),
              timedOut: result.timedOut,
              stderr: result.stderr,
            })),
            Effect.mapError((error) => failed(`Could not run the stop command: ${error.message}`)),
          ),
      ),
    });
  }),
);
