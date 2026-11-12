import { describe, expect, it, vi } from "vite-plus/test";

import {
  GLINT_TRIGGER_CLOSE_MS,
  glintTriggerAction,
  isGlintDialogOpen,
  presentGlint,
} from "./glint";

type HelperOutcome =
  | { readonly type: "result"; readonly value: unknown }
  | { readonly type: "cancelled" }
  | { readonly type: "unavailable"; readonly message: string };

function stubHelperValue(value: unknown) {
  vi.stubGlobal("window", {
    desktopBridge: { glint: { present: async () => ({ type: "result", value }) } },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  return { [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

/** A helper whose dialog stays up until the test settles it, as the real one does. */
function stubOpenableHelper() {
  const settles: Array<(outcome: HelperOutcome) => void> = [];
  const sent: Array<{ type: string; id: string }> = [];
  const wheelListeners = new Set<EventListener>();
  vi.stubGlobal("window", {
    desktopBridge: {
      glint: {
        isAvailable: () => true,
        present: () =>
          new Promise<HelperOutcome>((resolve) => {
            settles.push(resolve);
          }),
        send: async (message: { type: string; id: string }) => {
          sent.push(message);
          if (message.type === "dismiss") settles.at(-1)?.({ type: "cancelled" });
          return true;
        },
      },
    },
    addEventListener: (type: string, listener: EventListener) => {
      if (type === "wheel") wheelListeners.add(listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      if (type === "wheel") wheelListeners.delete(listener);
    },
  });
  return {
    settle: (outcome: HelperOutcome) => settles.at(-1)?.(outcome),
    sent,
    wheelListeners,
    [Symbol.dispose]: () => vi.unstubAllGlobals(),
  };
}

const PARAMS = { providers: [], selection: { provider: "claude", model: "opus" } };
const RESULT = { selection: { provider: "claude", model: "sonnet" } };

describe("presentGlint", () => {
  it("reads a model result and ignores fields it does not know", async () => {
    using _helper = stubHelperValue({
      selection: { provider: "claude", model: "sonnet", effort: "high", future: 1 },
      opened: { provider: "claude", model: "opus" },
    });
    expect(await presentGlint("model", { x: 0, y: 0 }, PARAMS)).toEqual({
      type: "result",
      value: { selection: { provider: "claude", model: "sonnet", effort: "high" } },
    });
  });

  it("falls back to the web UI on a value that does not fit its kind", async () => {
    using _helper = stubHelperValue({ selection: { provider: "claude" } });
    expect(await presentGlint("model", { x: 0, y: 0 }, PARAMS)).toEqual({ type: "unavailable" });
  });

  it.each([
    ["a result", { type: "result", value: RESULT }],
    ["a cancel", { type: "cancelled" }],
    ["an error", { type: "unavailable", message: "The Glint helper exited." }],
  ] as const)("is open, swallowing window wheels, until %s", async (_name, outcome) => {
    using helper = stubOpenableHelper();
    const shown = presentGlint("model", { x: 0, y: 0 }, PARAMS);
    expect(isGlintDialogOpen()).toBe(true);
    expect(helper.wheelListeners.size).toBe(1);
    helper.settle(outcome);
    await shown;
    expect(isGlintDialogOpen()).toBe(false);
    expect(helper.wheelListeners.size).toBe(0);
  });

  it("closes on a dismiss sent by a second click on its trigger", async () => {
    using helper = stubOpenableHelper();
    const trigger = {} as Element;
    const shown = presentGlint("timeFromNow", trigger, { title: "Snooze until" });
    expect(glintTriggerAction(trigger, 0)).toBe("close");
    expect(helper.sent.map((message) => message.type)).toEqual(["dismiss"]);
    expect(await shown).toEqual({ type: "cancelled" });
    expect(isGlintDialogOpen()).toBe(false);
    // Closed by T3 itself, so a later click opens it again.
    expect(glintTriggerAction(trigger, 0)).toBe("native");
  });
});

describe("glintTriggerAction", () => {
  it("opens the web UI without the helper", () => {
    vi.stubGlobal("window", {});
    using _restore = { [Symbol.dispose]: () => vi.unstubAllGlobals() };
    expect(glintTriggerAction({} as Element)).toBe("web");
    expect(glintTriggerAction(null)).toBe("web");
  });

  it.each([
    ["stays closed for a click just after the helper's own cancel", 0, "close"],
    ["opens again once that cancel is old", GLINT_TRIGGER_CLOSE_MS, "native"],
  ] as const)("%s", async (_name, afterMs, action) => {
    using helper = stubOpenableHelper();
    using _now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const trigger = {} as Element;
    const shown = presentGlint("model", trigger, PARAMS);
    helper.settle({ type: "cancelled" });
    await shown;
    expect(glintTriggerAction(trigger, 1_000 + afterMs)).toBe(action);
    // The cancel counts for one click only.
    expect(glintTriggerAction(trigger, 1_000)).toBe("native");
  });

  it("ignores a recent cancel of another trigger's dialog", async () => {
    using helper = stubOpenableHelper();
    const shown = presentGlint("model", {} as Element, PARAMS);
    helper.settle({ type: "cancelled" });
    await shown;
    expect(glintTriggerAction({} as Element)).toBe("native");
  });
});
