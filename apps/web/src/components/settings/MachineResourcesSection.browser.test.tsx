import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_MACHINE_THRESHOLDS,
  EnvironmentId,
  type ExecutionEnvironmentPlatformOs,
  type MachineThresholds,
} from "@t3tools/contracts";
import { AtomRegistry, type Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  config: null as unknown as Atom.Writable<unknown>,
  canWrite: true,
  updateSettings: vi.fn(),
}));

vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  state.config = Atom.make<unknown>(null).pipe(Atom.keepAlive);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: (() => state.config) as never,
    } as never,
  };
});
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((_id: unknown, scope: string) =>
    scope === "settings:write" ? state.canWrite : true) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useUpdateEnvironmentSettings: (() => state.updateSettings) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: (({
    title,
    description,
    control,
    resetAction,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
    resetAction?: ReactNode;
  }) => (
    <div data-testid="row">
      <h4>{title}</h4>
      <p>{description}</p>
      {resetAction}
      {control}
    </div>
  )) as never,
  SettingResetButton: (({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" aria-label={`Reset ${label} to default`} onClick={onClick}>
      Reset
    </button>
  )) as never,
}));

import { MachineResourcesSection } from "./MachineResourcesSection";

const environmentId = EnvironmentId.make("machine-a");

function config({
  os = "linux",
  capable = true,
  thresholds = {},
}: {
  os?: ExecutionEnvironmentPlatformOs;
  capable?: boolean;
  thresholds?: Partial<MachineThresholds>;
} = {}) {
  return {
    environment: { capabilities: { machineResources: capable }, platform: { os } },
    settings: {
      machineResources: { thresholds: { ...DEFAULT_MACHINE_THRESHOLDS, ...thresholds } },
    },
  };
}

function setup({ canWrite = true }: { canWrite?: boolean } = {}) {
  state.canWrite = canWrite;
  state.updateSettings.mockReset();
  return AtomRegistry.make();
}

async function renderSection(registry: ReturnType<typeof AtomRegistry.make>, value: unknown) {
  registry.set(state.config, value);
  return render(
    <RegistryContext.Provider value={registry}>
      <MachineResourcesSection environmentId={environmentId} />
    </RegistryContext.Provider>,
  );
}

const patches = () => state.updateSettings.mock.calls.map(([patch]) => patch);
const thresholdPatch = (patch: Partial<MachineThresholds>) => ({
  machineResources: { thresholds: patch },
});

async function enter(input: HTMLElement, text: string) {
  await userEvent.clear(input);
  if (text !== "") await userEvent.type(input, text);
  await userEvent.tab();
}

