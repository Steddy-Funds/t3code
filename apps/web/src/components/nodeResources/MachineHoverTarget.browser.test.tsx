import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import type { MachineIndicator } from "@t3tools/client-runtime/state/machineIndicator";
import type { MachineProcessTable } from "@t3tools/client-runtime/state/machineProcessFrames";
import { EnvironmentId, type MachineStatusSnapshot } from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  indicator: null as unknown as MachineIndicator,
  canReadDiagnostics: true,
  processes: null as unknown as MachineProcessTable,
  /** Live atoms currently mounted, by "machine:<intervalMs>" or "processes:<intervalMs>:<top>". */
  mounted: new Set<string>(),
  /** Every subscription key ever requested, mounted or not. */
  requested: new Set<string>(),
}));

vi.mock(import("~/state/machineResources"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const indicator = Atom.make(() => state.indicator);
  const atoms = new Map<string, Atom.Atom<unknown>>();
  const tracked = (key: string, value: () => unknown) => {
    state.requested.add(key);
    let atom = atoms.get(key);
    if (!atom) {
      atom = Atom.make((get) => {
        state.mounted.add(key);
        get.addFinalizer(() => state.mounted.delete(key));
        return AsyncResult.success(value());
      });
      atoms.set(key, atom);
    }
    return atom;
  };
  return {
    machineIndicator: { machineIndicatorAtom: () => indicator } as never,
    machineResources: {
      machine: ((_id: string, input?: { intervalMs: number }) =>
        tracked(`machine:${input?.intervalMs ?? "verdict"}`, () => SNAPSHOT)) as never,
      machineProcesses: ((_id: string, input: { intervalMs: number; top?: number }) =>
        tracked(`processes:${input.intervalMs}:${input.top}`, () => state.processes)) as never,
    } as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({ label: "Studio", serverConfig: null })) as never,
}));
vi.mock(import("~/state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(null);
  return { serverEnvironment: { configValueAtom: () => config } as never };
});
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((_id: unknown, scope: string) =>
    scope === "diagnostics:read" ? state.canReadDiagnostics : true) as never,
}));

import { MachineHoverTarget } from "./MachineHoverTarget";

const SNAPSHOT: MachineStatusSnapshot = {
  sequence: 1,
  verdict: "ok",
  verdictAgeMs: 0,
  reason: null,
  sampleAgeMs: 0,
  totals: null,
};

const environmentId = EnvironmentId.make("machine-a");
const LIVE_MACHINE = "machine:1000";
const TOP_PROCESSES = "processes:2000:5";

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

function setup({
  indicator = {},
  canReadDiagnostics = true,
  processes = T3_SERVER,
}: {
  indicator?: Partial<MachineIndicator>;
  canReadDiagnostics?: boolean;
  processes?: MachineProcessTable;
} = {}) {
  state.indicator = {
    show: true,
    verdict: "ok",
    unreachable: false,
    lastSeen: null,
    reason: null,
    ...indicator,
  };
  state.canReadDiagnostics = canReadDiagnostics;
  state.processes = processes;
  state.mounted.clear();
  state.requested.clear();
}

function renderTarget() {
  return render(
    <RegistryContext value={AtomRegistry.make()}>
      <MachineHoverTarget environmentId={environmentId}>
        <button type="button">Open</button>
      </MachineHoverTarget>
    </RegistryContext>,
    { router: false }, // the card has no links
  );
}

const card = () => page.getByText("Studio", { exact: true });
const liveKeys = () => [...state.mounted].filter((key) => key !== "machine:verdict").toSorted();

describe("MachineHoverTarget", () => {
  it("mounts the live streams only while a hover opens the card", async () => {
    setup();
    await using screen = await renderTarget();
    const trigger = screen.getByRole("button", { name: "Open" });
    expect(state.requested.size).toBe(0);

    await userEvent.hover(trigger);
    await expect.element(card()).toBeVisible();
    expect(liveKeys()).toEqual([LIVE_MACHINE, TOP_PROCESSES]);

    await userEvent.unhover(trigger);
    await expect.element(card()).not.toBeInTheDocument();
    await vi.waitFor(() => expect(liveKeys()).toEqual([]));
  });

  it("opens on click and closes on Escape, unmounting the streams", async () => {
    setup();
    await using screen = await renderTarget();

    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    await expect.element(card()).toBeVisible();
    expect(liveKeys()).toEqual([LIVE_MACHINE, TOP_PROCESSES]);

    await userEvent.keyboard("{Escape}");
    await expect.element(card()).not.toBeInTheDocument();
    await vi.waitFor(() => expect(liveKeys()).toEqual([]));
  });

  it("gives a machine that doesn't serve the verdict no card and no subscription", async () => {
    setup({ indicator: { show: false } });
    await using screen = await renderTarget();

    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(card().query()).toBeNull();
    expect(state.requested.size).toBe(0);
  });

  it("skips the process stream and says why without diagnostics:read", async () => {
    setup({ canReadDiagnostics: false });
    await using screen = await renderTarget();

    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    await expect.element(page.getByText("Process list needs diagnostics access")).toBeVisible();
    expect(liveKeys()).toEqual([LIVE_MACHINE]);
    expect([...state.requested].some((key) => key.startsWith("processes:"))).toBe(false);
  });

  it("asks for the resource monitor when the process table is empty", async () => {
    setup({ processes: table([]) });
    await using screen = await renderTarget();

    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    await expect.element(page.getByText("Process list needs the resource monitor")).toBeVisible();
  });

  it("opens no live stream for an unreachable machine", async () => {
    setup({ indicator: { verdict: "unknown", unreachable: true } });
    await using screen = await renderTarget();

    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    await expect.element(card()).toBeVisible();
    expect(state.requested.size).toBe(0);
  });
});
