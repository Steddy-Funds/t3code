import { describe, expect, it } from "vite-plus/test";

import {
  IDLE_SWIPE_REPLY,
  stepSwipeReply,
  swipeReplyArmed,
  swipeReplyOffset,
  swipeReplyReach,
  swipeReplyTravel,
  SWIPE_REPLY_THRESHOLD_PX,
  type SwipeReplyGesture,
} from "./messageSwipeReply.logic";

function run(
  deltas: ReadonlyArray<readonly [travel: number, cross: number]>,
  mac = false,
): SwipeReplyGesture {
  return deltas.reduce<SwipeReplyGesture>(
    (gesture, [travel, cross]) => stepSwipeReply(gesture, travel, cross, mac),
    IDLE_SWIPE_REPLY,
  );
}

describe("stepSwipeReply", () => {
  it.each<
    [string, ReadonlyArray<readonly [number, number]>, SwipeReplyGesture["phase"], armed: boolean]
  >([
    ["waits for a clear axis before it moves the row", [[2, 1]], "deciding", false],
    ["follows a swipe to the right", [[10, 1]], "tracking", false],
    [
      "arms once the swipe passes the threshold",
      [
        [10, 0],
        [20, 1],
        [30, 0],
      ],
      "tracking",
      true,
    ],
    [
      "disarms when the fingers pull back before release",
      [
        [20, 0],
        [20, 0],
        [20, 0],
        [-10, 0],
      ],
      "tracking",
      false,
    ],
    ["leaves vertical scrolling alone", [[1, 12]], "ignored", false],
    ["leaves a diagonal scroll alone", [[8, 5]], "ignored", false],
    ["leaves a swipe to the left alone", [[-10, 0]], "ignored", false],
    ["leaves a mouse wheel notch or tilt alone", [[100, 0]], "ignored", false],
    [
      "stays ignored when a scroll turns sideways",
      [
        [0, 20],
        [80, 0],
      ],
      "ignored",
      false,
    ],
  ])("%s", (_name, deltas, phase, armed) => {
    const gesture = run(deltas);
    expect(gesture.phase).toBe(phase);
    expect(swipeReplyArmed(gesture)).toBe(armed);
  });

  it.each<[string, ReadonlyArray<readonly [number, number]>, SwipeReplyGesture["phase"], boolean]>([
    // Chromium holds a swipe that starts on touchdown and delivers its first stretch at once.
    [
      "follows a swipe that starts on touchdown",
      [
        [45, 2],
        [60, 3],
      ],
      "tracking",
      true,
    ],
    ["still leaves vertical scrolling alone", [[2, 40]], "ignored", false],
  ])("on macOS, %s", (_name, deltas, phase, armed) => {
    const gesture = run(deltas, true);
    expect(gesture.phase).toBe(phase);
    expect(swipeReplyArmed(gesture)).toBe(armed);
  });

  it("does not move the row left of where it started when the swipe reverses", () => {
    expect(
      run([
        [20, 0],
        [-50, 0],
      ]),
    ).toEqual({ phase: "tracking", travel: 0 });
  });
});

describe("swipeReplyOffset", () => {
  it("follows the fingers to the threshold, then ever more slowly toward its reach", () => {
    const reach = swipeReplyReach({ left: 100, right: 900 }, 1000);
    expect(reach).toBe(500);
    const offset = (travel: number) => swipeReplyOffset({ phase: "tracking", travel }, reach);
    expect(offset(30)).toBe(30);
    expect(offset(SWIPE_REPLY_THRESHOLD_PX)).toBe(SWIPE_REPLY_THRESHOLD_PX);
    const steps = [60, 100, 200, 400].map(
      (travel) =>
        offset(SWIPE_REPLY_THRESHOLD_PX + travel) - offset(SWIPE_REPLY_THRESHOLD_PX + travel - 1),
    );
    expect(
      steps.every((step, index) => step > 0 && (index === 0 || step < steps[index - 1]!)),
    ).toBe(true);
    // A long swipe keeps going a good way, but half the message stays on screen.
    expect(offset(SWIPE_REPLY_THRESHOLD_PX + 300)).toBeGreaterThan(SWIPE_REPLY_THRESHOLD_PX + 150);
    expect(offset(100_000)).toBeLessThan(reach);
  });

  it("still moves a message at the viewport edge past the threshold", () => {
    expect(swipeReplyReach({ left: 900, right: 1000 }, 1000)).toBeGreaterThan(
      SWIPE_REPLY_THRESHOLD_PX,
    );
  });
});

describe("swipeReplyTravel", () => {
  it("follows the fingers: natural scrolling reports a swipe right as negative deltaX", () => {
    expect(swipeReplyTravel({ deltaX: -12, deltaMode: 0 })).toBe(12);
    expect(swipeReplyTravel({ deltaX: -3, deltaMode: 1 })).toBeNull();
  });
});
