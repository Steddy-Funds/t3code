import {
  LOAD_PAUSE_MAX_MS,
  LOW_PRIORITY_THREAD_TAG,
  NORMAL_PRIORITY_THREAD_TAG,
  type OrchestrationV2LoadPause,
  RunId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatLoadPauseReason,
  loadPauseDeadlineMs,
  loadPauseDescription,
  loadPausedContainerNames,
  loadPauseResumeShown,
  loadPriorityControlsShown,
  threadPriorityChoice,
} from "./loadPause.ts";

type Config = NonNullable<Parameters<typeof loadPriorityControlsShown>[0]>;

const config = (loadPause: boolean | undefined, enabled: boolean): Config =>
  ({
    environment: { capabilities: loadPause === undefined ? {} : { loadPause } },
    settings: { machineResources: { loadManagement: { enabled } } },
  }) as unknown as Config;

const FULL_ID = "a".repeat(12) + "b".repeat(52);

const pause = (overrides: Partial<OrchestrationV2LoadPause> = {}): OrchestrationV2LoadPause => ({
  runId: RunId.make("run:1"),
  episodeId: "episode:1",
  pausedAt: "2026-11-08T10:00:00.000Z",
  reason: { rule: "load", value: 4.25, threshold: 3, shareOfLoad: 0.4 },
  containersPaused: [],
  ...overrides,
});

describe("loadPriorityControlsShown", () => {
  it.each([
    ["no config", null, false],
    ["config not loaded", undefined, false],
    ["stock server without the capability", config(undefined, true), false],
    ["capability off", config(false, true), false],
    ["capability on, lane off", config(true, false), false],
    ["capability on, lane on", config(true, true), true],
  ] as const)("%s", (_name, input, shown) => {
    expect(loadPriorityControlsShown(input)).toBe(shown);
  });
});

describe("loadPauseResumeShown", () => {
  it.each([
    ["no pause", config(true, true), null, false],
    ["pause undefined", config(true, true), undefined, false],
    ["no config", null, pause(), false],
    ["stock server", config(undefined, true), pause(), false],
    ["capability off", config(false, true), pause(), false],
    // A pause can outlive the lane switch by a moment; Resume stays reachable.
    ["capability on, lane off", config(true, false), pause(), true],
    ["capability on, lane on", config(true, true), pause(), true],
  ] as const)("%s", (_name, input, current, shown) => {
    expect(loadPauseResumeShown(input, current)).toBe(shown);
  });
});

describe("threadPriorityChoice", () => {
  it.each([
    [[NORMAL_PRIORITY_THREAD_TAG, LOW_PRIORITY_THREAD_TAG], "normal"],
    [[LOW_PRIORITY_THREAD_TAG, NORMAL_PRIORITY_THREAD_TAG], "normal"],
    [[LOW_PRIORITY_THREAD_TAG], "low"],
    [[NORMAL_PRIORITY_THREAD_TAG], "normal"],
    [["backgrounded"], "default"],
    [[], "default"],
    [undefined, "default"],
  ] as const)("%j → %s", (tags, choice) => {
    expect(threadPriorityChoice({ tags })).toBe(choice);
  });
});

describe("loadPauseDeadlineMs", () => {
  it("is pausedAt plus the 30 min cap", () => {
    expect(loadPauseDeadlineMs(pause())).toBe(
      Date.parse("2026-11-08T10:00:00.000Z") + LOAD_PAUSE_MAX_MS,
    );
    expect(LOAD_PAUSE_MAX_MS).toBe(30 * 60_000);
  });
});

describe("formatLoadPauseReason", () => {
  it("renders the 0–1 share as a percent after the known rule's text", () => {
    expect(formatLoadPauseReason(pause().reason)).toBe(
      "load 4.3 / 3 per core; this thread is 40% of the load",
    );
  });

  it("falls back to rule value / threshold for a rule this client does not know", () => {
    expect(
      formatLoadPauseReason({ rule: "npuUtil", value: 97, threshold: 90, shareOfLoad: 0.16 }),
    ).toBe("npuUtil 97 / 90; this thread is 16% of the load");
  });
});

describe("loadPausedContainerNames", () => {
  it("cuts a 64-hex id to 12 characters and leaves names and short ids whole", () => {
    expect(
      loadPausedContainerNames(
        pause({
          containersPaused: [
            { id: FULL_ID },
            { id: "pod-pr5-app-1", dockerHost: "unix:///run/docker.sock" },
            { id: "abc123def456" },
            // 64 characters but not hex: a name.
            { id: "z".repeat(64) },
          ],
        }),
      ),
    ).toEqual(["a".repeat(12), "pod-pr5-app-1", "abc123def456", "z".repeat(64)]);
  });
});

describe("loadPauseDescription", () => {
  const head =
    "Machine stressed: load 4.3 / 3 per core; this thread is 40% of the load. " +
    "Continues when the machine clears, at the latest 10:30.";
  it.each([
    ["nothing else", [], 0, head],
    ["one container", [{ id: FULL_ID }], 0, `${head} Container ${"a".repeat(12)} paused too.`],
    ["two containers", [{ id: "web" }, { id: "db" }], 0, `${head} Containers web, db paused too.`],
    ["one held run", [], 1, `${head} 1 queued message sends after resume.`],
    ["three held runs", [], 3, `${head} 3 queued messages send after resume.`],
    [
      "both",
      [{ id: "web" }],
      2,
      `${head} Container web paused too. 2 queued messages send after resume.`,
    ],
  ] as const)("%s", (_name, containersPaused, heldRuns, text) => {
    expect(
      loadPauseDescription({ pause: pause({ containersPaused }), deadline: "10:30", heldRuns }),
    ).toBe(text);
  });
});