describe("MachineResourcesSection bounds", () => {
  it.each([
    ["Load per core", "0", "Use a number above 0."],
    ["RAM used", "101", "Use a percent above 0, up to 100."],
    ["Hold before stressed", "3601", "Use 0 to 3600 seconds."],
    ["Clears below", "abc", "Use a percent above 0, up to 100."],
    ["Hold before clearing", "", "Use 0 to 3600 seconds."],
  ])("rejects %s = %j without saving", async (label, text, message) => {
    const registry = setup();
    await using screen = await renderSection(registry, config());
    const input = screen.getByRole("textbox", { name: label });

    await enter(input.element() as HTMLElement, text);

    await expect.element(screen.getByRole("alert")).toHaveTextContent(message);
    await expect.element(input).toHaveAttribute("aria-invalid", "true");
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("accepts exactly 100 percent and 3600 seconds", async () => {
    const registry = setup();
    await using screen = await renderSection(registry, config());

    await enter(screen.getByRole("textbox", { name: "RAM used" }).element() as HTMLElement, "100");
    await enter(
      screen.getByRole("textbox", { name: "Hold before stressed" }).element() as HTMLElement,
      "3600",
    );

    expect(screen.getByRole("alert").query()).toBeNull();
    expect(patches()).toEqual([
      thresholdPatch({ memoryUsedPercent: 100 }),
      thresholdPatch({ enterHoldMs: 3_600_000 }),
    ]);
  });
});

describe("MachineResourcesSection saving", () => {
  it("sends only the changed key, in stored units", async () => {
    const registry = setup();
    await using screen = await renderSection(registry, config());

    await expect
      .element(screen.getByRole("textbox", { name: "Clears below" }))
      .toHaveValue(String(DEFAULT_MACHINE_THRESHOLDS.exitFactor * 100));
    await enter(
      screen.getByRole("textbox", { name: "Clears below" }).element() as HTMLElement,
      "90",
    );
    await enter(
      screen.getByRole("textbox", { name: "Hold before stressed" }).element() as HTMLElement,
      "12.5",
    );

    expect(patches()).toEqual([
      thresholdPatch({ exitFactor: 0.9 }),
      thresholdPatch({ enterHoldMs: 12_500 }),
    ]);
  });

  it("sends nothing when a field blurs unchanged", async () => {
    const registry = setup();
    await using screen = await renderSection(registry, config());

    await userEvent.click(screen.getByRole("textbox", { name: "Load per core" }));
    await userEvent.tab();
    await enter(
      screen.getByRole("textbox", { name: "Clears below" }).element() as HTMLElement,
      "85",
    );

    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("restores the saved value when the save fails", async () => {
    const registry = setup();
    state.updateSettings.mockImplementation(
      (_patch: unknown, options?: { onFailed?: () => void }) => options?.onFailed?.(),
    );
    await using screen = await renderSection(registry, config());
    const input = screen.getByRole("textbox", { name: "RAM used" });

    await enter(input.element() as HTMLElement, "80");

    expect(patches()).toEqual([thresholdPatch({ memoryUsedPercent: 80 })]);
    await expect.element(input).toHaveValue(String(DEFAULT_MACHINE_THRESHOLDS.memoryUsedPercent));
  });
});

describe("MachineResourcesSection reset", () => {
  it("resets only the changed keys to their defaults", async () => {
    const registry = setup();
    await using screen = await renderSection(
      registry,
      config({ thresholds: { loadPerCore: 4, exitHoldMs: 5_000 } }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));

    expect(patches()).toEqual([
      thresholdPatch({
        loadPerCore: DEFAULT_MACHINE_THRESHOLDS.loadPerCore,
        exitHoldMs: DEFAULT_MACHINE_THRESHOLDS.exitHoldMs,
      }),
    ]);
  });

  it("resets one key from its row", async () => {
    const registry = setup();
    await using screen = await renderSection(
      registry,
      config({ thresholds: { loadPerCore: 4, exitHoldMs: 5_000 } }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Reset Load per core to default" }));

    expect(patches()).toEqual([
      thresholdPatch({ loadPerCore: DEFAULT_MACHINE_THRESHOLDS.loadPerCore }),
    ]);
    expect(screen.getByRole("button", { name: "Reset RAM used to default" }).query()).toBeNull();
  });

  it("shows no reset at defaults", async () => {
    const registry = setup();
    await using screen = await renderSection(registry, config());

    await expect.element(screen.getByRole("textbox", { name: "Load per core" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Reset/ }).query()).toBeNull();
  });

  it("shows no reset and disables inputs without settings:write", async () => {
    const registry = setup({ canWrite: false });
    await using screen = await renderSection(registry, config({ thresholds: { loadPerCore: 4 } }));

    await expect
      .element(
        screen.getByText("This connection lacks permission to change settings on this machine."),
      )
      .toBeVisible();
    await expect.element(screen.getByRole("textbox", { name: "Load per core" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Reset/ }).query()).toBeNull();
  });
});

describe("MachineResourcesSection rows by OS", () => {
  const inputNames = (screen: { container: HTMLElement }) =>
    [...screen.container.querySelectorAll("input")].map((input) =>
      input.getAttribute("aria-label"),
    );

  it("uses CPU used and CPU hold instead of load per core on Windows", async () => {
    const registry = setup();
    await using screen = await renderSection(registry, config({ os: "windows" }));

    await expect.element(screen.getByRole("textbox", { name: "CPU used" })).toBeVisible();
    // The monitor reads GPUs on Windows too, so the GPU rows stay.
    expect(inputNames(screen)).toEqual([
      "CPU used",
      "CPU hold",
      "RAM used",
      "GPU memory used",
      "GPU busy",
      "GPU busy hold",
      "Hold before stressed",
      "Clears below",
      "Hold before clearing",
    ]);
  });

  it("drops the RAM input and explains memory pressure on macOS", async () => {
    const registry = setup();
    await using screen = await renderSection(registry, config({ os: "darwin" }));

    await expect.element(screen.getByRole("heading", { name: "Memory" })).toBeVisible();
    expect(inputNames(screen)).toEqual([
      "Load per core",
      "Hold before stressed",
      "Clears below",
      "Hold before clearing",
    ]);
  });

  it("renders nothing when the machine lacks the capability", async () => {
    const registry = setup();
    await using screen = await renderSection(registry, config({ capable: false }));

    expect(screen.container.childElementCount).toBe(0);
  });
});
