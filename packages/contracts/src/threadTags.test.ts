import { describe, expect, it } from "vite-plus/test";

import { effectiveThreadPriority } from "./threadTags.ts";

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
