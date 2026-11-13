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
function stubOpenableHelper({ focused = null }: { readonly focused?: FakeElement | null } = {}) {
  const settles: Array<(outcome: HelperOutcome) => void> = [];
  const sent: Array<{ type: string; id: string }> = [];
  const listeners = new Map<string, Set<EventListener>>();
  const body = {};
  const document = { activeElement: focused ?? body, body };
  if (focused) {
    focused.blur = () => {
      document.activeElement = body;
    };
    focused.focus = () => {
      document.activeElement = focused;
    };
  }
  vi.stubGlobal("document", document);
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
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    },
  });
  /** Dispatches a page event; true when the page would have heard it. */
  const dispatch = (type: string, init: { button?: number; target?: unknown } = {}) => {
    let heard = true;
    const event = {
      type,
      button: init.button ?? 0,
      target: init.target ?? null,
      preventDefault: () => {
        heard = false;
      },
      stopImmediatePropagation: () => {},
    } as unknown as Event;
    for (const listener of listeners.get(type) ?? []) listener(event);
    return heard;
  };
  return {
    settle: (outcome: HelperOutcome) => settles.at(-1)?.(outcome),
    sent,
    document,
    dispatch,
    shielded: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
    [Symbol.dispose]: () => vi.unstubAllGlobals(),
  };
}

interface FakeElement {
  isConnected: boolean;
  contains: (node: unknown) => boolean;
  blur?: () => void;
  focus?: () => void;
}

/** A trigger button holding `children`, attached to the page. */
function fakeElement(children: ReadonlyArray<unknown> = []): FakeElement {
  const element: FakeElement = {
    isConnected: true,
    contains: (node) => node === element || children.includes(node),
  };
  return element;
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
  ] as const)("is open, shielding the page, until %s", async (_name, outcome) => {
    using helper = stubOpenableHelper();
    const shown = presentGlint("model", { x: 0, y: 0 }, PARAMS);
    expect(isGlintDialogOpen()).toBe(true);
    for (const type of [
      "wheel",
      "pointerdown",
      "mousedown",
      "click",
      "contextmenu",
      "touchstart",
    ]) {
      expect(helper.dispatch(type)).toBe(false);
    }
    helper.settle(outcome);
    await shown;
    expect(isGlintDialogOpen()).toBe(false);
    expect(helper.shielded()).toBe(0);
    expect(helper.dispatch("click")).toBe(true);
  });

  it("forwards one click per primary click, and none after it closes", async () => {
    using helper = stubOpenableHelper();
    const shown = presentGlint("timeFromNow", fakeElement() as unknown as Element, {
      title: "Snooze until",
    });
    helper.dispatch("pointerdown");
    helper.dispatch("mousedown");
    helper.dispatch("click");
    helper.dispatch("auxclick", { button: 1 });
    helper.dispatch("contextmenu", { button: 2 });
    expect(helper.sent.map((message) => message.type)).toEqual(["click"]);
    helper.settle({ type: "result", value: { date: "2026-11-12T12:00:00.000Z" } });
    await shown;
    helper.dispatch("click");
    expect(helper.sent.map((message) => message.type)).toEqual(["click"]);
  });

  it("closes when its trigger is clicked through the shield", async () => {
    using helper = stubOpenableHelper();
    const icon = {};
    const trigger = fakeElement([icon]);
    const shown = presentGlint("model", trigger as unknown as Element, PARAMS);
    expect(helper.dispatch("pointerdown", { target: icon })).toBe(false);
    expect(helper.dispatch("click", { target: icon })).toBe(false);
    expect(helper.sent.map((message) => message.type)).toEqual(["dismiss"]);
    expect(await shown).toEqual({ type: "cancelled" });
    // Closed by T3 itself, so the next click opens it again.
    expect(glintTriggerAction(trigger as unknown as Element, 0)).toBe("native");
  });

  it("stays open through the click of the press that opened it", async () => {
    using helper = stubOpenableHelper();
    const icon = {};
    const trigger = fakeElement([icon]);
    // A menu trigger presents on pointerdown, before the shield is up; the rest of the press lands.
    const shown = presentGlint("timeFromNow", trigger as unknown as Element, {
      title: "Snooze until",
    });
    expect(helper.dispatch("mousedown", { target: icon })).toBe(false);
    expect(helper.dispatch("pointerup", { target: icon })).toBe(false);
    expect(helper.dispatch("click", { target: icon })).toBe(false);
    expect(helper.sent).toEqual([]);
    expect(isGlintDialogOpen()).toBe(true);
    // The next press on the trigger closes it.
    helper.dispatch("pointerdown", { target: icon });
    helper.dispatch("click", { target: icon });
    expect(helper.sent.map((message) => message.type)).toEqual(["dismiss"]);
    expect(await shown).toEqual({ type: "cancelled" });
  });

  it("takes focus from the trigger and gives it back after", async () => {
    const trigger = fakeElement();
    using helper = stubOpenableHelper({ focused: trigger });
    const shown = presentGlint("model", trigger as unknown as Element, PARAMS);
    expect(helper.document.activeElement).toBe(helper.document.body);
    helper.settle({ type: "cancelled" });
    await shown;
    expect(helper.document.activeElement).toBe(trigger);
  });

  it("leaves focus where the page moved it while the dialog was up", async () => {
    const trigger = fakeElement();
    using helper = stubOpenableHelper({ focused: trigger });
    const shown = presentGlint("model", trigger as unknown as Element, PARAMS);
    const field = {};
    helper.document.activeElement = field;
    helper.settle({ type: "cancelled" });
    await shown;
    expect(helper.document.activeElement).toBe(field);
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
