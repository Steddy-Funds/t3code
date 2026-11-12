import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { QuoteIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { isGlintDialogOpen } from "~/lib/glint";
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
  SWIPE_REPLY_COOLDOWN_MS,
  SWIPE_REPLY_DESKTOP_RELEASE_FALLBACK_MS,
  SWIPE_REPLY_RELEASE_IDLE_MS,
  SWIPE_REPLY_THRESHOLD_PX,
  type SwipeReplyGesture,
} from "../chat/messageSwipeReply.logic";
import { mentionThreadContext } from "../chat/threadContextDrag";

// The spring in index.css settles within this; afterwards the row drops its inline styles.
const SNAP_BACK_MS = 340;
const INDICATOR_SIZE_PX = 28;
const INDICATOR_GAP_PX = 8;

/**
 * Cmd + two-finger swipe right on a sidebar thread mentions it in the composer, as dropping it
 * there does. Rides the message swipe-reply gesture; a plain swipe is left to history and scroll.
 */
export function SidebarSwipeMention({ list }: { list: HTMLElement | null }) {
  const indicatorRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows wheel gestures on the sidebar thread list and moves the swiped row outside React
  useEffect(() => {
    if (!list || !isMacPlatform(navigator.platform)) return;
    let gesture: SwipeReplyGesture = IDLE_SWIPE_REPLY;
    let item: HTMLElement | null = null;
    let row: HTMLElement | null = null;
    let quietTimer: number | undefined;
    const desktop = window.desktopBridge;
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
    const measure = (element: HTMLElement) => {
      clearMoved(element);
      const rect = element.getBoundingClientRect();
      reach = swipeReplyReach(rect, list.getBoundingClientRect().right);
      const indicator = indicatorRef.current;
      if (!indicator) return;
      indicator.style.left = `${rect.left - INDICATOR_SIZE_PX - INDICATOR_GAP_PX}px`;
      indicator.style.top = `${(rect.top + rect.bottom) / 2 - INDICATOR_SIZE_PX / 2}px`;
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
      const threadKey = item?.dataset.threadItem;
      const mentioned = swipeReplyArmed(gesture);
      item = null;
      row = null;
      deltas = [];
      gesture = mentioned ? IGNORED_SWIPE_REPLY : IDLE_SWIPE_REPLY;
      quietMs = mentioned ? SWIPE_REPLY_COOLDOWN_MS : releaseIdleMs;
      quietTimer = mentioned ? window.setTimeout(release, SWIPE_REPLY_COOLDOWN_MS) : undefined;
      if (!moved) return;
      snapBack(moved);
      const ref = mentioned && threadKey ? parseScopedThreadKey(threadKey) : null;
      if (ref) mentionThreadContext([ref]);
    };
    const lift = () => {
      window.clearTimeout(quietTimer);
      release();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.shiftKey || isGlintDialogOpen()) return;
      const travel = swipeReplyTravel(event);
      window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(release, quietMs);
      if (gesture.phase === "idle") {
        item =
          travel !== null && event.metaKey && event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-thread-item]")
            : null;
        row = item?.querySelector<HTMLElement>("[data-sidebar-row]") ?? null;
        if (!row) gesture = IGNORED_SWIPE_REPLY;
      }
      if (travel === null || !row) return;
      if (gesture.phase === "tracking") {
        deltas = [...deltas.slice(1 - MOMENTUM_SAMPLE_SIZE), travel];
        const lifted = (event.deltaX === 0 && event.deltaY === 0) || isMomentumTail(deltas);
        if (lifted && swipeReplyArmed(gesture)) return lift();
      }
      const wasTracking = gesture.phase === "tracking";
      gesture = stepSwipeReply(gesture, travel, event.deltaY, true);
      if (gesture.phase !== "tracking") return;
      if (!wasTracking) measure(row);
      follow(row);
    };
    const unsubscribeBegin = desktop?.onTrackpadScrollBegin(() => {
      if (gesture.phase === "tracking") return;
      gesture = IDLE_SWIPE_REPLY;
      quietMs = releaseIdleMs;
    });
    const unsubscribeEnd = desktop?.onTrackpadScrollEnd(() => {
      if (gesture.phase === "tracking") lift();
    });

    list.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      unsubscribeBegin?.();
      unsubscribeEnd?.();
      list.removeEventListener("wheel", onWheel);
      window.clearTimeout(quietTimer);
      if (row) clearMoved(row);
      for (const element of snapping.keys()) clearMoved(element);
      if (indicatorRef.current) indicatorRef.current.hidden = true;
    };
  }, [list]);

  return createPortal(
    <div
      ref={indicatorRef}
      aria-hidden="true"
      hidden
      data-armed="false"
      className="swipe-reply-indicator pointer-events-none fixed z-50 flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground shadow-xs data-[armed=true]:bg-primary data-[armed=true]:text-primary-foreground"
    >
      <QuoteIcon className="size-4" />
    </div>,
    document.body,
  );
}
