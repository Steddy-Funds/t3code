import type { MachineResourcesSettings } from "@t3tools/contracts";
import {
  GUARD_CONFIG_ENV,
  GUARD_ENV,
  GuardEnvironment,
  type GuardEnvironmentShape,
} from "@t3tools/shared/GuardEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const GUARD_LAUNCHER_MARKER = "Written by T3 Code: runs `t3 guard`.";

export type GuardLauncherTarget =
  /** Node or Electron-as-Node running the bundled guard script. */
  | { readonly kind: "script"; readonly executable: string; readonly entry: string }
  /** A single executable, which has no guard script beside it. */
  | { readonly kind: "executable"; readonly executable: string };

const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
/** cmd.exe expands `%` even inside quotes; Windows paths cannot contain `"`. */
const cmdWord = (value: string) => `"${value.replaceAll("%", "%%")}"`;

export function renderGuardLauncher(input: {
  readonly target: GuardLauncherTarget;
  readonly windows: boolean;
  readonly electron: boolean;
}): string {
  const { target } = input;
  const words =
    target.kind === "script" ? [target.executable, target.entry] : [target.executable, "guard"];
  if (input.windows) {
    return [
      "@echo off",
      `rem ${GUARD_LAUNCHER_MARKER}`,
      // Delayed expansion would rewrite `!name!` in paths and arguments.
      "setlocal EnableExtensions DisableDelayedExpansion",
      ...(input.electron ? ['set "ELECTRON_RUN_AS_NODE=1"'] : []),
      `${words.map(cmdWord).join(" ")} %*`,
      "exit /b %ERRORLEVEL%",
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    `# ${GUARD_LAUNCHER_MARKER}`,
    ...(input.electron ? ["export ELECTRON_RUN_AS_NODE=1"] : []),
    `exec ${words.map(shellWord).join(" ")} "$@"`,
    "",
  ].join("\n");
}

/** What `t3 guard` reads: the lane switch, the hold and the resolved thresholds. */
export function renderGuardConfig(machineResources: MachineResourcesSettings): string {
  const { loadManagement, thresholds } = machineResources;
  return `${JSON.stringify(
    {
      enabled: loadManagement.enabled,
      guardHoldSeconds: loadManagement.guardHoldSeconds,
      thresholds,
    },
    null,
    2,
  )}\n`;
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const windows = yield* HostProcess.isWindows;
  const executable = yield* HostProcess.ExecutablePath;
  const singleExecutable = yield* HostProcess.IsExecutable;

  const launcherPath = path.join(config.stateDir, windows ? "t3-guard.cmd" : "t3-guard");
  const configPath = path.join(config.stateDir, "guard.json");

  const writeAtomic = Effect.fn("LoadGuard.writeAtomic")(function* (
    target: string,
    content: string,
    mode: number,
  ) {
    const existing = yield* fs.readFileString(target).pipe(Effect.option);
    if (existing._tag === "Some" && existing.value === content) return;
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    const staging = `${target}.${process.pid}.tmp`;
    yield* fs.writeFileString(staging, content, { mode });
    yield* fs.rename(staging, target);
  });

  const fromSource = import.meta.url.endsWith(".ts");
  const target: GuardLauncherTarget = singleExecutable
    ? { kind: "executable", executable }
    : {
        kind: "script",
        executable,
        entry: yield* path.fromFileUrl(
          new URL(fromSource ? "../guard.ts" : "./guard.mjs", import.meta.url),
        ),
      };
  const launcherReady = yield* writeAtomic(
    launcherPath,
    renderGuardLauncher({
      target,
      windows,
      electron: process.versions.electron !== undefined,
    }),
    0o755,
  ).pipe(
    Effect.as(true),
    Effect.catchCause((cause) =>
      Effect.logWarning("could not write the t3 guard launcher", {
        launcherPath,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(false)),
    ),
  );

  let enabled = false;
  const apply = Effect.fn("LoadGuard.apply")(function* (
    machineResources: MachineResourcesSettings,
  ) {
    const written = yield* writeAtomic(configPath, renderGuardConfig(machineResources), 0o644).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not write guard.json", {
          configPath,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );
    // A stale file could say enabled after the user turned the lane off; inject nothing then.
    enabled = launcherReady && written && machineResources.loadManagement.enabled;
  });

  yield* Effect.gen(function* () {
    yield* settings.ready;
    const changes = yield* settings.subscribeChanges;
    yield* apply((yield* settings.getSettings).machineResources);
    yield* Stream.runForEach(changes, (next) => apply(next.machineResources));
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  return {
    env: () => (enabled ? { [GUARD_ENV]: launcherPath, [GUARD_CONFIG_ENV]: configPath } : {}),
  } satisfies GuardEnvironmentShape;
});

/** Provide at the top, like the ownership registry, so every spawn site reads the same switch. */
export const layer = Layer.effect(GuardEnvironment, make);
