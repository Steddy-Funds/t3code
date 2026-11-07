import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import type { MachineIndicator } from "@t3tools/client-runtime/state/machineIndicator";
import {
  EnvironmentId,
  type GpuDeviceSample,
  type MachineStatusSnapshot,
  type MachineVerdictReason,
} from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const GIB = 1024 ** 3;

const state = vi.hoisted(() => ({
  identities: [] as Array<{ environmentId: string; label: string }>,
  capable: true,
  indicator: null as unknown as MachineIndicator,
  snapshot: null as unknown as MachineStatusSnapshot,
  config: null as unknown,
  scopes: [] as Array<string>,
  sessions: null as ReadonlyArray<{ state: { status: string } }> | null,
  /** Live machine streams mounted, by "machine:<intervalMs>:<historyMs>". */
  mounted: new Set<string>(),
  requested: new Set<string>(),
  /** A failure the machine stream returns instead of the snapshot. */
  machineError: null as Error | null,
  /** Every GPU flag and unavailable reason the lists were rendered with, in order. */
  lists: [] as Array<{ hasGpu: boolean | null; unavailable: string | null }>,
}));

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIdentities: (() => state.identities) as never,
  useEnvironmentMachines: (() => new Map()) as never,
}));
vi.mock(import("~/state/machineResources"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const indicator = Atom.make(() => state.indicator);
  const capable = Atom.make(() => state.capable);
  const atoms = new Map<string, Atom.Atom<unknown>>();
  return {
    machineIndicator: {
      machineIndicatorAtom: () => indicator,
      machineCapableAtom: () => capable,
    } as never,
    machineResources: {
      machine: (_id: string, input: { intervalMs: number; historyMs: number }) => {
        const key = `machine:${input.intervalMs}:${input.historyMs}`;
        state.requested.add(key);
        let atom = atoms.get(key);
        if (!atom) {
          atom = Atom.make((get) => {
            state.mounted.add(key);
            get.addFinalizer(() => state.mounted.delete(key));
            return state.machineError
              ? AsyncResult.failure(Cause.fail(state.machineError))
              : AsyncResult.success(state.snapshot);
          });
          atoms.set(key, atom);
        }
        return atom;
      },
    } as never,
  };
});
vi.mock(import("~/state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(() => state.config);
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: () => config } as never,
  };
});
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((_id: unknown, scope: string) => state.scopes.includes(scope)) as never,
}));
vi.mock(import("~/state/terminalSessions"), async (original) => ({
  ...(await original()),
  useKnownTerminalSessions: (() => state.sessions) as never,
}));
// The process and thread lists have their own tests; here only the GPU flag they get matters.
vi.mock(import("./taskManager/TaskManagerLists"), () => ({
  TaskManagerLists: (({
    hasGpu,
    processesUnavailable,
  }: {
    hasGpu: boolean | null;
    processesUnavailable: string | null;
  }) => {
    state.lists.push({ hasGpu, unavailable: processesUnavailable });
    return null;
  }) as never,
}));
vi.mock(import("../ThreadTerminalDrawer"), () => ({
  TerminalViewport: ((props: {
    threadId: string;
    terminalId: string;
    cwd: string;
    onSessionExited: () => void;
  }) => (
    <div
      data-testid="terminal-viewport"
      data-thread={props.threadId}
      data-terminal={props.terminalId}
      data-cwd={props.cwd}
    >
      <button type="button" onClick={props.onSessionExited}>
        Exit shell
      </button>
    </div>
  )) as never,
}));

import { TaskManagerView } from "./TaskManagerView";

const environmentId = EnvironmentId.make("machine-a");
const PREFERENCES_KEY = "t3code:task-manager-preferences:v1";

const GPU: GpuDeviceSample = {
  id: "gpu-0",
  vendor: "nvidia",
  name: "RTX 4090",
  status: "active",
  utilPercent: 40,
  vramTotalBytes: 24 * GIB,
  vramUsedBytes: 6 * GIB,
  sharedMemory: false,
};

