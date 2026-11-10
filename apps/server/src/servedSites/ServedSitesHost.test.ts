import { describe, expect, it, vi } from "@effect/vitest";
import type { ResourceMonitorProcessTableEntry } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as PortScanner from "../preview/PortScanner.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as Host from "./ServedSitesHost.ts";

const CWD = "/home/someone/projects/app";

const processes = (
  options: {
    readonly failure?: ProcessRunner.ProcessRunError;
    readonly table?: () => ReadonlyArray<ResourceMonitorProcessTableEntry>;
  } = {},
) =>
  Layer.build(
    Host.layerProcesses.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: () =>
              options.failure === undefined
                ? Effect.die("no runner")
                : Effect.fail(options.failure),
          }),
          Layer.mock(NativeTelemetryClient.NativeTelemetryClient)({
            processTable: Effect.sync(() => options.table?.() ?? []),
          }),
          Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
          Layer.mock(Net.NetService)({}),
          Layer.succeed(HostProcess.Platform, "linux"),
        ),
      ),
    ),
  ).pipe(Effect.map((context) => Context.get(context, Host.SiteProcesses)));

const runStop = (failure: ProcessRunner.ProcessRunError) =>
  processes({ failure }).pipe(
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

describe("SiteProcesses.stopProcessTrees", () => {
  const START = 1_000;
  const errno = (code: string) => Object.assign(new Error(code), { code });

  /** Records every signal; `onSignal` changes the table the way the signal would. */
  const spyOnKill = (onSignal: (pid: number, signal: string) => void) => {
    const signals: Array<readonly [number, string]> = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      signals.push([pid, String(signal)]);
      onSignal(pid, String(signal));
      return true;
    });
    const sent = (name: string) =>
      signals.filter(([, signal]) => signal === name).map(([pid]) => pid);
    return Effect.acquireRelease(Effect.succeed(sent), () => Effect.sync(() => kill.mockRestore()));
  };

  it.effect(
    "SIGTERMs the tree, then SIGKILLs what is left and what it started, past refusals",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // npm (200) runs node (201, no start time, ignores SIGTERM), a setuid helper (202,
          // refuses signals) and a child that is already gone (203).
          let table: Array<ResourceMonitorProcessTableEntry> = [
            { pid: 200, ppid: 150, name: "npm", startTimeMs: START },
            { pid: 201, ppid: 200, name: "node" },
            { pid: 202, ppid: 200, name: "chrome-sandbox", startTimeMs: START },
            { pid: 203, ppid: 200, name: "gone", startTimeMs: START },
          ];
          const sent = yield* spyOnKill((pid, signal) => {
            if (pid === 202) throw errno("EPERM");
            if (pid === 203) throw errno("ESRCH");
            if (signal === "SIGKILL") {
              table = table.filter((entry) => entry.pid !== pid);
            } else if (pid === 200) {
              // npm exits; node is reparented and starts a worker.
              table = [
                ...table.flatMap((entry) =>
                  entry.pid === 200 || entry.pid === 203
                    ? []
                    : [entry.pid === 201 ? { ...entry, ppid: 1 } : entry],
                ),
                { pid: 204, ppid: 201, name: "worker", startTimeMs: START + 10 },
              ];
            }
          });
          const sites = yield* processes({ table: () => table });
          const stopping = yield* sites
            .stopProcessTrees([{ pid: 200, startTimeMs: START }])
            .pipe(Effect.flip, Effect.forkChild);
          yield* TestClock.adjust("2 seconds");
          expect(sent("SIGKILL")).toEqual([]);
          yield* TestClock.adjust("1 second");
          expect((yield* Fiber.join(stopping)).detail).toBe(
            "Could not signal some of its processes.",
          );
          expect(sent("SIGTERM")).toEqual([200, 201, 202, 203]);
          expect(sent("SIGKILL").toSorted()).toEqual([201, 202, 204]);
          expect(table.map((entry) => entry.pid)).toEqual([202]);
        }),
      ),
  );

  it.effect(
    "SIGKILLs a child started in the grace period after its parent exits; a refused pid that exits succeeds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // node (400) ignores SIGTERM but starts 401; its helper (402) refuses signals. On the
          // second re-read node has exited, 401 is reparented and the helper has exited too.
          let reads = 0;
          let table: Array<ResourceMonitorProcessTableEntry> = [
            { pid: 400, ppid: 150, name: "node", startTimeMs: START },
            { pid: 402, ppid: 400, name: "helper", startTimeMs: START },
          ];
          const sent = yield* spyOnKill((pid, signal) => {
            if (pid === 402) throw errno("EPERM");
            if (signal === "SIGKILL") table = table.filter((entry) => entry.pid !== pid);
            else if (pid === 400) {
              table = [...table, { pid: 401, ppid: 400, name: "worker", startTimeMs: START + 10 }];
            }
          });
          const sites = yield* processes({
            table: () => {
              reads += 1;
              if (reads === 3) {
                table = table.flatMap((entry) =>
                  entry.pid === 401 ? [{ ...entry, ppid: 1 }] : [],
                );
              }
              return table;
            },
          });
          const stopping = yield* sites
            .stopProcessTrees([{ pid: 400, startTimeMs: START }])
            .pipe(Effect.forkChild);
          yield* TestClock.adjust("3 seconds");
          yield* Fiber.join(stopping);
          expect(sent("SIGKILL")).toEqual([401]);
          expect(table).toEqual([]);
        }),
      ),
  );

  it.effect("sends no SIGKILL to a tree that exits on SIGTERM", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let table: Array<ResourceMonitorProcessTableEntry> = [
          { pid: 300, ppid: 150, name: "node", startTimeMs: START },
          { pid: 301, ppid: 300, name: "worker" },
        ];
        const sent = yield* spyOnKill((pid) => {
          table = table.filter((entry) => entry.pid !== pid);
        });
        const sites = yield* processes({ table: () => table });
        const stopping = yield* sites
          .stopProcessTrees([{ pid: 300, startTimeMs: START }])
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("3 seconds");
        yield* Fiber.join(stopping);
        expect(sent("SIGTERM")).toEqual([300, 301]);
        expect(sent("SIGKILL")).toEqual([]);
      }),
    ),
  );
});
