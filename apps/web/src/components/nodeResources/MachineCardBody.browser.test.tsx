import "~/index.css";

import type { MachineIndicatorView } from "@t3tools/client-runtime/state/machineFormat";
import type {
  GpuDeviceSample,
  MachineStatusSnapshot,
  MachineTotalsSummary,
  MachineVerdictReason,
} from "@t3tools/contracts";

import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { MachineCardBody, type MachineProcessList } from "./MachineCardBody";

const GIB = 1024 ** 3;

const OK: MachineIndicatorView = {
  verdict: "ok",
  unreachable: false,
  reason: null,
  lastSeen: null,
};

const TOTALS: MachineTotalsSummary = {
  cpuUtilization: 0.42,
  cpuCount: 8,
  load: { one: 8, five: 12, fifteen: 4 },
  memoryTotalBytes: 32 * GIB,
  memoryAvailableBytes: 8 * GIB,
  swapTotalBytes: 0,
  swapUsedBytes: 0,
  memoryPressure: null,
};

const snapshot = (totals: MachineTotalsSummary | null = TOTALS): MachineStatusSnapshot => ({
  sequence: 1,
  verdict: "ok",
  verdictAgeMs: 0,
  reason: null,
  sampleAgeMs: 0,
  totals,
});

const READY: MachineProcessList = {
  status: "ready",
  source: "host",
  rows: [
    { name: "claude", cpu: 40, rss: 2 * GIB },
    { name: "claude", cpu: 30, rss: GIB },
    { name: "node", cpu: 50, rss: 500 * 1024 ** 2 },
  ],
};

function renderBody({
  view = OK,
  snap = snapshot(),
  processes = READY,
}: {
  view?: MachineIndicatorView;
  snap?: MachineStatusSnapshot | null;
  processes?: MachineProcessList;
} = {}) {
  return render(<MachineCardBody view={view} snapshot={snap} processes={processes} />, {
    router: false, // presentational, no links
  });
}

const textOf = (screen: { readonly container: HTMLElement }) => screen.container.textContent ?? "";
const skeletonCount = (screen: { readonly container: HTMLElement }) =>
  screen.container.querySelectorAll('[data-slot="skeleton"]').length;

const VERDICT_OR_HINT =
  /Stressed|No sample yet|Unreachable|needs the resource monitor|needs diagnostics access/;

