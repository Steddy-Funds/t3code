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
  { env = "", watchdogMs }: { readonly env?: string; readonly watchdogMs?: number } = {},
) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "glint-mock-"));
  const path = NodePath.join(directory, "glint-helper");
  NodeFS.writeFileSync(
    path,
    `#!/bin/sh\nGLINT_MOCK_MODE=${mode} GLINT_MOCK_DELAY_MS=${delayMs} ${env} exec "${process.execPath}" "${MOCK}"\n`,
    { mode: 0o755 },
  );
  // The mock echoes each line it reads to stderr, which the helper logs.
  const received: Array<{ type: string; key?: string }> = [];
  const waiters: Array<{ type: string; resolve: () => void }> = [];
  const warnings: Array<string> = [];
  const log = (line: string) => {
    if (line.startsWith("glint: protocol warning: ")) warnings.push(line);
    for (const json of line.split("\n")) {
      const match = /glint-mock: (.*)$/.exec(json);
      if (!match?.[1]) continue;
      const message = JSON.parse(match[1]) as { type: string; key?: string };
      received.push(message);
      for (const waiter of waiters.filter((entry) => entry.type === message.type)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  const helper = makeGlintHelper(path, {
    readyTimeoutMs: 10_000,
    log,
    ...(onEvent ? { onEvent } : {}),
    ...(watchdogMs === undefined ? {} : { watchdogMs }),
  });
  return {
    helper,
    received,
    warnings,
    /** Resolves once the mock has read a message of `type`. */
    reads: (type: string) =>
      received.some((message) => message.type === type)
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ type, resolve })),
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

  describe("forwarded input", () => {
    const V2 = { env: "GLINT_MOCK_VERSION=2" };

    it.each([
      ["return", { type: "result", value: { hex: "#3A7BD5", action: "pick" } }],
      ["escape", { type: "cancelled" }],
    ] as const)("v2: a forwarded %s closes the dialog", async (key, outcome) => {
      using mock = mockHelper("result", 60_000, undefined, V2);
      const shown = mock.helper.present("d1", "color", ANCHOR, {});
      // Queued behind the present while the helper starts.
      expect(mock.helper.sendInput({ type: "key", id: "d1", key })).toBe(true);
      expect(await shown).toEqual(outcome);
      expect(mock.received.map((message) => message.type)).toEqual(["present", "key"]);
    });

    it("v2: forwards a click and passes the dialog's answer back", async () => {
      const clicked = Promise.withResolvers<{ type: string; id: string }>();
      using mock = mockHelper("result", 60_000, clicked.resolve, V2);
      const shown = mock.helper.present("d1", "timeFromNow", ANCHOR, { title: "Snooze until" });
      expect(mock.helper.send({ type: "click", id: "d1" })).toBe(true);
      expect(await clicked.promise).toEqual({ type: "clicked", id: "d1" });
      mock.helper.send({ type: "dismiss", id: "d1" });
      expect(await shown).toEqual({ type: "cancelled" });
    });

    it("v1: Escape dismisses, other input is dropped", async () => {
      using mock = mockHelper("result", 60_000);
      const shown = mock.helper.present("d1", "color", ANCHOR, {});
      // Once ready, when the helper's version is known.
      await mock.reads("present");
      expect(mock.helper.sendInput({ type: "key", id: "d1", key: "return" })).toBe(false);
      expect(mock.helper.send({ type: "click", id: "d1" })).toBe(false);
      expect(mock.helper.sendInput({ type: "key", id: "d1", key: "escape" })).toBe(true);
      expect(await shown).toEqual({ type: "cancelled" });
      await mock.reads("dismiss");
      expect(mock.received.map((message) => message.type)).toEqual(["present", "dismiss"]);
    });

    it("closes a dialog whose helper never answers a forwarded Return", async () => {
      using mock = mockHelper("result", 60_000, undefined, {
        env: "GLINT_MOCK_VERSION=2 GLINT_MOCK_DEAF=1",
        watchdogMs: 20,
      });
      const shown = mock.helper.present("d1", "color", ANCHOR, {});
      mock.helper.sendInput({ type: "key", id: "d1", key: "return" });
      expect(await shown).toEqual({ type: "cancelled" });
      await mock.reads("dismiss");
      expect(mock.received.map((message) => message.type)).toEqual(["present", "key", "dismiss"]);
    });

    it("logs an error for no dialog and keeps the open one", async () => {
      using mock = mockHelper("result", 60_000, undefined, V2);
      const shown = mock.helper.present("d1", "color", ANCHOR, {});
      // A key line with no key name: the helper answers with an id-less error.
      expect(mock.helper.send({ type: "key", id: "d1" })).toBe(true);
      expect(mock.helper.sendInput({ type: "key", id: "d1", key: "return" })).toBe(true);
      expect(await shown).toEqual({ type: "result", value: { hex: "#3A7BD5", action: "pick" } });
      expect(mock.warnings).toEqual(["glint: protocol warning: key needs a key"]);
    });

    it("forwards nothing once the dialog has closed", async () => {
      using mock = mockHelper("result", 0, undefined, V2);
      await mock.helper.present("d1", "color", ANCHOR, {});
      expect(mock.helper.sendInput({ type: "key", id: "d1", key: "escape" })).toBe(false);
      expect(mock.helper.send({ type: "click", id: "d1" })).toBe(false);
    });

    it("closes on a helper crash with input pending", async () => {
      using mock = mockHelper("crash", 0, undefined, V2);
      const shown = mock.helper.present("d1", "color", ANCHOR, {});
      mock.helper.sendInput({ type: "key", id: "d1", key: "down" });
      expect((await shown).type).toBe("unavailable");
      expect(mock.helper.sendInput({ type: "key", id: "d1", key: "down" })).toBe(false);
    });
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
