import { describe, expect, it } from "vite-plus/test";

import { formatCpuTime, formatSamplingStatus } from "./ResourceTelemetryDiagnostics.logic";

describe("formatCpuTime", () => {
  it("switches units when rounding reaches the next unit", () => {
    expect([59.94, 59.97, 3_599.7, 3_600].map((seconds) => formatCpuTime(seconds))).toEqual([
      "59.9s",
      "1m",
      "1h",
      "1h",
    ]);
  });
});

describe("formatSamplingStatus", () => {
  it("reads an idle interval as on demand rather than every 0 ms", () => {
    expect([0, 500, 2_000].map((intervalMs) => formatSamplingStatus(intervalMs))).toEqual([
      "Sampling on demand",
      "Sampling every 500 ms",
      "Sampling every 2 seconds",
    ]);
  });
});
