import "~/index.css";

import { Profiler, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../../test/render";
import { CellGrid } from "./CellGrid";
import { CellPool } from "./CellPool";
import { SeriesRing } from "./SeriesRing";

async function renderGrid(grid: ReactNode, { width = 300, offscreen = false } = {}) {
  const onRender = vi.fn();
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  if (offscreen) {
    container.style.position = "fixed";
    container.style.left = "0";
    container.style.top = "-10000px";
  }
  await using stack = new AsyncDisposableStack();
  // A bare canvas needs no router.
  const screen = stack.use(
    await render(
      <Profiler id="grid" onRender={onRender}>
        {grid}
      </Profiler>,
      { container, router: false },
    ),
  );
  const canvas = screen.container.querySelector("canvas");
  if (!canvas) throw new Error("canvas not rendered");
  const owned = stack.move();
  return {
    screen,
    canvas,
    container,
    onRender,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

/** Resolves with the next intersection state; the grid's shared observer was created first, so it has already seen it. */
function nextIntersection(element: Element): Promise<boolean> {
  return new Promise((resolve) => {
    const observer = new IntersectionObserver(([entry]) => {
      observer.disconnect();
      resolve(entry?.isIntersecting ?? false);
    });
    observer.observe(element);
  });
}

function coreRing(cores: number): SeriesRing {
  return SeriesRing.create({ columns: cores });
}

describe("CellGrid", () => {
  it("draws every core from one canvas on a tick without a React render", async () => {
    const ring = coreRing(8);
    const label = () =>
      `Cores ${Array.from({ length: ring.columns }, (_, core) => ring.latest(core)).join(" ")}`;
    await using grid = await renderGrid(
      <CellGrid columns={4} ring={ring} max={100} label={label} />,
    );
    const image = grid.screen.getByRole("img");
    expect(grid.screen.container.querySelectorAll("canvas")).toHaveLength(1);
    await expect
      .element(image)
      .toHaveAttribute("aria-label", "Cores NaN NaN NaN NaN NaN NaN NaN NaN");
    const renders = grid.onRender.mock.calls.length;

    ring.push([1, 2, 3, 4, 5, 6, 7, 8], 1000);
    await expect.element(image).toHaveAttribute("aria-label", "Cores 1 2 3 4 5 6 7 8");
    ring.push([9, 9, 9, 9, 9, 9, 9, 90], 2000);
    await expect.element(image).toHaveAttribute("aria-label", "Cores 9 9 9 9 9 9 9 90");

    expect(grid.onRender).toHaveBeenCalledTimes(renders);
  });

  it("redraws a pool change without a React render", async () => {
    const pool = CellPool.create();
    pool.set(8, [{ cells: 2, color: "--primary" }]);
    const label = () => `Memory ${pool.segments[0]?.cells ?? 0} of ${pool.total} GiB`;
    await using grid = await renderGrid(<CellGrid columns={4} pool={pool} label={label} />);
    const image = grid.screen.getByRole("img");
    await expect.element(image).toHaveAttribute("aria-label", "Memory 2 of 8 GiB");
    const renders = grid.onRender.mock.calls.length;

    pool.set(8, [{ cells: 6, color: "--primary" }]);
    await expect.element(image).toHaveAttribute("aria-label", "Memory 6 of 8 GiB");

    expect(grid.onRender).toHaveBeenCalledTimes(renders);
  });

  it("sizes its height from the width, the columns and the cell aspect", async () => {
    // 8 cores in 4 columns: cells (300 - 3 × 4) / 4 = 72 wide, 36 tall, 2 rows and one 4 px gap.
    await using sparklines = await renderGrid(
      <CellGrid columns={4} aspect={2} ring={coreRing(8)} label={() => "Cores"} />,
    );
    await vi.waitFor(() => expect(sparklines.canvas.style.height).toBe("76px"));
    expect(sparklines.canvas.clientHeight).toBe(76);

    sparklines.container.style.width = "156px";
    // Cells (156 - 12) / 4 = 36 wide, 18 tall: 2 × 18 + 4.
    await vi.waitFor(() => expect(sparklines.canvas.style.height).toBe("40px"));
  });

  it("grows a pool grid when its total grows", async () => {
    const pool = CellPool.create();
    pool.set(10, []);
    // Square cells (100 - 4 × 2) / 5 = 18.4 px: 2 rows are 2 × 18.4 + 2, rounded.
    await using grid = await renderGrid(<CellGrid columns={5} pool={pool} label={() => "Pool"} />, {
      width: 100,
    });
    await vi.waitFor(() => expect(grid.canvas.style.height).toBe("39px"));

    pool.set(20, []);
    // 4 rows: 4 × 18.4 + 3 × 2 = 79.6.
    await vi.waitFor(() => expect(grid.canvas.style.height).toBe("80px"));
  });

  it("skips drawing while off screen and catches up when it scrolls into view", async () => {
    const ring = coreRing(2);
    const label = vi.fn(() => `Cores ${ring.latest(0)} ${ring.latest(1)}`);
    await using grid = await renderGrid(<CellGrid columns={2} ring={ring} label={label} />, {
      offscreen: true,
    });
    expect(await nextIntersection(grid.canvas)).toBe(false);
    using frames = vi.spyOn(window, "requestAnimationFrame");
    const draws = label.mock.calls.length;

    ring.push([10, 20], 1000);
    ring.push([30, 40], 2000);

    expect(frames).not.toHaveBeenCalled();
    expect(label).toHaveBeenCalledTimes(draws);

    grid.container.style.top = "0";
    await expect.element(grid.screen.getByRole("img")).toHaveAttribute("aria-label", "Cores 30 40");
  });
});
