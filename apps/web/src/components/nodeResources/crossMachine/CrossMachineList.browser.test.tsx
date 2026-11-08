import { RegistryContext } from "@effect/atom-react";
import type { MachineIndicator } from "@t3tools/client-runtime/state/machineIndicator";
import type { MachineProcessTable } from "@t3tools/client-runtime/state/machineProcessFrames";
import { EnvironmentId, type MachineStatusSnapshot } from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../../test/render";

type Totals = NonNullable<MachineStatusSnapshot["totals"]>;

const state = vi.hoisted(() => ({
  machines: [] as Array<{ environmentId: string; label: string }>,
  indicators: new Map<string, MachineIndicator>(),
  totals: new Map<string, Totals>(),
  canReadDiagnostics: true,
  /** Live atoms mounted, by "machine:<id>:<intervalMs>:<historyMs>" or "processes:<id>:<intervalMs>:<top>". */
  mounted: new Set<string>(),
  requested: new Set<string>(),
}));

vi.mock(import("../capableMachines"), async () => {
  const { Atom } = await import("effect/reactivity");
  return { capableMachinesAtom: Atom.make(() => state.machines) as never } as never;
});
vi.mock(import("~/state/machineResources"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const indicators = Atom.family((id: string) => Atom.make(() => state.indicators.get(id)));
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
    machineIndicator: { machineIndicatorAtom: indicators } as never,
    machineResources: {
      machine: (id: string, input: { intervalMs: number; historyMs: number }) =>
        tracked(`machine:${id}:${input.intervalMs}:${input.historyMs}`, () => ({
          ...SNAPSHOT,
          totals: state.totals.get(id) ?? null,
        })),
      machineProcesses: (id: string, input: { intervalMs: number; top: number }) =>
        tracked(`processes:${id}:${input.intervalMs}:${input.top}`, () => T3_SERVER),
    } as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentMachines: (() => new Map()) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((_id: unknown, scope: string) =>
    scope === "diagnostics:read" ? state.canReadDiagnostics : true) as never,
}));
vi.mock(import("~/state/threads"), async () => {
  const { Atom } = await import("effect/reactivity");
  const none = Atom.make(() => []);
  return { environmentThreadShells: { environmentThreadsAtom: () => none } as never } as never;
});

import { CrossMachineList } from "./CrossMachineList";

const SNAPSHOT: MachineStatusSnapshot = {
  sequence: 1,
  verdict: "ok",
  verdictAgeMs: 0,
  reason: null,
  sampleAgeMs: 0,
  totals: null,
};
const T3_SERVER: MachineProcessTable = {
  generation: 1,
  sequence: 1,
  sampleAgeMs: 0,
  source: "t3",
  rows: [
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
  ],
  truncated: 0,
};

const totals = (loadOne: number): Totals => ({
  cpuUtilization: 0.2,
  cpuCount: 8,
  load: { one: loadOne, five: loadOne, fifteen: loadOne },
  memoryTotalBytes: 16 * 1024 ** 3,
  memoryAvailableBytes: 8 * 1024 ** 3,
  swapTotalBytes: 0,
  swapUsedBytes: 0,
  memoryPressure: null,
});

interface Machine {
  readonly id: string;
  readonly indicator?: Partial<MachineIndicator>;
  readonly loadOne?: number;
}

const OK: Machine = { id: "alpha", loadOne: 4 };
const STRESSED: Machine = {
  id: "bravo",
  indicator: {
    verdict: "stressed",
    reason: { rule: "load", value: 3, threshold: 2, heldForMs: 60_000 },
  },
  loadOne: 24,
};
const LAST_SEEN_STRESSED: Machine = {
  id: "charlie",
  indicator: {
    verdict: "unknown",
    unreachable: true,
    lastSeen: { verdict: "stressed", ageMs: 60_000 },
  },
};
const UNKNOWN: Machine = { id: "delta", indicator: { verdict: "unknown" } };
const NEVER_SEEN: Machine = { id: "echo", indicator: { verdict: "unknown", unreachable: true } };
const ALL = [OK, STRESSED, LAST_SEEN_STRESSED, UNKNOWN, NEVER_SEEN];

function setup(machines: ReadonlyArray<Machine>, { canReadDiagnostics = true } = {}) {
  state.machines = machines.map((machine) => ({
    environmentId: EnvironmentId.make(machine.id),
    label: machine.id.toUpperCase(),
  }));
  state.indicators.clear();
  state.totals.clear();
  for (const machine of machines) {
    state.indicators.set(machine.id, {
      show: true,
      verdict: "ok",
      unreachable: false,
      lastSeen: null,
      reason: null,
      ...machine.indicator,
    });
    if (machine.loadOne !== undefined) state.totals.set(machine.id, totals(machine.loadOne));
  }
  state.canReadDiagnostics = canReadDiagnostics;
  state.mounted.clear();
  state.requested.clear();
}

