import type { DesktopGlintAnchor } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
};

const GLINT_DECODERS: { readonly [K in GlintKind]: (value: unknown) => Option.Option<unknown> } = {
  timeFromNow: Schema.decodeUnknownOption(GLINT_VALUES.timeFromNow),
  model: Schema.decodeUnknownOption(GLINT_VALUES.model),
  color: Schema.decodeUnknownOption(GLINT_VALUES.color),
};

interface GlintParams {
  readonly timeFromNow: { readonly title: string };
  readonly model: GlintModelParams;
  readonly color: { readonly initial?: string };
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

/** Anchors at an element's box, or at a point such as a context menu's. */
export async function presentGlint<K extends GlintKind>(
  kind: K,
  anchor: Element | { readonly x: number; readonly y: number },
  params: GlintParams[K],
): Promise<GlintOutcome<K>> {
  const glint = window.desktopBridge?.glint;
  if (!glint) return { type: "unavailable" };
  const rect: DesktopGlintAnchor =
    anchor instanceof Element
      ? (({ x, y, width, height }) => ({ x, y, width, height }))(anchor.getBoundingClientRect())
      : { x: anchor.x, y: anchor.y, width: 0, height: 0 };
  try {
    const outcome = await glint.present(kind, rect, params);
    if (outcome.type !== "result") return { type: outcome.type };
    const value = GLINT_DECODERS[kind](outcome.value);
    return Option.isSome(value)
      ? { type: "result", value: value.value as (typeof GLINT_VALUES)[K]["Type"] }
      : { type: "unavailable" };
  } catch {
    return { type: "unavailable" };
  }
}
