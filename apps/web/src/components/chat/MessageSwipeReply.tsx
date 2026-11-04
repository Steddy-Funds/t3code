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
  SWIPE_REPLY_SECTION_HOLD_MS as SECTION_HOLD_MS,
  SWIPE_REPLY_THRESHOLD_PX,
  type SwipeReplyGesture,
} from "./messageSwipeReply.logic";

// The spring in index.css settles within this; afterwards the row drops its inline styles.
const SNAP_BACK_MS = 340;
const INDICATOR_SIZE_PX = 28;
const INDICATOR_GAP_PX = 8;

const isEditable = (element: Element | null) =>
  element instanceof HTMLElement &&
  (element.isContentEditable || element.tagName === "INPUT" || element.tagName === "TEXTAREA");

/** The top-level Markdown block (heading, paragraph, list, code, quote, table) under the pointer. */
function sectionAt(target: EventTarget | null, viewport: HTMLElement): HTMLElement | null {
  if (!(target instanceof Element) || !swipeRowAt(target, viewport)) return null;
  const root = target.closest(".chat-markdown");
  if (!root) return null;
  let section: Element | null = target;
  while (section && section.parentElement !== root) section = section.parentElement;
  return section instanceof HTMLElement ? section : null;
}

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

/**
 * Two-finger swipe right on a message replies to it, like WhatsApp on macOS. Holding Cmd or Option
 * on macOS narrows the swipe to the Markdown section under the pointer.
 */
export function MessageSwipeReply({
  viewport,
  onReply,
}: {
  viewport: HTMLElement | null;
  onReply: (messageId: MessageId, section: HTMLElement | null) => void;
}) {
  const indicatorRef = useRef<HTMLDivElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows wheel gestures on the timeline viewport and moves the swiped row outside React
  useEffect(() => {
    if (!viewport) return;
    const mac = isMacPlatform(navigator.platform);
    // Elsewhere a lone Alt opens the window menu and Meta is the Super key.
    const isSectionModifier = (event: { metaKey: boolean; altKey: boolean }) =>
      mac && (event.metaKey || event.altKey);
    let gesture: SwipeReplyGesture = IDLE_SWIPE_REPLY;
    let row: HTMLElement | null = null;
    let section: HTMLElement | null = null;
    let quietTimer: number | undefined;
    const desktop = window.desktopBridge;
    const releaseIdleMs = desktop
      ? SWIPE_REPLY_DESKTOP_RELEASE_FALLBACK_MS
      : SWIPE_REPLY_RELEASE_IDLE_MS;
    let quietMs = releaseIdleMs;
    let deltas: number[] = [];
    let reach = 0;
    let holdTimer: number | undefined;
    let holding = false;
    let pointer: { x: number; y: number } | null = null;
    let highlighted: HTMLElement | null = null;
    const snapping = new Map<HTMLElement, number>();

    const clearMoved = (element: HTMLElement) => {
      window.clearTimeout(snapping.get(element));
      snapping.delete(element);
      element.style.removeProperty("transform");
      delete element.dataset.swipeReplyRelease;
    };
    const highlight = (next: HTMLElement | null) => {
      if (next === highlighted) return;
      highlighted?.removeAttribute("data-swipe-reply-section");
      next?.setAttribute("data-swipe-reply-section", "");
      highlighted = next;
    };
    const stopHolding = () => {
      window.clearTimeout(holdTimer);
      holding = false;
      if (gesture.phase === "idle") highlight(null);
    };
    const sectionUnderPointer = () =>
      pointer ? sectionAt(document.elementFromPoint(pointer.x, pointer.y), viewport) : null;
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
      const movedSection = section;
      const replied = swipeReplyArmed(gesture);
      row = null;
      deltas = [];
      section = null;
      gesture = replied ? IGNORED_SWIPE_REPLY : IDLE_SWIPE_REPLY;
      quietMs = replied ? REPLY_COOLDOWN_MS : releaseIdleMs;
      quietTimer = replied ? window.setTimeout(release, REPLY_COOLDOWN_MS) : undefined;
      highlight(null);
      if (!moved) return;
      snapBack(movedSection ?? moved);
      if (replied) onReply(MessageId.make(moved.dataset.messageId!), movedSection);
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
        section = row && isSectionModifier(event) ? sectionAt(event.target, viewport) : null;
        if (section) highlight(section);
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
      if (!wasTracking) measure(section ?? row);
      follow(section ?? row);
    };
    const onPointerMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      if (gesture.phase !== "idle") return;
      highlight(holding && isSectionModifier(event) ? sectionAt(event.target, viewport) : null);
    };
    const onPointerLeave = () => {
      pointer = null;
      if (gesture.phase === "idle") highlight(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat && holding) return;
      stopHolding();
      if (!isSectionModifier(event) || (event.key !== "Meta" && event.key !== "Alt")) return;
      // Option types characters on many layouts; only Cmd shows sections while typing.
      if (event.key === "Alt" && isEditable(document.activeElement)) return;
      holdTimer = window.setTimeout(() => {
        holding = true;
        highlight(sectionUnderPointer());
      }, SECTION_HOLD_MS);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!isSectionModifier(event)) stopHolding();
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
    if (mac) {
      viewport.addEventListener("pointermove", onPointerMove, { passive: true });
      viewport.addEventListener("pointerleave", onPointerLeave);
      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("keyup", onKeyUp, true);
      window.addEventListener("blur", stopHolding);
    }
    return () => {
      unsubscribeBegin?.();
      unsubscribeEnd?.();
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("pointermove", onPointerMove);
      viewport.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", stopHolding);
      window.clearTimeout(quietTimer);
      window.clearTimeout(holdTimer);
      highlight(null);
      if (section) clearMoved(section);
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
