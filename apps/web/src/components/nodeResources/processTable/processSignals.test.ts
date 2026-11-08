import { describe, expect, it } from "vite-plus/test";

import { isProcessChangedRefusal, processSignalChoices } from "./processSignals";

describe("processSignalChoices", () => {
  it.each([
    { os: "windows", processSigterm: true, choices: ["SIGKILL"] },
    { os: "windows", processSigterm: false, choices: ["SIGKILL"] },
    { os: "linux", processSigterm: true, choices: ["SIGTERM", "SIGKILL"] },
    { os: "darwin", processSigterm: true, choices: ["SIGTERM", "SIGKILL"] },
    { os: "linux", processSigterm: false, choices: ["SIGINT", "SIGKILL"] },
    { os: null, processSigterm: false, choices: ["SIGINT", "SIGKILL"] },
    { os: null, processSigterm: true, choices: ["SIGTERM", "SIGKILL"] },
  ] as const)("$os with processSigterm $processSigterm offers $choices", (input) => {
    expect(processSignalChoices(input)).toEqual(input.choices);
  });
});

describe("isProcessChangedRefusal", () => {
  it.each([
    ["Process 42 no longer matches the requested identity.", true],
    // The recheck itself failed; the pid may still be the same process.
    ["Refusing to signal a stale identity", false],
    ["Process 42 is not a live descendant of the server.", true],
    [null, false],
    ["Operation not permitted", false],
    ["", false],
  ])("%j → %s", (message, changed) => {
    expect(isProcessChangedRefusal(message)).toBe(changed);
  });
});
