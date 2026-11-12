import type { DesktopGlintAnchor, DesktopGlintMessage } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { randomUUID } from "./utils";

/**
 * Glint's native macOS dialogs, drawn by a helper process the desktop app runs. The bridge passes
 * kinds through untouched, so a new dialog is one entry here plus the hook that presents it.
 */
const GlintModelSelection = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  effort: Schema.optionalKey(Schema.String),
  fast: Schema.optionalKey(Schema.Boolean),
});
export type GlintModelSelection = typeof GlintModelSelection.Type;

export interface GlintModelParams {
  readonly providers: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly models: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly efforts: ReadonlyArray<string>;
      readonly defaultEffort?: string;
      readonly supportsFast: boolean;
    }>;
  }>;
  readonly selection: GlintModelSelection;
}

const GLINT_VALUES = {
  timeFromNow: Schema.Struct({ date: Schema.String }),
  model: Schema.Struct({ selection: GlintModelSelection }),
  color: Schema.Struct({
    hex: Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/i)),
    action: Schema.Literals(["pick", "copy", "save"]),
  }),
  // A 2–4 option glass radio, such as a snooze reason.
  choice: Schema.Struct({ id: Schema.String }),
};

const GLINT_DECODERS: { readonly [K in GlintKind]: (value: unknown) => Option.Option<unknown> } = {
  timeFromNow: Schema.decodeUnknownOption(GLINT_VALUES.timeFromNow),
  model: Schema.decodeUnknownOption(GLINT_VALUES.model),
  color: Schema.decodeUnknownOption(GLINT_VALUES.color),
  choice: Schema.decodeUnknownOption(GLINT_VALUES.choice),
};

interface GlintParams {
  readonly timeFromNow: { readonly title: string };
  readonly model: GlintModelParams;
  readonly color: { readonly initial?: string };
  readonly choice: {
    readonly title: string;
    readonly options: ReadonlyArray<{
      readonly id: string;
      readonly label: string;
      readonly symbol?: string;
    }>;
  };
}

type GlintKind = keyof typeof GLINT_VALUES;

/** `unavailable` means the caller shows its web UI instead. */
export type GlintOutcome<K extends GlintKind> =
  | { readonly type: "result"; readonly value: (typeof GLINT_VALUES)[K]["Type"] }
  | { readonly type: "cancelled" }
  | { readonly type: "unavailable" };

export function isGlintAvailable(): boolean {
  try {
    return window.desktopBridge?.glint?.isAvailable() === true;
  } catch {
    return false;
  }
}

interface GlintDialog<K extends GlintKind> {
  readonly id: string;
  /** Sends `update`, `input`, `key` or `dismiss` to this dialog; false once it has closed. */
  readonly send: (message: {
    readonly type: string;
    readonly [key: string]: unknown;
  }) => Promise<boolean>;
  /** This dialog's own messages while it is open, such as `changed`. */
  readonly onEvent: (listener: (message: DesktopGlintMessage) => void) => () => void;
  readonly outcome: Promise<GlintOutcome<K>>;
}

type GlintAnchor =
  | Element
  | {
      readonly x: number;
      readonly y: number;
      readonly width?: number;
      readonly height?: number;
    };

interface OpenDialog {
  readonly anchor: GlintAnchor;
  readonly dismiss: () => void;
  dismissed: boolean;
}

/** One dialog shows at a time: presenting another closes the one before. */
let openDialog: OpenDialog | null = null;
let lastCancel: { readonly anchor: GlintAnchor; readonly atMs: number } | null = null;

/** How soon after the helper cancels a dialog a click on its trigger still counts as closing it. */
export const GLINT_TRIGGER_CLOSE_MS = 400;

// The two-finger touches that drive a dialog also reach this window as wheels, so scrolling,
// swipe to reply, the history swipe and pinch would all move underneath it.
const swallowWheel = (event: Event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
};

