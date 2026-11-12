import { describe, expect, it } from "vite-plus/test";

import { sbsKeyAction } from "./sbsKeymap";

const chord = (key: string, modifiers: Partial<Parameters<typeof sbsKeyAction>[0]> = {}) => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...modifiers,
});

describe("sbsKeyAction", () => {
  it.each([
    { name: "F7", event: chord("F7"), expected: "nextChange" },
    { name: "Shift+F7", event: chord("F7", { shiftKey: true }), expected: "previousChange" },
    { name: "F4", event: chord("F4"), expected: "jumpToSource" },
    { name: "Cmd+Down", event: chord("ArrowDown", { metaKey: true }), expected: "jumpToSource" },
    { name: "Ctrl+Down", event: chord("ArrowDown", { ctrlKey: true }), expected: "jumpToSource" },
    { name: "Down", event: chord("ArrowDown"), expected: null },
    {
      name: "Shift+Cmd+Down",
      event: chord("ArrowDown", { metaKey: true, shiftKey: true }),
      expected: null,
    },
    { name: "Shift+F4", event: chord("F4", { shiftKey: true }), expected: null },
    { name: "Cmd+F7", event: chord("F7", { metaKey: true }), expected: null },
    { name: "Ctrl+F4", event: chord("F4", { ctrlKey: true }), expected: null },
    { name: "Alt+F7", event: chord("F7", { altKey: true }), expected: null },
    {
      name: "Alt+Cmd+Down",
      event: chord("ArrowDown", { altKey: true, metaKey: true }),
      expected: null,
    },
    { name: "Enter", event: chord("Enter"), expected: null },
  ])("reads $name as $expected", ({ event, expected }) => {
    expect(sbsKeyAction(event)).toBe(expected);
  });
});