describe("MachineCardBody", () => {
  it("is quiet when ok: totals and processes, no verdict or hint lines", async () => {
    await using screen = await renderBody();
    const text = textOf(screen);
    expect(text).not.toMatch(VERDICT_OR_HINT);
    expect(text).toContain("42%");
    expect(text).toContain("24.0 / 32.0 GiB · 75%");
    expect(text).toContain("claude ×2");
    expect(text).toContain("Top by CPU");
    expect(text).not.toContain("· T3");
    expect(skeletonCount(screen)).toBe(0);
  });

  it("shows totals skeletons until the first snapshot arrives", async () => {
    await using screen = await renderBody({ snap: null });
    expect(skeletonCount(screen)).toBeGreaterThan(0);
    expect(textOf(screen)).not.toContain("GiB");
  });

  it("unknown with no totals shows only the no-sample line above processes", async () => {
    await using screen = await renderBody({
      view: { ...OK, verdict: "unknown" },
      snap: snapshot(null),
    });
    const text = textOf(screen);
    expect(text).toContain("No sample yet");
    expect(text).toMatch(/^No sample yetTop by CPU/);
    expect(text).not.toContain("GiB");
    expect(skeletonCount(screen)).toBe(0);
  });

  it("unreachable dims the last totals with their age and drops the process section", async () => {
    await using screen = await renderBody({
      view: { ...OK, unreachable: true, lastSeen: { verdict: "ok", ageMs: 120_000 } },
    });
    const text = textOf(screen);
    expect(text).toContain("Unreachable, last seen 2 m ago");
    expect(text).toContain("42% · 2 m old");
    expect(text).not.toContain("Top by");
    const dimmed = [...screen.container.querySelectorAll("div")].filter(
      (div) => getComputedStyle(div).opacity === "0.5",
    );
    expect(dimmed.some((div) => div.textContent?.includes("Memory"))).toBe(true);
  });

  it("unreachable with no snapshot shows no skeletons", async () => {
    await using screen = await renderBody({
      view: { ...OK, unreachable: true },
      snap: null,
    });
    expect(textOf(screen)).toContain("Unreachable");
    expect(skeletonCount(screen)).toBe(0);
  });

  it.each([
    [{ status: "needs-monitor" }, "Process list needs the resource monitor"],
    [{ status: "needs-scope" }, "Process list needs diagnostics access"],
    [{ status: "error", message: "ps exited 1" }, "ps exited 1"],
  ] satisfies ReadonlyArray<[MachineProcessList, string]>)(
    "process state %j shows its notice",
    async (processes, notice) => {
      await using screen = await renderBody({ processes });
      expect(textOf(screen)).toContain(notice);
      expect(textOf(screen)).not.toContain("Top by");
    },
  );

  it("loading processes shows skeleton columns", async () => {
    await using screen = await renderBody({ processes: { status: "loading" } });
    expect(textOf(screen)).toContain("Top by CPU");
    expect(skeletonCount(screen)).toBe(6);
  });

  it("marks a T3-scoped process list", async () => {
    await using screen = await renderBody({ processes: { ...READY, source: "t3" } });
    expect(textOf(screen)).toContain("Top by CPU · T3");
    expect(textOf(screen)).toContain("Top by memory · T3");
  });

  it.each([
    ["normal", null],
    ["warn", "Pressure warn"],
    ["critical", "Pressure critical"],
  ] as const)("macOS pressure %s replaces the RAM percent", async (memoryPressure, label) => {
    await using screen = await renderBody({ snap: snapshot({ ...TOTALS, memoryPressure }) });
    const text = textOf(screen);
    expect(text).toContain("24.0 / 32.0 GiB");
    expect(text).not.toContain("GiB · 75%");
    if (label) expect(text).toContain(label);
    else expect(text).not.toContain("Pressure");
  });

  describe("GPU section", () => {
    const gpu = (id: string, name: string): GpuDeviceSample => ({
      id,
      vendor: "nvidia",
      name,
      status: "active",
      utilPercent: 37,
      vramTotalBytes: 24 * GIB,
      vramUsedBytes: 6 * GIB,
      sharedMemory: false,
    });
    const withGpus = (gpus?: ReadonlyArray<GpuDeviceSample>): MachineStatusSnapshot => ({
      ...snapshot(),
      sample: { perCore: [10], ...(gpus ? { gpus } : {}) },
    });
    const VRAM_RULE: MachineVerdictReason = {
      rule: "gpuVram",
      value: 95,
      threshold: 90,
      heldForMs: 0,
      deviceId: "gpu-0",
    };
    /** The GPU each red value belongs to. */
    const tripped = (screen: { readonly container: HTMLElement }) =>
      [...screen.container.querySelectorAll("span.text-error-foreground")].flatMap((el) => {
        const name = el.parentElement?.firstElementChild?.textContent ?? "";
        return name.startsWith("RTX") ? [`${name}: ${el.textContent}`] : [];
      });

    it.each([
      ["one device", [gpu("gpu-0", "RTX 4090")], "GPU"],
      ["two devices", [gpu("gpu-0", "RTX 4090"), gpu("gpu-1", "RTX 3060")], "GPUs"],
    ])("renders %s under its title", async (_name, gpus, title) => {
      await using screen = await renderBody({ snap: withGpus(gpus) });
      const text = textOf(screen);
      expect(text).toContain(`${title}RTX 4090`);
      for (const device of gpus) expect(text).toContain(device.name);
      expect(text).toContain("6.0 / 24.0 GiB37%");
    });

    it.each([
      ["an empty device list", withGpus([])],
      ["no gpus field", withGpus()],
      ["no sample", snapshot()],
    ])("is absent with %s", async (_name, snap) => {
      await using screen = await renderBody({ snap });
      expect(textOf(screen)).not.toMatch(/GPU|RTX/);
    });

    it("marks only the device the rule names", async () => {
      await using screen = await renderBody({
        view: { ...OK, verdict: "stressed", reason: VRAM_RULE },
        snap: withGpus([gpu("gpu-0", "RTX 4090"), gpu("gpu-1", "RTX 3060")]),
      });
      expect(tripped(screen)).toEqual(["RTX 4090: 6.0 / 24.0 GiB"]);
    });

    it("marks nothing on an unreachable machine's last GPUs", async () => {
      await using screen = await renderBody({
        view: {
          ...OK,
          verdict: "unknown",
          unreachable: true,
          reason: VRAM_RULE,
          lastSeen: { verdict: "stressed", ageMs: 60_000 },
        },
        snap: withGpus([gpu("gpu-0", "RTX 4090")]),
      });
      expect(textOf(screen)).toContain("RTX 4090");
      expect(tripped(screen)).toEqual([]);
    });
  });
});
