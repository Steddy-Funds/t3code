import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import type { MachineIndicator } from "@t3tools/client-runtime/state/machineIndicator";
import type { MachineProcessTable } from "@t3tools/client-runtime/state/machineProcessFrames";
import { EnvironmentId, type MachineStatusSnapshot } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { fakeTimers, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  indicator: null as unknown as MachineIndicator,
  canReadDiagnostics: true,
  processes: null as unknown as MachineProcessTable,
  /** Thread shells by environment id. */
  shells: new Map<string, ReadonlyArray<{ id: string; title: string; status: string }>>(),
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
vi.mock(import("~/state/threads"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadShells: {
      environmentThreadsAtom: (id: string) => Atom.make(() => state.shells.get(id) ?? []),
    } as never,
  } as never;
});
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

import { EnvironmentContextChip } from "../EnvironmentContextChip";
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
  shells = {},
}: {
  indicator?: Partial<MachineIndicator>;
  canReadDiagnostics?: boolean;
  processes?: MachineProcessTable;
  shells?: Record<string, ReadonlyArray<string>>;
} = {}) {
  state.shells = new Map(
    Object.entries(shells).map(([id, statuses]) => [
      id,
      statuses.map((status, index) => ({ id: `${id}-${index}`, title: status, status })),
    ]),
  );
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

function renderTarget({ navigateOnClick }: { navigateOnClick?: boolean } = {}) {
  return render(
    <RegistryContext value={AtomRegistry.make()}>
      <MachineHoverTarget
        environmentId={environmentId}
        {...(navigateOnClick === undefined ? {} : { navigateOnClick })}
      >
        <button type="button">Open</button>
      </MachineHoverTarget>
    </RegistryContext>,
    { router: "/" },
  );
}

const TASK_MANAGER_PATH = "/machines/machine-a";

async function expectPath(screen: { readonly router: AnyRouter | undefined }, pathname: string) {
  await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe(pathname));
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

  it("a click opens the machine's task manager instead of the card", async () => {
    setup();
    await using screen = await renderTarget();

    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    await expectPath(screen, TASK_MANAGER_PATH);
    expect(card().query()).toBeNull();
    expect(liveKeys()).toEqual([]);
  });

  it.each([
    { key: "{Enter}", name: "Enter" },
    { key: " ", name: "Space" },
  ])(
    "a labelled plain trigger is a tab stop that opens the task manager on $name",
    async ({ key }) => {
      setup();
      await using screen = await render(
        <RegistryContext value={AtomRegistry.make()}>
          <MachineHoverTarget environmentId={environmentId} label="Studio">
            <span>icon</span>
          </MachineHoverTarget>
        </RegistryContext>,
        { router: "/" },
      );
      const trigger = screen.getByRole("button", { name: "Studio machine resources" });
      await expect.element(trigger).toBeVisible();

      await userEvent.tab();
      await expect.element(trigger).toHaveFocus();
      await userEvent.keyboard(key);

      await expectPath(screen, TASK_MANAGER_PATH);
      expect(card().query()).toBeNull();
    },
  );

  it.each([
    { name: "click", act: (trigger: HTMLElement) => userEvent.click(trigger) },
    {
      name: "Enter",
      act: (trigger: HTMLElement) => {
        trigger.focus();
        return userEvent.keyboard("{Enter}");
      },
    },
    {
      name: "Space",
      act: (trigger: HTMLElement) => {
        trigger.focus();
        return userEvent.keyboard(" ");
      },
    },
  ])(
    "a $name during the hover delay keeps the card shut until the pointer leaves",
    async ({ act }) => {
      setup();
      await using screen = await renderTarget();
      using _timers = fakeTimers();
      const trigger = screen.getByRole("button", { name: "Open" });

      await userEvent.hover(trigger);
      await act(trigger.element() as HTMLElement);
      await expectPath(screen, TASK_MANAGER_PATH);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(card().query()).toBeNull();

      await userEvent.unhover(trigger);
      await userEvent.hover(trigger);
      await vi.advanceTimersByTimeAsync(400);
      await expect.element(card()).toBeVisible();
    },
  );

  it.each([
    { name: "click", act: (trigger: HTMLElement) => userEvent.click(trigger) },
    {
      name: "Enter",
      act: (trigger: HTMLElement) => {
        trigger.focus();
        return userEvent.keyboard("{Enter}");
      },
    },
    {
      name: "Space",
      act: (trigger: HTMLElement) => {
        trigger.focus();
        return userEvent.keyboard(" ");
      },
    },
  ])(
    "with navigateOnClick off, a $name stays put and hover still opens the card",
    async ({ act }) => {
      setup();
      await using screen = await renderTarget({ navigateOnClick: false });
      const trigger = screen.getByRole("button", { name: "Open" });

      await act(trigger.element() as HTMLElement);
      await userEvent.hover(trigger);

      await expect.element(card()).toBeVisible();
      expect(screen.router?.state.location.pathname).toBe("/");
    },
  );

  it("a machine chip in a draft keeps the current route on click", async () => {
    setup();
    await using screen = await render(
      <RegistryContext value={AtomRegistry.make()}>
        <EnvironmentContextChip record={{ environmentId, label: "Studio" }} />
      </RegistryContext>,
      { router: "/" },
    );
    const chip = screen.getByLabelText("Machine, Studio");

    await userEvent.click(chip);
    await userEvent.hover(chip);

    // The card, not the chip's own label.
    await expect.element(page.getByText("0 T3 threads running", { exact: true })).toBeVisible();
    expect(screen.router?.state.location.pathname).toBe("/");
  });

  it("other keys neither navigate nor open the card", async () => {
    setup();
    await using screen = await renderTarget();
    screen.getByRole("button", { name: "Open" }).element().focus();

    await userEvent.keyboard("a");

    expect(screen.router?.state.location.pathname).toBe("/");
    expect(card().query()).toBeNull();
  });

  it("gives a machine that doesn't serve the verdict no card and no subscription", async () => {
    setup({ indicator: { show: false } });
    await using screen = await renderTarget();

    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(card().query()).toBeNull();
    expect(state.requested.size).toBe(0);
    expect(screen.router?.state.location.pathname).toBe("/");
  });

  it("skips the process stream and says why without diagnostics:read", async () => {
    setup({ canReadDiagnostics: false });
    await using screen = await renderTarget();

    await userEvent.hover(screen.getByRole("button", { name: "Open" }));

    await expect.element(page.getByText("Process list needs diagnostics access")).toBeVisible();
    expect(liveKeys()).toEqual([LIVE_MACHINE]);
    expect([...state.requested].some((key) => key.startsWith("processes:"))).toBe(false);
  });

  it("asks for the resource monitor when the process table is empty", async () => {
    setup({ processes: table([]) });
    await using screen = await renderTarget();

    await userEvent.hover(screen.getByRole("button", { name: "Open" }));

    await expect.element(page.getByText("Process list needs the resource monitor")).toBeVisible();
  });

  it.each([
    { statuses: ["running"], line: "1 T3 thread running" },
    {
      statuses: ["running", "queued", "idle", "completed", "failed"],
      line: "2 T3 threads running",
    },
    { statuses: ["idle"], line: "0 T3 threads running" },
  ])("counts $line from this machine's thread shells", async ({ statuses, line }) => {
    setup({ shells: { "machine-a": statuses, "machine-b": ["running", "running", "running"] } });
    await using screen = await renderTarget();

    await userEvent.hover(screen.getByRole("button", { name: "Open" }));

    await expect.element(page.getByText(line, { exact: true })).toBeVisible();
  });

  it("opens no live stream and shows no thread line for an unreachable machine", async () => {
    setup({
      indicator: { verdict: "unknown", unreachable: true },
      shells: { "machine-a": ["running"] },
    });
    await using screen = await renderTarget();

    await userEvent.hover(screen.getByRole("button", { name: "Open" }));

    await expect.element(card()).toBeVisible();
    expect(state.requested.size).toBe(0);
    expect(document.body.textContent).not.toMatch(/T3 threads? running/);
  });
});