const snapshot = (gpus?: ReadonlyArray<GpuDeviceSample>): MachineStatusSnapshot => ({
  sequence: 1,
  verdict: "ok",
  verdictAgeMs: 0,
  reason: null,
  sampleAgeMs: 0,
  totals: {
    cpuUtilization: 0.25,
    cpuCount: 4,
    load: { one: 2, five: 2, fifteen: 2 },
    memoryTotalBytes: 32 * GIB,
    memoryAvailableBytes: 16 * GIB,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
    memoryPressure: null,
  },
  sample: { perCore: [10, 20, 30, 40], ...(gpus ? { gpus } : {}) },
});

const unsampled = (): MachineStatusSnapshot => {
  const { sample: _sample, ...rest } = snapshot();
  return rest;
};

const config = ({ os, homeDirectory }: { os: string; homeDirectory: string | undefined }) => ({
  cwd: "/srv/t3",
  ...(homeDirectory === undefined ? {} : { homeDirectory }),
  keybindings: [],
  environment: { platform: { os } },
  settings: {
    machineResources: {
      thresholds: {
        loadPerCore: 12.5,
        memoryUsedPercent: 90,
        windowsCpuPercent: 90,
        gpuUtilPercent: 95,
      },
    },
  },
});

function setup({
  indicator = {},
  gpus,
  os = "linux",
  homeDirectory = "/home/studio",
  scopes = [],
  sessions = null,
  capable = true,
}: {
  indicator?: Partial<MachineIndicator>;
  gpus?: ReadonlyArray<GpuDeviceSample>;
  os?: string;
  homeDirectory?: string | null;
  scopes?: Array<string>;
  sessions?: ReadonlyArray<{ state: { status: string } }> | null;
  capable?: boolean;
} = {}): Disposable {
  state.identities = [{ environmentId, label: "Studio" }];
  state.capable = capable;
  state.indicator = {
    show: true,
    verdict: "ok",
    unreachable: false,
    lastSeen: null,
    reason: null,
    ...indicator,
  };
  state.snapshot = snapshot(gpus);
  state.config = config({ os, homeDirectory: homeDirectory ?? undefined });
  state.scopes = scopes;
  state.sessions = sessions;
  state.mounted.clear();
  state.requested.clear();
  state.machineError = null;
  state.lists.length = 0;
  localStorage.removeItem(PREFERENCES_KEY);
  return { [Symbol.dispose]: () => localStorage.removeItem(PREFERENCES_KEY) };
}

async function renderView() {
  const screen = await render(
    <RegistryContext value={AtomRegistry.make()}>
      <TaskManagerView environmentId={environmentId} />
    </RegistryContext>,
  );
  return Object.assign(screen, {
    /** Section titles, once the first snapshot has built the series. */
    sections: () =>
      [...screen.container.querySelectorAll("section h3")].map((title) => title.textContent),
    tripped: () =>
      [...screen.container.querySelectorAll("section[data-tripped] h3")].map(
        (title) => title.textContent,
      ),
    viewport: () =>
      screen.container.querySelector<HTMLElement>('[data-testid="terminal-viewport"]'),
  });
}

const gpuFlags = () => state.lists.map((lists) => lists.hasGpu);
const live = () => [...state.mounted].toSorted();
const reason = (rule: MachineVerdictReason["rule"]): MachineVerdictReason => ({
  rule,
  value: 95,
  threshold: 90,
  heldForMs: 60_000,
  ...(rule.startsWith("gpu") ? { deviceId: "gpu-0" } : {}),
});