async function renderList() {
  const screen = await render(
    <RegistryContext value={AtomRegistry.make()}>
      <CrossMachineList />
    </RegistryContext>,
  );
  const row = (id: string) => {
    const link = screen.container.querySelector<HTMLAnchorElement>(`a[href="/machines/${id}"]`);
    if (!link) throw new Error(`no row for ${id}`);
    return link;
  };
  return {
    screen,
    row,
    /** The verdict column, third in the row grid. */
    verdict: (id: string) => row(id).children[2]?.textContent,
    header: () => screen.container.querySelector("header")?.textContent ?? "",
    rowIds: () =>
      [...screen.container.querySelectorAll("a")].map((link) =>
        link.getAttribute("href")?.replace("/machines/", ""),
      ),
    groupHeaders: () =>
      [...screen.container.querySelectorAll("li:not([aria-hidden])")]
        .filter((item) => item.querySelector("a") === null)
        .map((item) => item.textContent),
    [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose](),
  };
}

/** Overrides document.visibilityState until disposed. */
function tabVisibility() {
  const set = (visible: boolean) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (visible ? "visible" : "hidden"),
    });
    return act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  };
  return { set, [Symbol.dispose]: () => Reflect.deleteProperty(document, "visibilityState") };
}

const live = (prefix: string) =>
  [...state.mounted].filter((key) => key.startsWith(prefix)).toSorted();

describe("CrossMachineList", () => {
  it("groups worst first and links each row to its machine", async () => {
    setup(ALL);
    await using list = await renderList();

    await vi.waitFor(() =>
      expect(list.rowIds()).toEqual(["bravo", "charlie", "alpha", "delta", "echo"]),
    );
    expect(list.groupHeaders()).toEqual([
      "Stressed · 1",
      "Unreachable · last seen stressed · 1",
      "By load · 1",
      "Unknown · 2",
    ]);
    expect(list.row("alpha").getAttribute("href")).toBe("/machines/alpha");
  });

  it("shows only the load for an ok row", async () => {
    setup([OK, STRESSED]);
    await using list = await renderList();

    await vi.waitFor(() => expect(list.verdict("alpha")).toBe("load 0.5/core"));
    expect(list.verdict("bravo")).not.toMatch(/^load/);
  });

  it("counts each badge, unreachable machines apart from unknown ones", async () => {
    setup(ALL);
    await using list = await renderList();

    await vi.waitFor(() => expect(list.header()).toContain("1 stressed"));
    expect(list.header()).toContain("2 unreachable");
    expect(list.header()).toContain("1 unknown");
  });

  it("shows no badge for a zero count", async () => {
    setup([OK]);
    await using list = await renderList();

    await vi.waitFor(() => expect(list.rowIds()).toEqual(["alpha"]));
    expect(list.header()).not.toMatch(/stressed|unreachable|unknown/);
  });

  it("streams at a 5 s tick with 5 min of history, and re-keys on the toggle", async () => {
    setup([OK, STRESSED]);
    await using list = await renderList();

    await vi.waitFor(() =>
      expect(live("machine:")).toEqual(["machine:alpha:5000:300000", "machine:bravo:5000:300000"]),
    );
    expect(live("processes:")).toEqual(["processes:alpha:5000:3", "processes:bravo:5000:3"]);

    for (const [label, tick] of [
      ["2 s", 2_000],
      ["10 s", 10_000],
    ] as const) {
      await userEvent.click(list.screen.getByRole("button", { name: label }));
      await vi.waitFor(() =>
        expect(live("machine:")).toEqual([
          `machine:alpha:${tick}:300000`,
          `machine:bravo:${tick}:300000`,
        ]),
      );
      expect(live("processes:")).toEqual([
        `processes:alpha:${tick}:3`,
        `processes:bravo:${tick}:3`,
      ]);
    }
  });

  it("closes every machine and process stream while the tab is hidden, and reopens them", async () => {
    setup([OK, STRESSED]);
    using tab = tabVisibility();
    await using list = await renderList();
    const streams = [
      "machine:alpha:5000:300000",
      "machine:bravo:5000:300000",
      "processes:alpha:5000:3",
      "processes:bravo:5000:3",
    ];
    await vi.waitFor(() => expect(live("")).toEqual(streams));

    await tab.set(false);

    // Includes the streams the worst-first ordering reads, not only the rows'.
    await vi.waitFor(() => expect(live("")).toEqual([]));
    expect(list.rowIds()).toEqual(["bravo", "alpha"]);

    await tab.set(true);

    await vi.waitFor(() => expect(live("")).toEqual(streams));
    expect(list.rowIds()).toEqual(["bravo", "alpha"]);
  });

  it("opens no machine or process stream for an unreachable row", async () => {
    setup(ALL);
    await using list = await renderList();

    await vi.waitFor(() => expect(list.rowIds()).toHaveLength(5));
    const requested = [...state.requested];
    expect(requested.filter((key) => /:(charlie|echo):/.test(key))).toEqual([]);
    expect(requested.filter((key) => key.includes(":delta:"))).not.toEqual([]);
  });

  it("opens no process stream without diagnostics access", async () => {
    setup([OK], { canReadDiagnostics: false });
    await using list = await renderList();

    await vi.waitFor(() =>
      expect(list.row("alpha").textContent).toContain("No diagnostics access"),
    );
    expect([...state.requested].filter((key) => key.startsWith("processes:"))).toEqual([]);
  });
});
