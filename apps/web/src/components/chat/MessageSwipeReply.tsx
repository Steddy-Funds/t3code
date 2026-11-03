import { MessageId } from "@t3tools/contracts";
import { ReplyIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { isMomentumTail, MOMENTUM_SAMPLE_SIZE } from "~/lib/trackpadMomentum";
import { isMacPlatform } from "~/lib/utils";
import {
  IDLE_SWIPE_REPLY,
  IGNORED_SWIPE_REPLY,
  stepSwipeReply,
  swipeReplyArmed,
  swipeReplyOffset,
  swipeReplyReach,
  swipeReplyTravel,
  SWIPE_REPLY_COOLDOWN_MS as REPLY_COOLDOWN_MS,
  SWIPE_REPLY_DESKTOP_RELEASE_FALLBACK_MS,
  SWIPE_REPLY_RELEASE_IDLE_MS,
  SWIPE_REPLY_ROW_SELECTOR,
  SWIPE_REPLY_THRESHOLD_PX,
  type SwipeReplyGesture,
} from "./messageSwipeReply.logic";

// The spring in index.css settles within this; afterwards the row drops its inline styles.
const SNAP_BACK_MS = 340;
const INDICATOR_SIZE_PX = 28;
const INDICATOR_GAP_PX = 8;

/** The message row a swipe moves, unless it has nothing to reply to or the content scrolls the same way. */
function swipeRowAt(target: EventTarget | null, viewport: HTMLElement): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest<HTMLElement>(SWIPE_REPLY_ROW_SELECTOR);
  if (!row?.dataset.messageId || !viewport.contains(row)) return null;
  for (
    let element: Element | null = target;
    element && element !== row;
    element = element.parentElement
  ) {
    if (element.scrollLeft > 0 && /auto|scroll/.test(getComputedStyle(element).overflowX)) {
      return null;
    }
  }
  return row;
}

