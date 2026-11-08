import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("shows no priority item or Resume now unless the state asks for them", () => {
    const ids = buildThreadActionMenuItems(baseState).map((item) => item.id);
    expect(ids).not.toContain("priority");
    expect(ids).not.toContain("resume-load-pause");
  });

  it.each([
    ["low", "low", "Priority: Low"],
    ["normal", "normal", "Priority: Normal"],
    ["default", "low", "Priority: Low"],
    ["default", "normal", "Priority: Normal"],
  ] as const)(
    "labels priority by the effective value and checks only the choice (%s → %s)",
    (choice, effective, label) => {
      const item = buildThreadActionMenuItems({
        ...baseState,
        priority: { choice, effective },
      }).find((candidate) => candidate.id === "priority");
      expect(item?.label).toBe(label);
      expect(item?.children?.filter((child) => child.checked).map((child) => child.id)).toEqual([
        `priority:${choice}`,
      ]);
    },
  );

  it("offers Resume now on a load-paused thread", () => {
    const ids = buildThreadActionMenuItems({ ...baseState, loadPaused: true }).map(
      (item) => item.id,
    );
    expect(ids).toContain("resume-load-pause");
  });

  it("disables priority and Resume now without permission", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      loadPaused: true,
      priority: { choice: "default", effective: "low" },
    });
    expect(items.find((item) => item.id === "resume-load-pause")?.disabled).toBe(true);
    const priority = items.find((item) => item.id === "priority");
    expect(priority?.disabled).toBe(true);
    expect(priority?.children?.every((child) => child.disabled)).toBe(true);
    for (const id of [
      "priority",
      "priority:low",
      "priority:normal",
      "priority:default",
      "resume-load-pause",
    ] as const) {
      expect(threadActionRequiresOperate(id)).toBe(true);
    }
  });

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});
