import "~/index.css";

import { describe, expect, it } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  type MachineIconState,
  machineIconProps,
  machineIconState,
  MachineSweatOverlay,
} from "./MachineSweatOverlay";

const GLYPH = <rect x="3" y="4" width="18" height="12" rx="2" />;

function renderIcon(state: MachineIconState) {
  return render(
    <svg
      viewBox="0 0 24 24"
      width={18}
      height={18}
      className="text-muted-foreground"
      {...machineIconProps(state)}
    >
      {GLYPH}
      <MachineSweatOverlay state={state} size={18} glyph={GLYPH} />
    </svg>,
    { router: false }, // a bare svg needs no router
  );
}

function iconOf(screen: { readonly container: HTMLElement }): SVGSVGElement {
  const svg = screen.container.querySelector("svg");
  if (!svg) throw new Error("icon svg not rendered");
  return svg;
}

const animationNames = (svg: SVGSVGElement) =>
  svg
    .getAnimations({ subtree: true })
    .map((animation) => (animation instanceof CSSAnimation ? animation.animationName : "?"))
    .toSorted();

describe("machineIconState", () => {
  it.each([
    [{ verdict: "ok", unreachable: false, lastSeen: null }, "ok"],
    [{ verdict: "stressed", unreachable: false, lastSeen: null }, "stressed"],
    [{ verdict: "unknown", unreachable: false, lastSeen: null }, "unknown"],
    [{ verdict: "stressed", unreachable: true, lastSeen: null }, "unreachable"],
    [{ verdict: "ok", unreachable: true, lastSeen: { verdict: "ok", ageMs: 1 } }, "unreachable"],
    [
      { verdict: "ok", unreachable: true, lastSeen: { verdict: "stressed", ageMs: 1 } },
      "unreachable-stressed",
    ],
  ] as const)("%j → %s", (view, expected) => {
    expect(machineIconState(view)).toBe(expected);
  });
});

describe("MachineSweatOverlay", () => {
  it.each(["ok", "unknown", "unreachable"] as const)(
    "%s draws no sweat and animates nothing",
    async (state) => {
      await using screen = await renderIcon(state);
      const svg = iconOf(screen);
      expect(svg.querySelector("[data-machine-sweat]")).toBeNull();
      expect(animationNames(svg)).toEqual([]);
    },
  );

  it("stressed pulses the glyph and runs two drips", async () => {
    await using screen = await renderIcon("stressed");
    const svg = iconOf(screen);
    expect(svg.querySelectorAll("[data-machine-drop]")).toHaveLength(2);
    expect(animationNames(svg)).toEqual(["machine-drip", "machine-drip", "machine-pulse"]);
  });

  it("unreachable-stressed keeps still drops", async () => {
    await using screen = await renderIcon("unreachable-stressed");
    const svg = iconOf(screen);
    expect(svg.querySelector('[data-machine-sweat="stale"]')).not.toBeNull();
    expect(svg.querySelectorAll("[data-machine-drop]")).toHaveLength(2);
    expect(animationNames(svg)).toEqual([]);
  });

  it("stressed keeps its drops but does not animate under reduced motion", async () => {
    const session = cdp();
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      await using screen = await renderIcon("stressed");
      const svg = iconOf(screen);
      expect(svg.querySelectorAll("[data-machine-drop]")).toHaveLength(2);
      expect(animationNames(svg)).toEqual([]);
    } finally {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
    }
  });

  it("stressed sweat takes the stress colour over the caller's text colour", async () => {
    await using screen = await renderIcon("stressed");
    const svg = iconOf(screen);
    const probe = document.createElement("span");
    probe.style.color = "var(--machine-stress)";
    screen.container.append(probe);
    const stress = getComputedStyle(probe).color;
    const sweat = svg.querySelector('[data-machine-sweat="stressed"]');
    if (!sweat) throw new Error("sweat not rendered");
    expect(stress).not.toBe(getComputedStyle(svg).color);
    expect(getComputedStyle(sweat).color).toBe(stress);
  });

  it.each([
    ["ok", "1"],
    ["stressed", "1"],
    ["unknown", "0.42"],
    ["unreachable", "0.42"],
    ["unreachable-stressed", "0.42"],
  ] as const)("%s icon opacity is %s", async (state, opacity) => {
    await using screen = await renderIcon(state);
    const svg = iconOf(screen);
    expect(getComputedStyle(svg).opacity).toBe(opacity);
  });
});
