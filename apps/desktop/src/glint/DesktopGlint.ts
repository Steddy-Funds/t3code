import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type DesktopGlintOutcome,
  type DesktopGlintPresentInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import { makeGlintHelper, toScreenAnchor, type GlintHelper } from "./GlintHelper.ts";

/** A helper path that applies when Labs turns native dialogs on and leaves its path empty. */
const GLINT_HELPER_ENV = "T3CODE_GLINT_HELPER";

export class DesktopGlint extends Context.Service<
  DesktopGlint,
  {
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    readonly isAvailable: Effect.Effect<boolean>;
    readonly present: (input: DesktopGlintPresentInput) => Effect.Effect<DesktopGlintOutcome>;
  }
>()("@t3tools/desktop/glint/DesktopGlint") {}

function resolveGlintHelperPath(
  platform: NodeJS.Platform,
  settings: Pick<ClientSettings, "glintEnabled" | "glintHelperPath">,
  env: NodeJS.ProcessEnv,
): string | null {
  if (platform !== "darwin" || !settings.glintEnabled) return null;
  return settings.glintHelperPath.trim() || env[GLINT_HELPER_ENV]?.trim() || null;
}

const unavailable = (message: string): DesktopGlintOutcome => ({ type: "unavailable", message });

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const env = yield* HostProcess.Environment;
  const fileSystem = yield* FileSystem.FileSystem;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const helperRef = yield* Ref.make<GlintHelper | null>(null);
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const log = (message: string) => void runFork(Effect.logDebug(message));

  const configure = Effect.fn("desktop.glint.configure")(function* (settings: ClientSettings) {
    const path = resolveGlintHelperPath(environment.platform, settings, env);
    const found =
      path !== null && (yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false)));
    const next = found ? path : null;
    const previous = yield* Ref.get(helperRef);
    if ((previous?.path ?? null) === next) return;
    previous?.dispose();
    yield* Ref.set(helperRef, next === null ? null : makeGlintHelper(next, { log }));
  });

  yield* Effect.addFinalizer(() =>
    Ref.get(helperRef).pipe(Effect.map((helper) => helper?.dispose())),
  );
  yield* clientSettings.get.pipe(
    Effect.flatMap((stored) => configure(Option.getOrElse(stored, () => DEFAULT_CLIENT_SETTINGS))),
    Effect.ignore,
  );

  const present = Effect.fn("desktop.glint.present")(function* (input: DesktopGlintPresentInput) {
    const helper = yield* Ref.get(helperRef);
    if (!helper) return unavailable("Native dialogs are off.");
    const window = yield* electronWindow.focusedMainOrFirst;
    if (Option.isNone(window)) return unavailable("No window to anchor the dialog to.");
    if (window.value.isDestroyed()) return unavailable("The window closed.");
    const anchor = toScreenAnchor(
      input.anchor,
      window.value.getContentBounds(),
      window.value.webContents.getZoomFactor(),
    );
    return yield* Effect.promise(() => helper.present(input.kind, anchor, input.params));
  });

  return DesktopGlint.of({
    configure,
    isAvailable: Ref.get(helperRef).pipe(Effect.map((helper) => helper !== null)),
    present,
  });
});

export const layer = Layer.effect(DesktopGlint, make);
