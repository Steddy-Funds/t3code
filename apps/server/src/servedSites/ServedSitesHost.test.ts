import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PortScanner from "../preview/PortScanner.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as Host from "./ServedSitesHost.ts";

const CWD = "/home/someone/projects/app";

const processes = (failure: ProcessRunner.ProcessRunError) =>
  Layer.build(
    Host.layerProcesses.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProcessRunner.ProcessRunner)({ run: () => Effect.fail(failure) }),
          Layer.mock(NativeTelemetryClient.NativeTelemetryClient)({}),
          Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
          Layer.mock(Net.NetService)({}),
          Layer.succeed(HostProcess.Platform, "linux"),
        ),
      ),
    ),
  ).pipe(Effect.map((context) => Context.get(context, Host.SiteProcesses)));

const runStop = (failure: ProcessRunner.ProcessRunError) =>
  processes(failure).pipe(
    Effect.flatMap((sites) =>
      sites.runStopCommand({ command: "make down", cwd: CWD, timeout: Duration.seconds(60) }),
    ),
  );

describe("SiteProcesses.runStopCommand", () => {
  it.effect("reads a stop command killed by a signal as one that ended", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* runStop(
          new ProcessRunner.ProcessReadError({
            command: "sh",
            argumentCount: 2,
            cwd: CWD,
            stream: "exitCode",
            cause: new Error("killed by SIGTERM"),
          }),
        );
        expect(result).toEqual({ code: null, timedOut: false, stderr: "" });
      }),
    ),
  );

  it.effect("names a command that could not run without the project path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          runStop(
            new ProcessRunner.ProcessSpawnError({
              command: "sh",
              argumentCount: 2,
              cwd: CWD,
              cause: new Error("ENOENT"),
            }),
          ),
        );
        expect(error.detail.split("\n")[0]).toBe("Could not run the stop command.");
        expect(error.detail).not.toContain(CWD);
      }),
    ),
  );
});
