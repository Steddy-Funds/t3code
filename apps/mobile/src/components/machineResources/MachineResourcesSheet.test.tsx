import { RegistryContext } from "@effect/atom-react";
import type { MachineIndicator } from "@t3tools/client-runtime/state/machineIndicator";
import type { MachineProcessTable } from "@t3tools/client-runtime/state/machineProcessFrames";
import { EnvironmentId, type MachineStatusSnapshot } from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  indicator: null as unknown as MachineIndicator,
  processes: null as unknown as MachineProcessTable,
  /** Live atoms currently mounted, by "machine:<intervalMs|verdict>" or "processes:<intervalMs>:<top>". */
  mounted: new Set<string>(),
  /** Every subscription key ever requested, mounted or not. */
  requested: new Set<string>(),
}));

vi.mock("react-native", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Box,
    ScrollView: Box,
    Platform: { OS: "ios" },
    Pressable: (props: {
      accessibilityLabel: string;
      onPress: () => void;
      children?: ReactNode;
    }) => (
      <button type="button" aria-label={props.accessibilityLabel} onClick={props.onPress}>
        {props.children}
      </button>
    ),
  };
});
vi.mock("../ui/Sheet", () => ({
  Sheet: (props: { title: string; onClose: () => void; children?: ReactNode }) => (
    <section aria-label={props.title}>
      <button type="button" onClick={props.onClose}>
        Close
      </button>
      {props.children}
    </section>
  ),
}));
vi.mock("../ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../ui/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock(import("../EnvironmentMachineSymbol"), async (original) => ({
  ...(await original()),
  EnvironmentMachineSymbol: () => <i data-symbol="machine" />,
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("../../lib/appState", () => ({
  useAppActive: () => true,
  useReduceMotionEnabled: () => false,
}));
vi.mock("./stressColor", () => ({ useMachineStressColor: () => "#f00" }));
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  const presentation = Atom.make({ entry: { target: { label: "Studio" } } });
  return { environmentPresentations: { presentationAtom: () => presentation } };
});
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(null);
  return { serverEnvironment: { configValueAtom: () => config } };
});
vi.mock("../../state/machineResources", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const indicator = Atom.make(() => harness.indicator);
  const atoms = new Map<string, Atom.Atom<unknown>>();
  const tracked = (key: string, value: () => unknown) => {
    harness.requested.add(key);
    let atom = atoms.get(key);
    if (!atom) {
      atom = Atom.make((get) => {
        harness.mounted.add(key);
        get.addFinalizer(() => harness.mounted.delete(key));
        return AsyncResult.success(value());
      });
      atoms.set(key, atom);
    }
    return atom;
  };
  return {
    machineIndicator: { machineIndicatorAtom: () => indicator },
    machineResources: {
      machine: (_id: string, input?: { intervalMs: number }) =>
        tracked(`machine:${input?.intervalMs ?? "verdict"}`, () => SNAPSHOT),
      machineProcesses: (_id: string, input: { intervalMs: number; top?: number }) =>
        tracked(`processes:${input.intervalMs}:${input.top}`, () => harness.processes),
    },
  };
});

import { MachineSymbolButton } from "./MachineSymbolButton";
import { useMachineHeaderAction } from "./useMachineHeaderAction";

const SNAPSHOT: MachineStatusSnapshot = {
  sequence: 1,
  verdict: "ok",
  verdictAgeMs: 0,
  reason: null,
  sampleAgeMs: 0,
  totals: null,
};
const environmentId = EnvironmentId.make("machine-a");
const LIVE_KEYS = ["machine:1000", "machine:verdict", "processes:2000:5"];

const table = (rows: MachineProcessTable["rows"]): MachineProcessTable => ({
  generation: 1,
  sequence: 1,
  sampleAgeMs: 0,
  source: "t3",
  rows,
  truncated: 0,
});
const T3_SERVER = table([
  {
    key: 1,
    pid: 100,
    ppid: 1,
    startTimeMs: 0,
    name: "t3-server",
    user: "",
    command: "node t3",
    cpu: 12,
    rss: 1024 ** 3,
  },
]);

