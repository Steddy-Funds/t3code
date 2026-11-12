import { DEFAULT_CLIENT_SETTINGS, type SnapShotShortcut } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  createDoubleShiftDetector,
  type DoubleShiftKey,
  isDoubleShiftSearchOn,
} from "./doubleShift";

type Step = readonly [
  type: "down" | "up",
  key: string,
  at: number,
  extra?: Partial<DoubleShiftKey>,
];

function run(steps: ReadonlyArray<Step>): ReadonlyArray<boolean> {
  const detector = createDoubleShiftDetector();
  return steps.map(([type, key, at, extra]) =>
    detector.key({
      type: type === "down" ? "keydown" : "keyup",
      key,
      repeat: false,
      otherModifier: false,
      timeStamp: at,
      ...extra,
    }),
  );
}

const fired = (steps: ReadonlyArray<Step>) => run(steps).includes(true);

describe("double Shift", () => {
  it("fires on the second Shift press within 300 ms of the first", () => {
    expect(
      run([
        ["down", "Shift", 0],
        ["up", "Shift", 60],
        ["down", "Shift", 300],
      ]),
    ).toEqual([false, false, true]);
  });

  it.each<[string, ReadonlyArray<Step>]>([
    [
      "a key between the taps",
      [
        ["down", "Shift", 0],
        ["up", "Shift", 50],
        ["down", "a", 100],
        ["up", "a", 120],
        ["down", "Shift", 150],
      ],
    ],
    [
      "the second press too late",
      [
        ["down", "Shift", 0],
        ["up", "Shift", 50],
        ["down", "Shift", 301],
      ],
    ],
    [
      "Shift held through another key (shift-selection)",
      [
        ["down", "Shift", 0],
        ["down", "ArrowRight", 40],
        ["up", "Shift", 80],
        ["down", "Shift", 120],
      ],
    ],
    [
      "a second press while the first is still held",
      [
        ["down", "Shift", 0],
        ["down", "Shift", 100],
      ],
    ],
    [
      "auto-repeat of a held Shift",
      [
        ["down", "Shift", 0],
        ["up", "Shift", 50],
        ["down", "Shift", 100, { repeat: true }],
      ],
    ],
    [
      "Shift pressed with another modifier",
      [
        ["down", "Shift", 0, { otherModifier: true }],
        ["up", "Shift", 50],
        ["down", "Shift", 100],
      ],
    ],
  ])("does not fire on %s", (_case, steps) => {
    expect(fired(steps)).toBe(false);
  });

  it("does not fire across a reset, as a click between the taps causes", () => {
    const detector = createDoubleShiftDetector();
    const key = (type: "keydown" | "keyup", timeStamp: number) =>
      detector.key({ type, key: "Shift", repeat: false, otherModifier: false, timeStamp });
    key("keydown", 0);
    key("keyup", 50);
    detector.reset();
    expect(key("keydown", 100)).toBe(false);
  });

  it("starts over after firing, so a third tap does not fire again", () => {
    expect(
      run([
        ["down", "Shift", 0],
        ["up", "Shift", 40],
        ["down", "Shift", 80],
        ["up", "Shift", 120],
        ["down", "Shift", 160],
      ]),
    ).toEqual([false, false, true, false, false]);
  });

  it("is on by default and off while SnapShot captures with both Shift keys", () => {
    expect(isDoubleShiftSearchOn(DEFAULT_CLIENT_SETTINGS)).toBe(true);
    expect(
      isDoubleShiftSearchOn({ ...DEFAULT_CLIENT_SETTINGS, doubleShiftSearchEnabled: false }),
    ).toBe(false);
    const snapShot = (snapShotEnabled: boolean, snapShotShortcut: SnapShotShortcut) =>
      isDoubleShiftSearchOn({ ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled, snapShotShortcut });
    expect(snapShot(true, { kind: "both-shift-keys" })).toBe(false);
    expect(snapShot(true, { kind: "modifier-pair", modifier: "shift" })).toBe(false);
    expect(snapShot(true, { kind: "modifier-pair", modifier: "meta" })).toBe(true);
    expect(snapShot(false, { kind: "both-shift-keys" })).toBe(true);
  });
});