/** True from present until the dialog's result, cancel, dismiss or failure. */
export function isGlintDialogOpen(): boolean {
  return openDialog !== null;
}

/**
 * Called when `trigger` would open its dialog: true means close it instead. The helper cancels a
 * dialog on any click outside it, the trigger's own included, and that cancel can land before the
 * trigger hears the click, so a cancel just before counts as this click's close.
 */
function glintTriggerCloses(trigger: Element, nowMs: number = Date.now()): boolean {
  if (openDialog?.anchor === trigger) {
    openDialog.dismiss();
    return true;
  }
  const cancel = lastCancel;
  if (cancel?.anchor !== trigger) return false;
  lastCancel = null;
  return nowMs - cancel.atMs < GLINT_TRIGGER_CLOSE_MS;
}

/** What a click on a Glint trigger does: its web UI, its native dialog, or close that dialog. */
export function glintTriggerAction(
  trigger: Element | null,
  nowMs: number = Date.now(),
): "web" | "native" | "close" {
  if (!trigger || !isGlintAvailable()) return "web";
  return glintTriggerCloses(trigger, nowMs) ? "close" : "native";
}

function trackOpen(dialog: OpenDialog) {
  if (!openDialog)
    window.addEventListener("wheel", swallowWheel, { capture: true, passive: false });
  openDialog = dialog;
  lastCancel = null;
}

function trackClosed(dialog: OpenDialog, outcome: GlintOutcome<GlintKind>["type"]) {
  if (openDialog !== dialog) return;
  openDialog = null;
  window.removeEventListener("wheel", swallowWheel, { capture: true });
  // Only the helper's own cancel, a click outside or Esc there, races a trigger click.
  if (outcome === "cancelled" && !dialog.dismissed) {
    lastCancel = { anchor: dialog.anchor, atMs: Date.now() };
  }
}

/** Opens a dialog that can be fed and heard while it is up. Anchors at an element, point or rect. */
function openGlint<K extends GlintKind>(
  kind: K,
  anchor: GlintAnchor,
  params: GlintParams[K],
): GlintDialog<K> {
  const glint = window.desktopBridge?.glint;
  const id = randomUUID();
  const rect: DesktopGlintAnchor =
    "getBoundingClientRect" in anchor
      ? (({ x, y, width, height }) => ({ x, y, width, height }))(anchor.getBoundingClientRect())
      : { x: anchor.x, y: anchor.y, width: anchor.width ?? 0, height: anchor.height ?? 0 };
  const send: GlintDialog<K>["send"] = (message) =>
    glint ? glint.send({ ...message, id }).catch(() => false) : Promise.resolve(false);
  const outcome = (async (): Promise<GlintOutcome<K>> => {
    if (!glint) return { type: "unavailable" };
    try {
      const outcome = await glint.present({ id, kind, anchor: rect, params });
      if (outcome.type !== "result") return { type: outcome.type };
      const value = GLINT_DECODERS[kind](outcome.value);
      return Option.isSome(value)
        ? { type: "result", value: value.value as (typeof GLINT_VALUES)[K]["Type"] }
        : { type: "unavailable" };
    } catch {
      return { type: "unavailable" };
    }
  })();
  if (glint) {
    const dialog: OpenDialog = {
      anchor,
      dismissed: false,
      dismiss: () => {
        dialog.dismissed = true;
        void send({ type: "dismiss" });
      },
    };
    trackOpen(dialog);
    void outcome.then((settled) => trackClosed(dialog, settled.type));
  }
  return {
    id,
    send,
    onEvent: (listener) => glint?.onEvent(id, listener) ?? (() => {}),
    outcome,
  };
}

export function presentGlint<K extends GlintKind>(
  kind: K,
  anchor: GlintAnchor,
  params: GlintParams[K],
): Promise<GlintOutcome<K>> {
  return openGlint(kind, anchor, params).outcome;
}