describe("TaskManagerView", () => {
  it("says so for a machine this app doesn't know", async () => {
    using _setup = setup();
    state.identities = [];
    await using screen = await renderView();
    await expect
      .element(screen.getByText("This machine isn't connected to this app."))
      .toBeVisible();
    expect(state.requested.size).toBe(0);
  });

  it("says so for a machine without resource telemetry", async () => {
    using _setup = setup({ capable: false });
    await using screen = await renderView();
    await expect.element(screen.getByText(/Studio doesn't report machine resources/)).toBeVisible();
    expect(state.requested.size).toBe(0);
  });

  it("shows no verdict text while ok, and every graph but the GPU", async () => {
    using _setup = setup();
    await using screen = await renderView();

    await vi.waitFor(() =>
      expect(screen.sections()).toEqual(["CPU", "Memory", "Load / core", "Cores", "Memory"]),
    );
    expect(screen.container.textContent).not.toMatch(/Stressed|No sample yet|Unreachable/);
    expect(screen.tripped()).toEqual([]);
  });

  it.each<[string, ReadonlyArray<GpuDeviceSample>, ReadonlyArray<string>]>([
    ["no devices", [], []],
    ["only unavailable devices", [{ ...GPU, status: "unavailable" }], []],
    ["a suspended device", [{ ...GPU, status: "suspended" }], ["GPU"]],
    ["an active device", [GPU], ["GPU", "VRAM"]],
  ])("draws GPU sections for %s", async (_name, gpus, expected) => {
    using _setup = setup({ gpus });
    await using screen = await renderView();

    await vi.waitFor(() => expect(screen.sections()).toContain("Cores"));
    expect(screen.sections().filter((title) => title === "GPU" || title === "VRAM")).toEqual(
      expected,
    );
  });

  it("draws no load graph on Windows", async () => {
    using _setup = setup({ os: "windows" });
    await using screen = await renderView();

    await vi.waitFor(() => expect(screen.sections()).toContain("Cores"));
    expect(screen.sections()).not.toContain("Load / core");
    expect(screen.sections()).toContain("CPU");
  });

  it.each<[MachineVerdictReason["rule"], ReadonlyArray<string>]>([
    ["cpu", ["CPU", "Cores"]],
    ["load", ["Load / core", "Cores"]],
    ["memory", ["Memory", "Memory"]],
    ["memoryPressure", ["Memory", "Memory"]],
    ["gpuUtil", ["GPU"]],
    ["gpuVram", ["GPU", "VRAM"]],
  ])("marks the sections the %s rule tripped", async (rule, expected) => {
    using _setup = setup({ indicator: { verdict: "stressed", reason: reason(rule) }, gpus: [GPU] });
    await using screen = await renderView();

    await vi.waitFor(() => expect(screen.tripped()).toEqual(expected));
  });

  it("streams the tick with the range as history, and re-keys on each toggle", async () => {
    using _setup = setup();
    await using screen = await renderView();
    await vi.waitFor(() => expect(live()).toEqual(["machine:1000:900000"]));

    await screen.getByRole("button", { name: "1 h" }).click();
    await vi.waitFor(() => expect(live()).toEqual(["machine:1000:3600000"]));

    await screen.getByRole("button", { name: "5 s" }).click();
    await vi.waitFor(() => expect(live()).toEqual(["machine:5000:3600000"]));
  });

  it("holds the GPU flag across tick and range re-keys whose fresh streams have no sample", async () => {
    using _setup = setup({ gpus: [GPU] });
    await using screen = await renderView();
    await vi.waitFor(() => expect(gpuFlags()).toContain(true));

    // A re-keyed stream starts without a sample; the flag must not fall back to unknown.
    state.snapshot = unsampled();
    await screen.getByRole("button", { name: "1 h" }).click();
    await vi.waitFor(() => expect(live()).toEqual(["machine:1000:3600000"]));
    await screen.getByRole("button", { name: "5 s" }).click();
    await vi.waitFor(() => expect(live()).toEqual(["machine:5000:3600000"]));

    // Unknown until the first sample, then known for good: the process stream opens once.
    const flags = gpuFlags();
    const first = flags.indexOf(true);
    expect(flags.slice(0, first).every((hasGpu) => hasGpu === null)).toBe(true);
    expect(flags.slice(first).every((hasGpu) => hasGpu === true)).toBe(true);
    expect(state.lists.every((lists) => lists.unavailable === null)).toBe(true);
  });

  it.each<[string, () => void, { hasGpu: boolean | null; unavailable: string | null }]>([
    [
      "waits without a reason before the first sample",
      () => (state.snapshot = unsampled()),
      { hasGpu: null, unavailable: null },
    ],
    [
      "passes false for a sample without a readable GPU",
      () => (state.snapshot = snapshot([{ ...GPU, status: "unavailable" }])),
      { hasGpu: false, unavailable: null },
    ],
    [
      "passes the stream's error when it fails before any sample",
      () => (state.machineError = new Error("stream closed")),
      { hasGpu: null, unavailable: "stream closed" },
    ],
  ])("%s", async (_name, arrange, expected) => {
    using _setup = setup();
    arrange();
    await using screen = await renderView();
    await expect.element(screen.getByRole("heading", { name: "Studio" })).toBeVisible();
    await vi.waitFor(() => expect(state.lists.at(-1)).toEqual(expected));
    expect(gpuFlags()).not.toContain(true);
  });

  it("opens no stream for an unreachable machine", async () => {
    using _setup = setup({
      indicator: { verdict: "unknown", unreachable: true, lastSeen: { verdict: "ok", ageMs: 1 } },
    });
    await using screen = await renderView();

    await expect.element(screen.getByRole("heading", { name: "Studio" })).toBeVisible();
    expect(state.requested.size).toBe(0);
    expect(screen.sections()).toEqual([]);
    expect(state.lists.at(-1)).toEqual({ hasGpu: null, unavailable: "Machine unreachable" });
  });

  describe("terminal", () => {
    it("is hidden without terminal access, even with a running shell", async () => {
      using _setup = setup({ sessions: [{ state: { status: "running" } }] });
      await using screen = await renderView();

      await vi.waitFor(() => expect(screen.sections()).toContain("CPU"));
      expect(screen.getByRole("button", { name: "Open terminal" }).query()).toBeNull();
      expect(screen.viewport()).toBeNull();
    });

    it("opens the machine terminal in the home directory", async () => {
      using _setup = setup({ scopes: ["terminal:operate"] });
      await using screen = await renderView();
      expect(screen.viewport()).toBeNull();

      await screen.getByRole("button", { name: "Open terminal" }).click();

      await vi.waitFor(() => expect(screen.viewport()).not.toBeNull());
      expect(screen.viewport()?.dataset).toMatchObject({
        thread: "machine-terminal",
        terminal: "default",
        cwd: "/home/studio",
      });
      expect(screen.sections()).toContain("Terminal");
      expect(screen.getByRole("button", { name: "Open terminal" }).query()).toBeNull();
    });

    it("opens in the server's cwd when an older server sends no home directory", async () => {
      using _setup = setup({ scopes: ["terminal:operate"], homeDirectory: null });
      await using screen = await renderView();

      await screen.getByRole("button", { name: "Open terminal" }).click();

      await vi.waitFor(() => expect(screen.viewport()?.dataset.cwd).toBe("/srv/t3"));
    });

    it.each([
      ["reopens a shell still running", [{ state: { status: "running" } }], true],
      ["stays closed for an exited shell", [{ state: { status: "exited" } }], false],
      ["stays closed with no known shell", null, false],
    ] as const)("%s on mount", async (_name, sessions, open) => {
      using _setup = setup({ scopes: ["terminal:operate"], sessions });
      await using screen = await renderView();

      await vi.waitFor(() => expect(screen.sections()).toContain("CPU"));
      expect(screen.viewport() !== null).toBe(open);
      expect(screen.getByRole("button", { name: "Open terminal" }).query() === null).toBe(open);
    });

    it.each(["Hide terminal", "Exit shell"])(
      "unmounts on %s and offers Open terminal again",
      async (button) => {
        using _setup = setup({
          scopes: ["terminal:operate"],
          sessions: [{ state: { status: "running" } }],
        });
        await using screen = await renderView();
        await vi.waitFor(() => expect(screen.viewport()).not.toBeNull());

        await screen.getByRole("button", { name: button }).click();

        await vi.waitFor(() => expect(screen.viewport()).toBeNull());
        // The shell is still running, but the user's choice wins over reopening it.
        await expect.element(screen.getByRole("button", { name: "Open terminal" })).toBeVisible();
      },
    );
  });
});
