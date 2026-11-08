// @effect-diagnostics nodeBuiltinImport:off -- runs the rendered sh launcher as a real process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_MACHINE_THRESHOLDS,
  MachineResourcesSettings,
  type ServerSettings,
} from "@t3tools/contracts";
import { GuardEnvironment } from "@t3tools/shared/GuardEnvironment";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { parseGuardConfig } from "../cli/guard.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as LoadGuard from "./LoadGuard.ts";

const machineResources = Schema.decodeSync(MachineResourcesSettings);

describe("renderGuardLauncher", () => {
  it.skipIf(process.platform === "win32")(
    "sh: execs the script target with the caller's args, quoting paths with a single quote",
    () => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 it's-guard-"));
      try {
        const fakeNode = NodePath.join(dir, "no'de");
        NodeFS.writeFileSync(
          fakeNode,
          `#!/bin/sh\nprintf '%s\\n' "ELECTRON=\${ELECTRON_RUN_AS_NODE:-unset}" "$@"\n`,
          { mode: 0o755 },
        );
        const runLauncher = (electron: boolean, target: LoadGuard.GuardLauncherTarget) => {
          const launcher = NodePath.join(dir, "t3-guard");
          NodeFS.writeFileSync(
            launcher,
            LoadGuard.renderGuardLauncher({ target, windows: false, electron }),
            { mode: 0o755 },
          );
          return NodeChildProcess.execFileSync(launcher, ["--hold", "90s", "--", "a b", "$HOME"], {
            encoding: "utf8",
            env: { PATH: process.env.PATH ?? "" },
          })
            .trimEnd()
            .split("\n");
        };
        const entry = NodePath.join(dir, "gu'ard.mjs");
        assert.deepStrictEqual(runLauncher(false, { kind: "script", executable: fakeNode, entry }), [
          "ELECTRON=unset",
          entry,
          "--hold",
          "90s",
          "--",
          "a b",
          "$HOME",
        ]);
        assert.deepStrictEqual(
          runLauncher(true, { kind: "executable", executable: fakeNode }).slice(0, 3),
          ["ELECTRON=1", "guard", "--hold"],
        );
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("cmd: CRLF, doubled %, forwards %* and the exit code, electron flag only for electron", () => {
    const cmd = (electron: boolean) =>
      LoadGuard.renderGuardLauncher({
        target: { kind: "script", executable: "C:\\100%\\t3.exe", entry: "C:\\app\\guard.mjs" },
        windows: true,
        electron,
      });
    const text = cmd(true);
    assert.notMatch(text.replaceAll("\r\n", ""), /\n/);
    const lines = text.split("\r\n");
    assert.include(lines, 'set "ELECTRON_RUN_AS_NODE=1"');
    assert.include(lines, '"C:\\100%%\\t3.exe" "C:\\app\\guard.mjs" %*');
    assert.include(lines, "exit /b %ERRORLEVEL%");
    assert.notInclude(cmd(false), "ELECTRON_RUN_AS_NODE");
    assert.include(
      LoadGuard.renderGuardLauncher({
        target: { kind: "executable", executable: "C:\\t3.exe" },
        windows: true,
        electron: false,
      }),
      '"C:\\t3.exe" "guard" %*',
    );
  });
});

describe("renderGuardConfig", () => {
  it("round-trips through the guard's reader with defaults applied: off is unguarded, on is guarded", () => {
    assert.isNull(parseGuardConfig(LoadGuard.renderGuardConfig(machineResources({}))));
    assert.deepStrictEqual(
      parseGuardConfig(
        LoadGuard.renderGuardConfig(
          machineResources({ loadManagement: { enabled: true }, thresholds: { loadPerCore: 3 } }),
        ),
      ),
      { holdMs: 120_000, thresholds: { ...DEFAULT_MACHINE_THRESHOLDS, loadPerCore: 3 } },
    );
  });
});

it.layer(NodeServices.layer)("LoadGuard layer", (it) => {
  it.effect(
    "rewrites guard.json on every settings change and injects env only while the lane is on",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-load-guard-" });
        const changes = yield* Queue.unbounded<ServerSettings>();
        // The guard applies each change before pulling the next, so a pull marks the previous one done.
        const pulls = yield* Queue.unbounded<void>();
        const settingsLayer = Layer.effect(
          ServerSettingsService,
          Effect.map(ServerSettingsService, (base) => ({
            ...base,
            subscribeChanges: Effect.succeed(
              Stream.fromEffectRepeat(
                Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(changes))),
              ),
            ),
          })),
        ).pipe(Layer.provide(ServerSettingsService.layerTest()));

        yield* Effect.gen(function* () {
          const { stateDir } = yield* ServerConfig;
          const settings = yield* ServerSettingsService;
          const guard = yield* GuardEnvironment;
          const configPath = path.join(stateDir, "guard.json");
          const launcherPath = path.join(stateDir, "t3-guard");
          const current = yield* settings.getSettings;
          const change = (loadManagement: object) =>
            Effect.gen(function* () {
              yield* Queue.offer(changes, {
                ...current,
                machineResources: machineResources({ loadManagement }),
              });
              yield* Queue.take(pulls);
              return JSON.parse(yield* fs.readFileString(configPath));
            });

          yield* Queue.take(pulls);
          const initial = JSON.parse(yield* fs.readFileString(configPath));
          assert.deepStrictEqual(initial, {
            enabled: false,
            guardHoldSeconds: 120,
            thresholds: DEFAULT_MACHINE_THRESHOLDS,
          });
          assert.deepStrictEqual(guard.env(), {});
          assert.match(yield* fs.readFileString(launcherPath), /^#!\/bin\/sh\n/);

          const on = yield* change({ enabled: true, guardHoldSeconds: 30 });
          assert.deepStrictEqual(on, {
            enabled: true,
            guardHoldSeconds: 30,
            thresholds: DEFAULT_MACHINE_THRESHOLDS,
          });
          assert.deepStrictEqual(guard.env(), {
            T3CODE_GUARD: launcherPath,
            T3CODE_GUARD_CONFIG: configPath,
          });

          const off = yield* change({ enabled: false, guardHoldSeconds: 30 });
          assert.isFalse(off.enabled);
          assert.deepStrictEqual(guard.env(), {});
        }).pipe(
          Effect.provide(
            LoadGuard.layer.pipe(
              Layer.provideMerge(
                Layer.mergeAll(settingsLayer, ServerConfig.layerTest(process.cwd(), baseDir)),
              ),
            ),
          ),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("injects nothing when guard.json cannot be written, even with the lane on", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-load-guard-" });
      const pulls = yield* Queue.unbounded<void>();
      const settingsLayer = Layer.effect(
        ServerSettingsService,
        Effect.map(ServerSettingsService, (base) => ({
          ...base,
          subscribeChanges: Effect.succeed(
            Stream.fromEffectRepeat(Queue.offer(pulls, undefined).pipe(Effect.andThen(Effect.never))),
          ),
        })),
      ).pipe(
        Layer.provide(
          ServerSettingsService.layerTest({ machineResources: { loadManagement: { enabled: true } } }),
        ),
      );
      yield* Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig;
        // A directory where guard.json goes makes the rename fail.
        yield* fs.makeDirectory(path.join(stateDir, "guard.json", "occupied"), { recursive: true });
        yield* Effect.gen(function* () {
          yield* Queue.take(pulls);
          assert.deepStrictEqual((yield* GuardEnvironment).env(), {});
        }).pipe(Effect.provide(LoadGuard.layer.pipe(Layer.provideMerge(settingsLayer))));
      }).pipe(Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)));
    }).pipe(Effect.scoped),
  );
});
