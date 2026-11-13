import { describe, expect, it } from "@effect/vitest";

import { glintKeyMessage, makeGlintKeyLock, type GlintKeyInput } from "./GlintInput.ts";

function key(
  keyName: string,
  overrides: Partial<GlintKeyInput> = {},
  code = `Key${keyName.toUpperCase()}`,
): GlintKeyInput {
  return {
    type: "keyDown",
    key: keyName,
    code,
    meta: false,
    control: false,
    alt: false,
    shift: false,
    isAutoRepeat: false,
    ...overrides,
  };
}

describe("glintKeyMessage", () => {
  it.each([
    ["Enter", { key: "return" }],
    ["Escape", { key: "escape" }],
    [" ", { key: "space" }],
    ["ArrowUp", { key: "up" }],
    ["PageDown", { key: "pageDown" }],
    ["End", { key: "end" }],
    ["a", { key: "char", text: "a" }],
    ["é", { key: "char", text: "é" }],
    ["👍🏽", { key: "char", text: "👍🏽" }],
  ] as const)("maps %j", (name, expected) => {
    expect(glintKeyMessage("d1", key(name))).toEqual({ type: "key", id: "d1", ...expected });
  });

  it("lists held modifiers", () => {
    expect(
      glintKeyMessage(
        "d1",
        key("ArrowLeft", { shift: true, alt: true, meta: true, control: true }),
      ),
    ).toEqual({
      type: "key",
      id: "d1",
      key: "left",
      modifiers: ["shift", "option", "command", "control"],
    });
  });

  it.each(["Shift", "Meta", "F5", "Dead", "Unidentified"])("has no message for %s", (name) => {
    expect(glintKeyMessage("d1", key(name))).toBeNull();
  });

  it("repeats navigation and text, never accept, close or toggle", () => {
    const repeat = { isAutoRepeat: true };
    expect(glintKeyMessage("d1", key("ArrowDown", repeat))).toMatchObject({ key: "down" });
    expect(glintKeyMessage("d1", key("Backspace", repeat))).toMatchObject({ key: "backspace" });
    expect(glintKeyMessage("d1", key("x", repeat))).toMatchObject({ key: "char", text: "x" });
    for (const name of ["Enter", "Escape", "Tab", " "]) {
      expect(glintKeyMessage("d1", key(name, repeat))).toBeNull();
    }
  });
});

describe("makeGlintKeyLock", () => {
  it("leaves keys alone while no dialog is up", () => {
    const lock = makeGlintKeyLock("darwin");
    expect(lock.handle(key("Enter", {}, "Enter"))).toEqual({ prevent: false, forward: null });
  });

  it("keeps every key from the page and forwards keyDowns", () => {
    const lock = makeGlintKeyLock("darwin");
    lock.open("d1");
    expect(lock.handle(key("Enter", {}, "Enter"))).toEqual({
      prevent: true,
      forward: { type: "key", id: "d1", key: "return" },
    });
    expect(lock.handle(key("Shift", { shift: true }, "ShiftLeft"))).toEqual({
      prevent: true,
      forward: null,
    });
    expect(lock.handle(key("Enter", { type: "keyUp" }, "Enter")).prevent).toBe(true);
  });

  it("keeps a key's keyUp from the page after the dialog it went to closes", () => {
    const lock = makeGlintKeyLock("darwin");
    lock.open("d1");
    lock.handle(key(" ", {}, "Space"));
    lock.close("d1");
    expect(lock.handle(key(" ", { type: "keyUp" }, "Space")).prevent).toBe(true);
    // Only once: the next press is the page's again.
    expect(lock.handle(key(" ", {}, "Space"))).toEqual({ prevent: false, forward: null });
    expect(lock.handle(key(" ", { type: "keyUp" }, "Space")).prevent).toBe(false);
  });

  it("forwards nothing once closed, and ignores a stale close", () => {
    const lock = makeGlintKeyLock("darwin");
    lock.open("d1");
    lock.open("d2");
    lock.close("d1");
    expect(lock.handle(key("a")).forward).toEqual({
      type: "key",
      id: "d2",
      key: "char",
      text: "a",
    });
    lock.close("d2");
    expect(lock.handle(key("b")).forward).toBeNull();
  });

  it.each([
    ["darwin", "Cmd+Q", key("q", { meta: true })],
    ["darwin", "Cmd+W", key("w", { meta: true })],
    ["darwin", "Option+Cmd+I", key("ˆ", { meta: true, alt: true }, "KeyI")],
    ["linux", "Ctrl+Q", key("q", { control: true })],
    ["linux", "Ctrl+Shift+I", key("I", { control: true, shift: true }, "KeyI")],
  ] as const)("passes %s %s through", (platform, _name, input) => {
    const lock = makeGlintKeyLock(platform);
    lock.open("d1");
    expect(lock.handle(input)).toEqual({ prevent: false, forward: null });
    expect(lock.handle({ ...input, type: "keyUp" }).prevent).toBe(false);
  });

  it.each([
    ["Cmd+Shift+W", key("w", { meta: true, shift: true })],
    ["Cmd+R", key("r", { meta: true })],
    ["Ctrl+Q on macOS", key("q", { control: true })],
  ] as const)("holds %s for the dialog", (_name, input) => {
    const lock = makeGlintKeyLock("darwin");
    lock.open("d1");
    expect(lock.handle(input).prevent).toBe(true);
  });
});
