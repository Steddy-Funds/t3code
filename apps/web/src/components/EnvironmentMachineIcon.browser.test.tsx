import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import type { MachineIndicator } from "@t3tools/client-runtime/state/machineIndicator";
import { EnvironmentId, type EnvironmentMachineKind } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const state = vi.hoisted(() => ({
  indicator: null as unknown as MachineIndicator,
  reads: [] as string[],
}));

vi.mock(import("~/state/machineResources"), async () => {
  const { Atom } = await import("effect/reactivity");
  const indicator = Atom.make(() => state.indicator);
  return {
    machineIndicator: {
      machineIndicatorAtom: (environmentId: string) => {
        state.reads.push(environmentId);
        return indicator;
      },
    } as never,
    machineResources: {} as never,
  };
});

import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";

const environmentId = EnvironmentId.make("machine-a");
const base: MachineIndicator = {
  show: true,
  verdict: "ok",
  unreachable: false,
  lastSeen: null,
  reason: null,
};

function setup(indicator: Partial<MachineIndicator>) {
  state.indicator = { ...base, ...indicator };
  state.reads = [];
}

function renderIcon(kind: EnvironmentMachineKind = "server", withEnvironment = true) {
  // A fresh registry per render, so each test reads its own indicator.
  return render(
    <RegistryContext value={AtomRegistry.make()}>
      <EnvironmentMachineIcon
        kind={kind}
        className="size-4"
        {...(withEnvironment ? { environmentId } : {})}
      />
    </RegistryContext>,
    { router: false }, // a bare icon needs no router
  );
}

function outerSvg(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector(":scope > svg");
  if (!(svg instanceof SVGSVGElement)) throw new Error("icon svg not rendered");
  return svg;
}

describe("EnvironmentMachineIcon", () => {
  it("draws the plain icon without reading the indicator when no environment is given", async () => {
    setup({ verdict: "stressed" });
    await using screen = await renderIcon("server", false);

    const svg = outerSvg(screen.container);
    expect(svg.hasAttribute("data-machine-icon")).toBe(false);
    expect(svg.querySelector("[data-machine-sweat]")).toBeNull();
    expect(state.reads).toEqual([]);
  });

  it.each([
    ["a machine that doesn't serve the verdict", { show: false, verdict: "stressed" as const }],
    ["an ok machine", { verdict: "ok" as const }],
  ])("draws the plain icon for %s", async (_label, indicator) => {
    setup(indicator);
    await using screen = await renderIcon();

    const svg = outerSvg(screen.container);
    expect(svg.hasAttribute("data-machine-icon")).toBe(false);
    expect(svg.querySelector("[data-machine-sweat]")).toBeNull();
    expect(state.reads).toEqual([environmentId]);
  });

  it.each([
    ["unknown", { verdict: "unknown" as const }],
    ["unreachable", { unreachable: true }],
  ])("dims the icon while %s", async (expected, indicator) => {
    setup(indicator);
    await using screen = await renderIcon();

    const svg = outerSvg(screen.container);
    expect(svg.getAttribute("data-machine-icon")).toBe(expected);
    expect(Number(getComputedStyle(svg).opacity)).toBeLessThan(1);
    expect(svg.querySelector("[data-machine-sweat]")).toBeNull();
  });

  it.each(["server", "linux", "mac-mini"] as const)(
    "draws the sweat overlay with a glyph copy inside the %s icon's own svg",
    async (kind) => {
      setup({ verdict: "stressed" });
      await using screen = await renderIcon(kind);

      const svg = outerSvg(screen.container);
      expect(svg.getAttribute("data-machine-icon")).toBe("stressed");
      const sweat = svg.querySelector('[data-machine-sweat="stressed"]');
      expect(sweat?.parentElement).toBe(svg);
      // The pulse layer redraws the glyph as a nested svg of the same kind.
      const glyph = sweat?.querySelector("svg");
      expect(glyph).not.toBeNull();
      expect(glyph!.childElementCount).toBeGreaterThan(0);
      expect(sweat?.querySelectorAll("[data-machine-drop]")).toHaveLength(2);
    },
  );
});
