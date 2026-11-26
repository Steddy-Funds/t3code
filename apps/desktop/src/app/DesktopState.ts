import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { DatabaseMigrationProgress } from "@t3tools/contracts";

import type { BackendStartupFailure } from "../backend/DesktopBackendManager.ts";

/** Startup health of the primary local backend, read by the startup recovery window. */
export type PrimaryBackendStartup =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Ready" }
  | ({ readonly _tag: "Failing" } & BackendStartupFailure);

export class DesktopState extends Context.Service<
  DesktopState,
  {
    readonly backendReady: Ref.Ref<boolean>;
    readonly quitting: Ref.Ref<boolean>;
    /** The Glint dialog on screen, whose two-finger touches the window must not act on too. */
    readonly glintDialogId: Ref.Ref<string | null>;
    // Set by DesktopUpdates.configure, which runs before the first backend start.
    readonly canInstallUpdates: Ref.Ref<boolean>;
    readonly primaryBackendStartup: SubscriptionRef.SubscriptionRef<PrimaryBackendStartup>;
    readonly databaseMigrationProgress: Ref.Ref<DatabaseMigrationProgress | null>;
  }
>()("@t3tools/desktop/app/DesktopState") {}

const make = Effect.all({
  backendReady: Ref.make(false),
  quitting: Ref.make(false),
  glintDialogId: Ref.make<string | null>(null),
  canInstallUpdates: Ref.make(false),
  primaryBackendStartup: SubscriptionRef.make<PrimaryBackendStartup>({ _tag: "Starting" }),
  databaseMigrationProgress: Ref.make<DatabaseMigrationProgress | null>(null),
});

export const layer = Layer.effect(DesktopState, make);
