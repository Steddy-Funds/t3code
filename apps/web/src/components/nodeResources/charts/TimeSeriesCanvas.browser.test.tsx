import "~/index.css";

import { Profiler, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { SeriesRing } from "./SeriesRing";
import { TimeSeriesCanvas } from "./TimeSeriesCanvas";

function sizedContainer(): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = "240px";
  container.style.height = "80px";
  return container;
}

async function renderProfiled(chart: () => ReactNode) {
  const onRender = vi.fn();
  const profiled = () => (
    <Profiler id="chart" onRender={onRender}>
      {chart()}
    </Profiler>
  );
  await using stack = new AsyncDisposableStack();
  // A bare canvas needs no router.
  const screen = stack.use(
    await render(profiled(), { container: sizedContainer(), router: false }),
  );
  const canvas = screen.container.querySelector("canvas");
  if (!canvas) throw new Error("canvas not rendered");
  const owned = stack.move();
  return {
    screen,
    canvas,
    onRender,
    rerender: () => screen.rerender(profiled()),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

/** Resolves once the chart's own shared observers have delivered their first entries. */
function observersSettled(element: Element): Promise<void> {
  const resized = new Promise<void>((resolve) => {
    const observer = new ResizeObserver(() => {
      observer.disconnect();
      resolve();
    });
    observer.observe(element);
  });
  const intersected = new Promise<void>((resolve) => {
    const observer = new IntersectionObserver(() => {
      observer.disconnect();
      resolve();
    });
    observer.observe(element);
  });
  return Promise.all([resized, intersected]).then(() => undefined);
}

function paintedAlpha(canvas: HTMLCanvasElement): number {
  const context = canvas.getContext("2d");
  if (!context || canvas.width === 0 || canvas.height === 0) return 0;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let alpha = 0;
  for (let index = 3; index < data.length; index += 4) alpha += data[index] ?? 0;
  return alpha;
}

describe("TimeSeriesCanvas", () => {
  it("draws a ring tick without a React render", async () => {
    const ring = SeriesRing.create();
    const label = () => `CPU ${ring.latest()}`;
    await using chart = await renderProfiled(() => (
      <TimeSeriesCanvas ring={ring} lines={[{ column: 0 }]} label={label} />
    ));
    const image = chart.screen.getByRole("img");
    await expect.element(image).toHaveAttribute("aria-label", "CPU NaN");
    expect(paintedAlpha(chart.canvas)).toBe(0);
    const renders = chart.onRender.mock.calls.length;

    ring.push([20], 1000);
    ring.push([80], 2000);
    await expect.element(image).toHaveAttribute("aria-label", "CPU 80");
    expect(paintedAlpha(chart.canvas)).toBeGreaterThan(0);

    ring.seed([[10, 30, 50]], 1000, 10_000);
    await expect.element(image).toHaveAttribute("aria-label", "CPU 50");

    expect(chart.onRender).toHaveBeenCalledTimes(renders);
  });

  it("coalesces ticks in one frame into a single draw of the newest data", async () => {
    const ring = SeriesRing.create();
    const label = vi.fn(() => `CPU ${ring.latest()}`);
    await using chart = await renderProfiled(() => (
      <TimeSeriesCanvas ring={ring} lines={[{ column: 0 }]} label={label} />
    ));
    await observersSettled(chart.canvas);
    using frames = vi.spyOn(window, "requestAnimationFrame");
    const drawsBefore = label.mock.results.length;

    ring.push([1], 1000);
    ring.push([2], 2000);
    ring.push([3], 3000);

    // Zero when a resize frame was already pending; never one per push.
    expect(frames.mock.calls.length).toBeLessThanOrEqual(1);
    await expect.element(chart.screen.getByRole("img")).toHaveAttribute("aria-label", "CPU 3");
    const labels = label.mock.results.slice(drawsBefore).map((result) => result.value);
    expect(labels).not.toContain("CPU 1");
    expect(labels).not.toContain("CPU 2");
  });

  it("redraws when a render brings new props, without any data change", async () => {
    const ring = SeriesRing.create();
    ring.push([40], 1000);
    let suffix = "";
    await using chart = await renderProfiled(() => (
      <TimeSeriesCanvas
        ring={ring}
        lines={[{ column: 0 }, { column: 1, dashed: true }]}
        max={100}
        threshold={90}
        tripped={suffix !== ""}
        label={() => `CPU ${ring.latest()}${suffix}`}
      />
    ));
    const image = chart.screen.getByRole("img");
    await expect.element(image).toHaveAttribute("aria-label", "CPU 40");

    suffix = ", over threshold";
    await chart.rerender();
    await expect.element(image).toHaveAttribute("aria-label", "CPU 40, over threshold");
  });

  it("draws a dashed secondary and missing samples without throwing", async () => {
    const ring = SeriesRing.create({ columns: 2 });
    ring.seed(
      [
        [10, Number.NaN, 30, 40],
        [5, 6],
      ],
      1000,
      4000,
    );
    await using chart = await renderProfiled(() => (
      <TimeSeriesCanvas
        ring={ring}
        lines={[{ column: 0 }, { column: 1, color: "--muted-foreground", dashed: true }]}
        label={() => `Memory ${ring.latest(0)}, swap ${ring.latest(1)}`}
      />
    ));
    await expect
      .element(chart.screen.getByRole("img"))
      .toHaveAttribute("aria-label", "Memory 40, swap NaN");
    expect(paintedAlpha(chart.canvas)).toBeGreaterThan(0);
  });

  it("redraws at the new device pixel ratio when it changes", async () => {
    const ring = SeriesRing.create();
    ring.push([10], 1000);
    ring.push([20], 2000);
    await using chart = await renderProfiled(() => (
      <TimeSeriesCanvas ring={ring} lines={[{ column: 0 }]} label={() => "CPU"} />
    ));
    const session = cdp();
    await vi.waitFor(() => expect(chart.canvas.width).toBe(240 * (window.devicePixelRatio || 1)));
    const ratio = (window.devicePixelRatio || 1) === 2 ? 3 : 2;

    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 0,
      height: 0,
      deviceScaleFactor: ratio,
      mobile: false,
    });
    await using _restore = {
      [Symbol.asyncDispose]: () => session.send("Emulation.clearDeviceMetricsOverride"),
    };

    await vi.waitFor(() => expect(chart.canvas.width).toBe(240 * ratio));
    expect(chart.canvas.height).toBe(80 * ratio);
  });

  it("stops drawing once unmounted", async () => {
    const ring = SeriesRing.create();
    const label = vi.fn(() => "CPU");
    await using chart = await renderProfiled(() => (
      <TimeSeriesCanvas ring={ring} lines={[{ column: 0 }]} label={label} />
    ));
    await chart.screen.unmount();
    using frames = vi.spyOn(window, "requestAnimationFrame");
    const draws = label.mock.calls.length;

    ring.push([1], 1000);

    expect(frames).not.toHaveBeenCalled();
    expect(label).toHaveBeenCalledTimes(draws);
  });
});
