import { RegistryContext } from "@effect/atom-react";
import type { MachineIndicator } from "@t3tools/client-runtime/state/machineIndicator";
import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  indicator: null as unknown as MachineIndicator,
  reads: [] as string[],
  appActive: true,
  reducedMotion: false,
  focused: true,
  initialValues: [] as number[],
  setValues: [] as number[],
  loop: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));

vi.mock("react-native", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const phase = { interpolate: () => 0 };
  return {
    View: Box,
    Animated: {
      View: Box,
      loop: (...args: unknown[]) => {
        harness.loop(...args);
        return { start: harness.start, stop: harness.stop };
      },
      timing: () => ({}),
      add: () => phase,
      modulo: () => phase,
    },
    Easing: { linear: (value: number) => value },
    useAnimatedValue: (initial: number) => {
      harness.initialValues.push(initial);
      return { setValue: (value: number) => harness.setValues.push(value) };
    },
  };
});
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => harness.focused }));
vi.mock("../lib/appState", () => ({
  useAppActive: () => harness.appActive,
  useReduceMotionEnabled: () => harness.reducedMotion,
}));
vi.mock("./machineResources/stressColor", () => ({ useMachineStressColor: () => "#f00" }));
vi.mock("./ui/AppSymbol", () => ({
  SymbolView: (props: { name: string }) => <i data-symbol={props.name} />,
}));
vi.mock("../state/machineResources", async () => {
  const { Atom } = await import("effect/reactivity");
  const indicator = Atom.make(() => harness.indicator);
  return {
    machineIndicator: {
      machineIndicatorAtom: (environmentId: string) => {
        harness.reads.push(environmentId);
        return indicator;
      },
    },
    machineResources: {},
  };
});

import { EnvironmentMachineSymbol, machineSymbolState } from "./EnvironmentMachineSymbol";

const FORMED_PHASE = 0.22;
const base: MachineIndicator = {
  show: true,
  verdict: "ok",
  unreachable: false,
  lastSeen: null,
  reason: null,
};

function setup(
  indicator: Partial<MachineIndicator>,
  motion: { appActive?: boolean; reducedMotion?: boolean; focused?: boolean } = {},
) {
  harness.indicator = { ...base, ...indicator };
  harness.reads = [];
  harness.appActive = motion.appActive ?? true;
  harness.reducedMotion = motion.reducedMotion ?? false;
  harness.focused = motion.focused ?? true;
  harness.initialValues = [];
  harness.setValues = [];
  harness.loop.mockClear();
  harness.start.mockClear();
  harness.stop.mockClear();
}

async function renderSymbol(withEnvironment = true) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={AtomRegistry.make()}>
        <EnvironmentMachineSymbol
          {...(withEnvironment ? { environmentId: EnvironmentId.make("machine-a") } : {})}
          kind="server"
          size={16}
          tintColorClassName="text-foreground"
        />
      </RegistryContext.Provider>,
    ),
  );
  return {
    container,
    drops: () => container.querySelectorAll('[data-symbol="drop.fill"]').length,
    [Symbol.asyncDispose]: () => act(async () => root.unmount()),
  };
}

describe("machineSymbolState", () => {
  it.each<[string, Partial<MachineIndicator>, ReturnType<typeof machineSymbolState>]>([
    ["a machine that doesn't serve the verdict", { show: false, verdict: "stressed" }, "ok"],
    ["ok", { verdict: "ok" }, "ok"],
    ["unknown", { verdict: "unknown" }, "unknown"],
    ["stressed", { verdict: "stressed" }, "stressed"],
    [
      "unreachable, last seen stressed",
      { unreachable: true, lastSeen: { verdict: "stressed", ageMs: 1 } },
      "unreachable-stressed",
    ],
    [
      "unreachable, last seen ok",
      { unreachable: true, verdict: "stressed", lastSeen: { verdict: "ok", ageMs: 1 } },
      "unknown",
    ],
    ["unreachable, never seen", { unreachable: true }, "unknown"],
  ])("is %s", (_label, indicator, expected) => {
    expect(machineSymbolState({ ...base, ...indicator })).toBe(expected);
  });
});

describe("EnvironmentMachineSymbol", () => {
  it("draws the plain glyph without reading an indicator when no environment is given", async () => {
    setup({ verdict: "stressed" });
    await using screen = await renderSymbol(false);

    expect(harness.reads).toEqual([]);
    expect(screen.container.querySelector('[data-symbol="server.rack"]')).not.toBeNull();
    expect(screen.drops()).toBe(0);
  });

  it("drips while stressed, active, focused and with motion on, and stops on unmount", async () => {
    setup({ verdict: "stressed" });
    {
      await using screen = await renderSymbol();

      expect(screen.drops()).toBe(2);
      expect(harness.initialValues.every((value) => value === FORMED_PHASE)).toBe(true);
      expect(harness.loop).toHaveBeenCalledOnce();
      expect(harness.start).toHaveBeenCalledOnce();
      expect(harness.stop).not.toHaveBeenCalled();
    }
    expect(harness.stop).toHaveBeenCalledOnce();
  });

  it.each([
    ["the app is inactive", { appActive: false }],
    ["reduced motion is on", { reducedMotion: true }],
    ["the screen is unfocused", { focused: false }],
  ])("rests the drops at the formed phase when %s", async (_label, motion) => {
    setup({ verdict: "stressed" }, motion);
    await using screen = await renderSymbol();

    expect(screen.drops()).toBe(2);
    expect(harness.loop).not.toHaveBeenCalled();
    expect(harness.setValues).toEqual([FORMED_PHASE]);
  });

  it("never drips for an unreachable machine last seen stressed", async () => {
    setup({ unreachable: true, lastSeen: { verdict: "stressed", ageMs: 1 } });
    await using screen = await renderSymbol();

    expect(screen.drops()).toBe(2);
    expect(harness.loop).not.toHaveBeenCalled();
    expect(harness.setValues).toEqual([FORMED_PHASE]);
  });

  it("draws no drops while unknown", async () => {
    setup({ verdict: "unknown" });
    await using screen = await renderSymbol();

    expect(screen.drops()).toBe(0);
    expect(harness.loop).not.toHaveBeenCalled();
  });
});