/** Two-finger swipe right on a message replies to it, like WhatsApp on macOS. */
export function MessageSwipeReply({
  viewport,
  onReply,
}: {
  viewport: HTMLElement | null;
  onReply: (messageId: MessageId) => void;
}) {
  const indicatorRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows wheel gestures on the timeline viewport and moves the swiped row outside React
  useEffect(() => {
    if (!viewport) return;
    let gesture: SwipeReplyGesture = IDLE_SWIPE_REPLY;
    let row: HTMLElement | null = null;
    let quietTimer: number | undefined;
    const desktop = window.desktopBridge;
    const mac = isMacPlatform(navigator.platform);
    const releaseIdleMs = desktop
      ? SWIPE_REPLY_DESKTOP_RELEASE_FALLBACK_MS
      : SWIPE_REPLY_RELEASE_IDLE_MS;
    let quietMs = releaseIdleMs;
    let deltas: number[] = [];
    let reach = 0;
    const snapping = new Map<HTMLElement, number>();

    const clearMoved = (element: HTMLElement) => {
      window.clearTimeout(snapping.get(element));
      snapping.delete(element);
      element.style.removeProperty("transform");
      delete element.dataset.swipeReplyRelease;
    };
    // Laid out once per swipe; after that the row and indicator only move by transform.
    const measure = (element: HTMLElement) => {
      clearMoved(element);
      const surface = element.querySelector<HTMLElement>("[data-swipe-reply-surface]") ?? element;
      const rect = surface.getBoundingClientRect();
      const bounds = viewport.getBoundingClientRect();
      const middle = (Math.max(rect.top, bounds.top) + Math.min(rect.bottom, bounds.bottom)) / 2;
      reach = swipeReplyReach(rect, bounds.right);
      const indicator = indicatorRef.current;
      if (!indicator) return;
      indicator.style.left = `${rect.left - INDICATOR_SIZE_PX - INDICATOR_GAP_PX}px`;
      indicator.style.top = `${middle - INDICATOR_SIZE_PX / 2}px`;
    };
    const follow = (element: HTMLElement) => {
      const offset = swipeReplyOffset(gesture, reach);
      const armed = swipeReplyArmed(gesture);
      element.style.transform = `translate3d(${offset}px, 0, 0)`;
      const indicator = indicatorRef.current;
      if (!indicator) return;
      const progress = Math.min(1, offset / SWIPE_REPLY_THRESHOLD_PX);
      indicator.hidden = false;
      indicator.dataset.armed = String(armed);
      indicator.style.opacity = String(progress);
      indicator.style.transform = `translate3d(${offset}px, 0, 0) scale(${armed ? 1 : 0.5 + progress * 0.4})`;
    };
    // CSS springs the row back; the indicator goes the moment the fingers lift.
    const snapBack = (element: HTMLElement) => {
      element.dataset.swipeReplyRelease = "";
      element.style.transform = "translate3d(0, 0, 0)";
      snapping.set(
        element,
        window.setTimeout(() => clearMoved(element), SNAP_BACK_MS),
      );
      if (indicatorRef.current) indicatorRef.current.hidden = true;
    };
    const release = () => {
      const moved = gesture.phase === "tracking" ? row : null;
      const replied = swipeReplyArmed(gesture);
      row = null;
      deltas = [];
      gesture = replied ? IGNORED_SWIPE_REPLY : IDLE_SWIPE_REPLY;
      quietMs = replied ? REPLY_COOLDOWN_MS : releaseIdleMs;
      quietTimer = replied ? window.setTimeout(release, REPLY_COOLDOWN_MS) : undefined;
      if (!moved) return;
      snapBack(moved);
      if (replied) onReply(MessageId.make(moved.dataset.messageId!));
    };
    const lift = () => {
      window.clearTimeout(quietTimer);
      release();
    };
    const onWheel = (event: WheelEvent) => {
      // Shift turns a mouse wheel sideways. A pinch carries Control but never moves sideways.
      if (event.shiftKey) return;
      const travel = swipeReplyTravel(event);
      window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(release, quietMs);
      if (gesture.phase === "idle") {
        row = travel === null ? null : swipeRowAt(event.target, viewport);
        if (!row) gesture = IGNORED_SWIPE_REPLY;
      }
      if (travel === null || !row) return;
      if (gesture.phase === "tracking") {
        deltas = [...deltas.slice(1 - MOMENTUM_SAMPLE_SIZE), travel];
        // Chromium closes a trackpad scroll with an empty event; momentum decays steadily after it.
        // Short of the threshold, momentum still carries a flick far enough to arm.
        const lifted = (event.deltaX === 0 && event.deltaY === 0) || isMomentumTail(deltas);
        if (lifted && swipeReplyArmed(gesture)) return lift();
      }
      const wasTracking = gesture.phase === "tracking";
      gesture = stepSwipeReply(gesture, travel, event.deltaY, mac);
      if (gesture.phase !== "tracking") return;
      if (!wasTracking) measure(row);
      follow(row);
    };
    // The desktop app reports when the fingers touch and lift, so resting fingers never reply.
    const unsubscribeBegin = desktop?.onTrackpadScrollBegin(() => {
      if (gesture.phase === "tracking") return;
      gesture = IDLE_SWIPE_REPLY;
      quietMs = releaseIdleMs;
    });
    const unsubscribeEnd = desktop?.onTrackpadScrollEnd(() => {
      if (gesture.phase === "tracking") lift();
    });

    viewport.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      unsubscribeBegin?.();
      unsubscribeEnd?.();
      viewport.removeEventListener("wheel", onWheel);
      window.clearTimeout(quietTimer);
      if (row) clearMoved(row);
      for (const element of snapping.keys()) clearMoved(element);
      if (indicatorRef.current) indicatorRef.current.hidden = true;
    };
  }, [onReply, viewport]);

  return createPortal(
    <div
      ref={indicatorRef}
      aria-hidden="true"
      hidden
      data-armed="false"
      className="swipe-reply-indicator pointer-events-none fixed z-50 flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground shadow-xs data-[armed=true]:bg-primary data-[armed=true]:text-primary-foreground"
    >
      <ReplyIcon className="size-4" />
    </div>,
    document.body,
  );
}
