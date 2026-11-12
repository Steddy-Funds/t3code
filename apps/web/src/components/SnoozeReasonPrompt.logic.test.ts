import { DEFAULT_SNOOZE_REASONS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  answerSnoozeReason,
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
