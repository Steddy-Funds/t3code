import type { MachineIndicatorView } from "@t3tools/client-runtime/state/machineFormat";
import type { AnimationEvent, ReactNode } from "react";

export type MachineIconState =
  | "ok"
  | "stressed"
  | "unknown"
  | "unreachable"
  | "unreachable-stressed";
export type MachineIconSize = 12 | 14 | 18;

export function machineIconState(
  view: Pick<MachineIndicatorView, "verdict" | "unreachable" | "lastSeen">,
): MachineIconState {
  if (view.unreachable) {
    return view.lastSeen?.verdict === "stressed" ? "unreachable-stressed" : "unreachable";
  }
  return view.verdict;
}

/** Spread on the icon's own <svg>: dims unknown/unreachable and lets the drops draw outside its box. */
export function machineIconProps(state: MachineIconState) {
  return { "data-machine-icon": state };
}

const DROP_PATH = "M6 .8S1.8 6 1.8 8.4a4.2 4.2 0 0 0 8.4 0C10.2 6 6 .8 6 .8Z";
// Placed in the 24-unit icon viewBox, up and to the right of the glyph, outside its box.
const DROPS = [
  { transform: "translate(23 -7.2) scale(0.68)", delay: "0s" },
  { transform: "translate(28.8 1) scale(0.48)", delay: "-1s" },
] as const;

const SWEAT_ANIMATIONS = new Set(["machine-pulse", "machine-drip"]);

// Pinning startTime to 0 puts every stressed icon in one phase, as the terminal pulse does.
function synchronizePhase(event: AnimationEvent<SVGGElement>) {
  if (!SWEAT_ANIMATIONS.has(event.animationName) || !(event.target instanceof Element)) return;
  for (const animation of event.target.getAnimations()) {
    if (animation instanceof CSSAnimation && SWEAT_ANIMATIONS.has(animation.animationName)) {
      animation.startTime = 0;
    }
  }
}

/**
 * The stress layers, rendered as children of the machine icon's own <svg> (24-unit viewBox):
 * a light-red copy of the glyph that pulses and two sweat drops that drip. Stressed animates
 * under motion-safe only; unreachable-but-last-seen-stressed keeps still gray drops.
 */
export function MachineSweatOverlay({
  state,
  size,
  glyph,
}: {
  readonly state: MachineIconState;
  readonly size: MachineIconSize;
  /** The icon's SVG children, drawn again for the pulse. */
  readonly glyph: ReactNode;
}) {
  if (state !== "stressed" && state !== "unreachable-stressed") return null;
  const stressed = state === "stressed";
  return (
    <g
      data-machine-sweat={stressed ? "stressed" : "stale"}
      data-machine-size={size}
      aria-hidden="true"
      onAnimationStart={stressed ? synchronizePhase : undefined}
    >
      {stressed ? <g className="motion-safe:animate-machine-pulse">{glyph}</g> : null}
      <g data-machine-drops="" fill="currentColor" stroke="none">
        {DROPS.map((drop) => (
          <g key={drop.delay} transform={drop.transform}>
            <path
              data-machine-drop=""
              d={DROP_PATH}
              className={stressed ? "motion-safe:animate-machine-drip" : undefined}
              style={stressed ? { animationDelay: drop.delay } : undefined}
            />
          </g>
        ))}
      </g>
    </g>
  );
}
