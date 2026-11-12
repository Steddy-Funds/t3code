import { DEFAULT_SNOOZE_REASONS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  answerSnoozeReason,
  glintSnoozeReasonParams,
  JOIN_OPEN_PROMPT_MS,
  promptSnoozeReasons,
  requestSnoozeReason,
  useSnoozeReasonPrompt,
} from "./SnoozeReasonPrompt.logic";

const reasons = DEFAULT_SNOOZE_REASONS;
const request = { anchor: null, reasons };

describe("promptSnoozeReasons", () => {
  it("offers the first four shown reasons, and the defaults when fewer than two are shown", () => {
    const many = ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id, shown: id !== "b" }));
    expect(promptSnoozeReasons(many).map((reason) => reason.id)).toEqual(["a", "c", "d", "e"]);
    expect(promptSnoozeReasons([{ id: "a", label: "A", shown: true }])).toBe(
      DEFAULT_SNOOZE_REASONS,
    );
  });
});

describe("requestSnoozeReason", () => {
  it("gives a multi-select snooze one prompt and one answer", async () => {
    useSnoozeReasonPrompt.setState({ open: null });
    const first = requestSnoozeReason(request, 1_000);
    const second = requestSnoozeReason(request, 1_000 + JOIN_OPEN_PROMPT_MS - 1);
    answerSnoozeReason({ id: "later", label: "Later" });
    await expect(first).resolves.toEqual({ id: "later", label: "Later" });
    await expect(second).resolves.toEqual({ id: "later", label: "Later" });
    expect(useSnoozeReasonPrompt.getState().open).toBeNull();
  });

  it("records a prompt left open as skipped when a later snooze replaces it", async () => {
    useSnoozeReasonPrompt.setState({ open: null });
    const stale = requestSnoozeReason(request, 1_000);
    const fresh = requestSnoozeReason(request, 1_000 + JOIN_OPEN_PROMPT_MS);
    await expect(stale).resolves.toBeNull();
    answerSnoozeReason(null);
    await expect(fresh).resolves.toBeNull();
  });
});

describe("glintSnoozeReasonParams", () => {
  it("gives each reason its symbol, a tag for custom ones, and declines outside 2–4", () => {
    const custom = { id: "custom-1", label: "Meeting", shown: true };
    expect(glintSnoozeReasonParams([...reasons.slice(0, 3), custom])?.options).toEqual([
      { id: "not-now", label: "Not now", symbol: "hand.raised" },
      { id: "later", label: "Later", symbol: "clock" },
      { id: "blocked-irl", label: "Blocked IRL", symbol: "figure.walk" },
      { id: "custom-1", label: "Meeting", symbol: "tag" },
    ]);
    expect(glintSnoozeReasonParams(reasons)?.options.at(-1)?.symbol).toBe("ellipsis");
    expect(glintSnoozeReasonParams([...reasons, custom])).toBeNull();
    expect(glintSnoozeReasonParams(reasons.slice(0, 1))).toBeNull();
  });
});

describe("requestSnoozeReason through Glint", () => {
  const anchored = { anchor: { x: 10, y: 20, width: 200, height: 30 }, reasons };

  function stubGlint(outcome: unknown) {
    const present = vi.fn(async (_input: unknown) => outcome);
    vi.stubGlobal("window", {
      desktopBridge: { glint: { isAvailable: () => true, present } },
    });
    useSnoozeReasonPrompt.setState({ open: null });
    return { present, [Symbol.dispose]: () => vi.unstubAllGlobals() };
  }

  /** Resolves once the native dialog has handed the prompt to the popover. */
  function settled() {
    return new Promise<void>((resolve) => {
      const unsubscribe = useSnoozeReasonPrompt.subscribe((state) => {
        if (state.open?.native === false) {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  it("asks natively at the row and records the picked reason", async () => {
    using glint = stubGlint({ type: "result", value: { id: "later" } });
    const answer = requestSnoozeReason(anchored, 1_000);
    expect(useSnoozeReasonPrompt.getState().open?.native).toBe(true);
    await expect(answer).resolves.toEqual({ id: "later", label: "Later" });
    expect(glint.present).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "choice",
        anchor: anchored.anchor,
        params: expect.objectContaining({ title: "Why snooze?" }),
      }),
    );
  });

  it("opens the popover at the note step after Other", async () => {
    using _glint = stubGlint({ type: "result", value: { id: "other" } });
    const handedOver = settled();
    const answer = requestSnoozeReason(anchored, 1_000);
    await handedOver;
    expect(useSnoozeReasonPrompt.getState().open).toMatchObject({
      native: false,
      noteFor: { id: "other" },
    });
    answerSnoozeReason({ id: "other", label: "Other", note: "lunch" });
    await expect(answer).resolves.toEqual({ id: "other", label: "Other", note: "lunch" });
  });

  it.each([
    ["the helper fails", { type: "unavailable", message: "crashed" }],
    ["the helper answers an unknown id", { type: "result", value: { id: "nope" } }],
  ])("falls back to the popover's choices when %s", async (_case, outcome) => {
    using _glint = stubGlint(outcome);
    const handedOver = settled();
    void requestSnoozeReason(anchored, 1_000);
    await handedOver;
    const open = useSnoozeReasonPrompt.getState().open;
    expect(open?.native).toBe(false);
    expect(open?.noteFor).toBeUndefined();
    answerSnoozeReason(null);
  });

  it("uses the popover without an anchor or with more than four reasons", () => {
    using glint = stubGlint({ type: "cancelled" });
    void requestSnoozeReason(request, 1_000);
    expect(useSnoozeReasonPrompt.getState().open?.native).toBe(false);
    answerSnoozeReason(null);
    const five = [...reasons, { id: "e", label: "E", shown: true }];
    void requestSnoozeReason({ ...anchored, reasons: five }, 1_000);
    expect(useSnoozeReasonPrompt.getState().open?.native).toBe(false);
    answerSnoozeReason(null);
    expect(glint.present).not.toHaveBeenCalled();
  });

  it("records a cancelled native prompt as skipped", async () => {
    using _glint = stubGlint({ type: "cancelled" });
    await expect(requestSnoozeReason(anchored, 1_000)).resolves.toBeNull();
    expect(useSnoozeReasonPrompt.getState().open).toBeNull();
  });
});
