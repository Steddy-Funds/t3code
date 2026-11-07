import "~/index.css";

import { Profiler } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../../test/render";
import { SeriesRing } from "../charts/SeriesRing";
import { MachineSection, MachineSectionMessage } from "./MachineSection";
import { LiveValue, StatTile } from "./StatTile";

const percent = (value: number) => (Number.isNaN(value) ? "–" : `${Math.round(value)}%`);

describe("LiveValue", () => {
  it("writes each sample without a React render", async () => {
    const ring = SeriesRing.create({ columns: 2 });
    const onRender = vi.fn();
    await using screen = await render(
      <Profiler id="value" onRender={onRender}>
        <LiveValue ring={ring} column={1} format={percent} />
      </Profiler>,
      { router: false }, // no links
    );
    await expect.element(screen.locator).toHaveTextContent("–");
    const renders = onRender.mock.calls.length;

    ring.push([10, 42], 1000);
    await expect.element(screen.locator).toHaveTextContent("42%");
    ring.seed([[1], [7]], 1000, 5000);
    await expect.element(screen.locator).toHaveTextContent("7%");

    expect(onRender).toHaveBeenCalledTimes(renders);
  });

  it("reformats the current value when the format changes", async () => {
    const ring = SeriesRing.create();
    ring.push([12.4], 1000);
    await using screen = await render(<LiveValue ring={ring} format={percent} />, {
      router: false, // no links
    });
    await expect.element(screen.locator).toHaveTextContent("12%");

    const fraction = (value: number) => value.toFixed(1);
    await screen.rerender(<LiveValue ring={ring} format={fraction} />);
    await expect.element(screen.locator).toHaveTextContent("12.4");

    // Later ticks use the new format too.
    ring.push([50], 2000);
    await expect.element(screen.locator).toHaveTextContent("50.0");
  });

  it("follows a new ring and stops writing from the old one", async () => {
    const first = SeriesRing.create();
    const second = SeriesRing.create();
    second.push([5], 1000);
    await using screen = await render(<LiveValue ring={first} format={percent} />, {
      router: false, // no links
    });
    await screen.rerender(<LiveValue ring={second} format={percent} />);
    await expect.element(screen.locator).toHaveTextContent("5%");

    first.push([99], 1000);
    expect(screen.container.textContent).toBe("5%");
  });

  it("shows the formatted NaN while the ring is empty", async () => {
    const format = vi.fn(() => "no data");
    await using screen = await render(<LiveValue ring={SeriesRing.create()} format={format} />, {
      router: false, // no links
    });
    await expect.element(screen.locator).toHaveTextContent("no data");
    expect(format).toHaveBeenCalledWith(Number.NaN);
  });
});

describe("quiet when fine", () => {
  it("an ok StatTile shows only its label and value", async () => {
    const ring = SeriesRing.create();
    ring.push([12], 1000);
    await using screen = await render(
      <StatTile label="CPU" value={<LiveValue ring={ring} format={percent} />}>
        <canvas />
      </StatTile>,
      { router: false }, // no links
    );
    expect(screen.container.textContent).toBe("CPU12%");
    expect(screen.container.querySelector("[data-tripped]")).toBeNull();
  });

  it("a tripped StatTile is marked and shows its note", async () => {
    await using screen = await render(
      <StatTile label="Load" value="14.1" detail="limit 12.5" tripped>
        <canvas />
      </StatTile>,
      { router: false }, // no links
    );
    await expect.element(screen.getByText("limit 12.5")).toBeVisible();
    expect(screen.container.querySelector("[data-tripped]")).not.toBeNull();
  });

  it("an ok MachineSection shows only its title and content", async () => {
    await using screen = await render(
      <MachineSection title="Cores">
        <canvas />
      </MachineSection>,
      { router: false }, // no links
    );
    const section = screen.container.querySelector("section");
    expect(section?.textContent).toBe("Cores");
    expect(section?.hasAttribute("data-tripped")).toBe(false);
    expect(screen.container.querySelector("[role=alert]")).toBeNull();
  });

  it("a tripped MachineSection is marked and keeps its numbers", async () => {
    await using screen = await render(
      <MachineSection title="Memory" detail="14.2 / 16 GiB" tripped>
        <canvas />
      </MachineSection>,
      { router: false }, // no links
    );
    const section = screen.container.querySelector("section");
    expect(section?.hasAttribute("data-tripped")).toBe(true);
    await expect.element(screen.getByText("14.2 / 16 GiB")).toBeVisible();
  });

  it("only an error message is announced as an alert", async () => {
    await using screen = await render(
      <>
        <MachineSectionMessage>Process list needs the resource monitor</MachineSectionMessage>
        <MachineSectionMessage tone="error">Missing diagnostics:read</MachineSectionMessage>
      </>,
      { router: false }, // no links
    );
    const alerts = screen.container.querySelectorAll("[role=alert]");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toBe("Missing diagnostics:read");
    await expect.element(screen.getByText("Process list needs the resource monitor")).toBeVisible();
  });
});
