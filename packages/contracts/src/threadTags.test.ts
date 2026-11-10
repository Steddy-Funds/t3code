import { describe, expect, it } from "vite-plus/test";

import { effectiveThreadPriority, threadAutonomy } from "./threadTags.ts";

describe("effectiveThreadPriority", () => {
  it.each([
    [undefined, "normal"],
    [[], "normal"],
    [["backgrounded"], "low"],
    [["priority:low"], "low"],
    [["priority:normal"], "normal"],
    [["backgrounded", "priority:normal"], "normal"],
    [["priority:low", "priority:normal"], "normal"],
    [["orchestrator"], "normal"],
  ] as const)("tags %j give %s", (tags, priority) => {
    expect(effectiveThreadPriority({ tags })).toBe(priority);
  });
});

describe("threadAutonomy", () => {
  it.each([
    [undefined, "default"],
    [[], "default"],
    [["autonomy:on"], "on"],
    [["autonomy:off"], "off"],
    [["autonomy:on", "autonomy:off"], "off"],
    [["autonomy:off", "autonomy:on"], "off"],
    [["Autonomy:On"], "default"],
  ] as const)("tags %j give %s", (tags, autonomy) => {
    expect(threadAutonomy({ tags })).toBe(autonomy);
  });
});
