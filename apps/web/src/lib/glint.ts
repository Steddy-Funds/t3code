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

/** Opens a dialog that can be fed and heard while it is up. Anchors at an element or a point. */
function openGlint<K extends GlintKind>(
  kind: K,
  anchor: Element | { readonly x: number; readonly y: number },
  params: GlintParams[K],
): GlintDialog<K> {
  const glint = window.desktopBridge?.glint;
  const id = randomUUID();
  const rect: DesktopGlintAnchor =
    anchor instanceof Element
      ? (({ x, y, width, height }) => ({ x, y, width, height }))(anchor.getBoundingClientRect())
      : { x: anchor.x, y: anchor.y, width: 0, height: 0 };
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
  return {
    id,
    send: (message) =>
      glint ? glint.send({ ...message, id }).catch(() => false) : Promise.resolve(false),
    onEvent: (listener) => glint?.onEvent(id, listener) ?? (() => {}),
    outcome,
  };
}

export function presentGlint<K extends GlintKind>(
  kind: K,
  anchor: Element | { readonly x: number; readonly y: number },
  params: GlintParams[K],
): Promise<GlintOutcome<K>> {
  return openGlint(kind, anchor, params).outcome;
}
