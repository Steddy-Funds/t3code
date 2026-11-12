import { describe, expect, it } from "vite-plus/test";

import { idleSummary } from "./ThreadDetailsResources.logic";

describe("idleSummary", () => {
  it("is all null with no history", () => {
    expect(idleSummary([])).toEqual({
      lastActiveMs: null,
      peakCpuPercent: null,
      peakMemoryBytes: null,
    });
  });

  it("takes the newest age and the peak CPU and memory", () => {
    expect(
      idleSummary([
        { ageMs: 90_000, cpuPercent: 12, memoryBytes: 500, gpuUtilPercent: null },
        { ageMs: 30_000, cpuPercent: 80, memoryBytes: 200, gpuUtilPercent: 5 },
        { ageMs: 60_000, cpuPercent: 3, memoryBytes: 900, gpuUtilPercent: null },
      ]),
    ).toEqual({ lastActiveMs: 30_000, peakCpuPercent: 80, peakMemoryBytes: 900 });
  });
});
