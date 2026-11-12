// @effect-diagnostics nodeBuiltinImport:off -- The suite spawns the mock helper fixture as a real executable.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { makeGlintHelper, toScreenAnchor } from "./GlintHelper.ts";

const MOCK = NodePath.resolve(import.meta.dirname, "../../test/fixtures/glint-mock-helper.mjs");
const ANCHOR = { x: 10, y: 20, width: 30, height: 40 };

/** An executable that runs the mock in `mode`, as the app would spawn the real helper. */
function mockHelper(
  mode: string,
  delayMs = 0,
  onEvent?: (message: { type: string; id: string }) => void,
) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "glint-mock-"));
  const path = NodePath.join(directory, "glint-helper");
  NodeFS.writeFileSync(
    path,
    `#!/bin/sh\nGLINT_MOCK_MODE=${mode} GLINT_MOCK_DELAY_MS=${delayMs} exec "${process.execPath}" "${MOCK}"\n`,
    { mode: 0o755 },
  );
  const helper = makeGlintHelper(path, { readyTimeoutMs: 10_000, ...(onEvent ? { onEvent } : {}) });
  return {
    helper,
    [Symbol.dispose]: () => {
      helper.dispose();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("GlintHelper", () => {
  it("returns the helper's value for a present", async () => {
    using mock = mockHelper("result");
    const outcome = await mock.helper.present("d1", "model", ANCHOR, {
      providers: [
        {
          id: "claude",
          name: "Claude",
          models: [
            { id: "a", name: "A", efforts: ["low", "high"], supportsFast: true },
            { id: "b", name: "B", efforts: ["low", "max"], supportsFast: true },
          ],
        },
      ],
      selection: { provider: "claude", model: "a", effort: "low", fast: false },
    });
    expect(outcome).toEqual({
      type: "result",
      value: { selection: { provider: "claude", model: "b", effort: "max", fast: true } },
    });
  });

  it("cancels the shown dialog when another is presented, and on dismiss", async () => {
    using mock = mockHelper("result", 60_000);
    const first = mock.helper.present("d1", "color", ANCHOR, {});
    const second = mock.helper.present("d2", "timeFromNow", ANCHOR, { title: "Snooze until" });
    expect(await first).toEqual({ type: "cancelled" });
    expect(mock.helper.send({ type: "dismiss", id: "d1" })).toBe(false);
    expect(mock.helper.send({ type: "dismiss", id: "d2" })).toBe(true);
    expect(await second).toEqual({ type: "cancelled" });
  });

  it("forwards messages to the open dialog and its events back", async () => {
    const changed = Promise.withResolvers<{ type: string; id: string }>();
    using mock = mockHelper("result", 60_000, changed.resolve);
    const shown = mock.helper.present("p1", "commandPalette", ANCHOR, { sections: [] });
    // Sent while the helper is still starting: queued behind the present.
    expect(mock.helper.send({ type: "input", id: "p1", text: "the" })).toBe(true);
    expect(await changed.promise).toEqual({
      type: "changed",
      id: "p1",
      path: [],
      highlighted: null,
      text: "the",
    });
    expect(mock.helper.send({ type: "present", id: "p1" })).toBe(false);
    mock.helper.send({ type: "dismiss", id: "p1" });
    expect(await shown).toEqual({ type: "cancelled" });
  });

  it.each([
    { mode: "error", message: "mock error" },
    { mode: "crash", message: "The Glint helper exited (code 3)." },
  ])("reports a helper $mode as unavailable", async ({ mode, message }) => {
    using mock = mockHelper(mode);
    expect(await mock.helper.present("d1", "color", ANCHOR, {})).toEqual({
      type: "unavailable",
      message,
    });
  });

  it("reports a missing helper as unavailable", async () => {
    const helper = makeGlintHelper("/nonexistent/glint-helper");
    const outcome = await helper.present("d1", "color", ANCHOR, {});
    expect(outcome.type).toBe("unavailable");
  });

  it("places a zoomed renderer rect in screen points", () => {
    expect(toScreenAnchor(ANCHOR, { x: 100, y: 50 }, 1.5)).toEqual({
      x: 115,
      y: 80,
      width: 45,
      height: 60,
    });
  });
});
