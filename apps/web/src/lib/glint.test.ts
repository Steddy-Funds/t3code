import { describe, expect, it, vi } from "vite-plus/test";

import { presentGlint } from "./glint";

function stubHelperValue(value: unknown) {
  vi.stubGlobal("window", {
    desktopBridge: { glint: { present: async () => ({ type: "result", value }) } },
  });
  return { [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

const PARAMS = { providers: [], selection: { provider: "claude", model: "opus" } };

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
});