function setup(indicator: Partial<MachineIndicator> = {}, processes = T3_SERVER) {
  harness.indicator = {
    show: true,
    verdict: "ok",
    unreachable: false,
    lastSeen: null,
    reason: null,
    ...indicator,
  };
  harness.processes = processes;
  harness.mounted.clear();
  harness.requested.clear();
}

function HeaderHarness() {
  const { action, sheet } = useMachineHeaderAction(environmentId);
  return (
    <>
      {action ? (
        <button
          type="button"
          aria-label={action.accessibilityLabel}
          data-tint={action.tintColor ?? ""}
          onClick={action.onPress}
        />
      ) : null}
      {sheet}
    </>
  );
}

const SURFACES = {
  "the machine symbol button": () => (
    <MachineSymbolButton
      environmentId={environmentId}
      label="Studio"
      kind="server"
      size={16}
      tintColorClassName="text-foreground"
    />
  ),
  "the thread header action": () => <HeaderHarness />,
} as const;
type Surface = keyof typeof SURFACES;

async function renderSurface(surface: Surface) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={AtomRegistry.make()}>
        {SURFACES[surface]()}
      </RegistryContext.Provider>,
    ),
  );
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (element) => (element.getAttribute("aria-label") ?? element.textContent) === label,
    ) ?? null;
  return {
    container,
    button,
    tap: (label: string) =>
      act(async () => {
        const element = button(label);
        if (!element) throw new Error(`no ${label} button`);
        element.click();
      }),
    sheet: () => container.querySelector('section[aria-label="Studio"]'),
    [Symbol.asyncDispose]: () => act(async () => root.unmount()),
  };
}

const OPEN = "Studio machine resources";
const liveKeys = () => [...harness.mounted].toSorted();

describe.each(Object.keys(SURFACES) as Surface[])("%s", (surface) => {
  it("subscribes to the live streams only while its sheet is open", async () => {
    setup();
    await using screen = await renderSurface(surface);
    expect(screen.sheet()).toBeNull();
    expect(harness.requested.size).toBe(0);

    await screen.tap(OPEN);
    expect(screen.sheet()).not.toBeNull();
    expect(liveKeys()).toEqual(LIVE_KEYS);

    await screen.tap("Close");
    expect(screen.sheet()).toBeNull();
    await vi.waitFor(() => expect(liveKeys()).toEqual([]));
  });

  it("offers nothing to tap for a machine that doesn't serve the verdict", async () => {
    setup({ show: false });
    await using screen = await renderSurface(surface);

    expect(screen.button(OPEN)).toBeNull();
    expect(screen.sheet()).toBeNull();
    expect(harness.requested.size).toBe(0);
  });

  it("asks for the resource monitor when the process table is empty", async () => {
    setup({}, table([]));
    await using screen = await renderSurface(surface);

    await screen.tap(OPEN);

    expect(screen.sheet()?.textContent).toContain("Process list needs the resource monitor");
  });

  it("opens no live stream for an unreachable machine", async () => {
    setup({ verdict: "unknown", unreachable: true, lastSeen: { verdict: "ok", ageMs: 60_000 } });
    await using screen = await renderSurface(surface);

    await screen.tap(OPEN);

    expect(screen.sheet()).not.toBeNull();
    expect(harness.requested.size).toBe(0);
  });
});

describe("the thread header action", () => {
  it.each([
    ["stressed", "#f00"],
    ["ok", ""],
  ] as const)("takes the stress tint only while %s", async (verdict, tint) => {
    setup({ verdict });
    await using screen = await renderSurface("the thread header action");

    expect(screen.button(OPEN)?.getAttribute("data-tint")).toBe(tint);
  });
});
