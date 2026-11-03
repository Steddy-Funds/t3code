export const SWIPE_REPLY_THRESHOLD_PX = 56;
/** A message row with something to reply to; history swipes leave it to the reply gesture. */
export const SWIPE_REPLY_ROW_SELECTOR = "[data-message-role]:has([data-swipe-reply-surface])";
// Web wheel events have no end or phase; the fingers have lifted once they stop.
export const SWIPE_REPLY_RELEASE_IDLE_MS = 140;
// The desktop app reports the lift itself; this only frees a swipe whose end never arrived.
export const SWIPE_REPLY_DESKTOP_RELEASE_FALLBACK_MS = 1000;
// Resting fingers send nothing, so a pause can release; the rest of that swipe must not reply again.
export const SWIPE_REPLY_COOLDOWN_MS = 400;
// Trackpads open a gesture with 1-3px deltas on both axes; decide the axis once it is clear.
const AXIS_DECISION_PX = 6;
// A tilt wheel notch arrives as one ~100px event. Trackpads open that fast too when the swipe
// starts on touchdown, so the guard applies only off macOS, where mice tilt.
const MAX_OPENING_DELTA_PX = 30;
// A message already at the viewport edge still gives this much past the threshold.
const MIN_OVERSCROLL_PX = 32;

export type SwipeReplyGesture =
  | { readonly phase: "idle" }
  | { readonly phase: "deciding"; readonly travel: number; readonly cross: number }
  | { readonly phase: "tracking"; readonly travel: number }
  /** Scrolling or the other direction; ignored until the gesture goes quiet. */
  | { readonly phase: "ignored" };

export const IDLE_SWIPE_REPLY: SwipeReplyGesture = { phase: "idle" };
export const IGNORED_SWIPE_REPLY: SwipeReplyGesture = { phase: "ignored" };

/**
 * Pixels of finger travel to the right. Natural scrolling, the macOS default, reports that as
 * negative deltaX. Line and page deltas come from mouse wheels, never trackpads.
 */
export function swipeReplyTravel(event: Pick<WheelEvent, "deltaX" | "deltaMode">): number | null {
  return event.deltaMode === 0 ? -event.deltaX : null;
}

export function stepSwipeReply(
  gesture: SwipeReplyGesture,
  travel: number,
  cross: number,
  mac: boolean,
): SwipeReplyGesture {
  switch (gesture.phase) {
    case "ignored":
      return gesture;
    case "tracking":
      return { phase: "tracking", travel: Math.max(0, gesture.travel + travel) };
    case "idle":
    case "deciding": {
      if (!mac && Math.abs(travel) > MAX_OPENING_DELTA_PX) return IGNORED_SWIPE_REPLY;
      const sumTravel = (gesture.phase === "deciding" ? gesture.travel : 0) + travel;
      const sumCross = (gesture.phase === "deciding" ? gesture.cross : 0) + Math.abs(cross);
      if (Math.abs(sumTravel) + sumCross < AXIS_DECISION_PX) {
        return { phase: "deciding", travel: sumTravel, cross: sumCross };
      }
      return sumTravel > 2 * sumCross
        ? { phase: "tracking", travel: sumTravel }
        : IGNORED_SWIPE_REPLY;
    }
  }
}

/** Releasing now replies. Pulling back under the threshold before release cancels. */
export function swipeReplyArmed(gesture: SwipeReplyGesture): boolean {
  return gesture.phase === "tracking" && gesture.travel >= SWIPE_REPLY_THRESHOLD_PX;
}

/** How far the row may move: until half of it would leave the viewport. */
export function swipeReplyReach(
  surface: Pick<DOMRect, "left" | "right">,
  viewportRight: number,
): number {
  const middle = (surface.left + surface.right) / 2;
  return Math.max(SWIPE_REPLY_THRESHOLD_PX + MIN_OVERSCROLL_PX, viewportRight - middle);
}

/** The row follows the fingers one to one, then ever more slowly toward its reach. */
export function swipeReplyOffset(gesture: SwipeReplyGesture, reach: number): number {
  if (gesture.phase !== "tracking") return 0;
  const excess = gesture.travel - SWIPE_REPLY_THRESHOLD_PX;
  if (excess <= 0) return gesture.travel;
  const span = reach - SWIPE_REPLY_THRESHOLD_PX;
  return SWIPE_REPLY_THRESHOLD_PX + (excess * span) / (excess + span);
}
