import {
  DesktopGlintMessageSchema,
  DesktopGlintOutcomeSchema,
  DesktopGlintPresentInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopGlint from "../../glint/DesktopGlint.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// Sync, so a picker can choose between the native dialog and its web UI in the same click.
export const isGlintAvailable = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GLINT_IS_AVAILABLE_CHANNEL,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.glint.isAvailable")(function* () {
    return yield* (yield* DesktopGlint.DesktopGlint).isAvailable;
  }),
});

export const presentGlint = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GLINT_PRESENT_CHANNEL,
  payload: DesktopGlintPresentInputSchema,
  result: DesktopGlintOutcomeSchema,
  handler: Effect.fn("desktop.ipc.glint.present")(function* (input) {
    return yield* (yield* DesktopGlint.DesktopGlint).present(input);
  }),
});

export const sendGlint = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GLINT_SEND_CHANNEL,
  payload: DesktopGlintMessageSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.glint.send")(function* (message) {
    return yield* (yield* DesktopGlint.DesktopGlint).send(message);
  }),
});
