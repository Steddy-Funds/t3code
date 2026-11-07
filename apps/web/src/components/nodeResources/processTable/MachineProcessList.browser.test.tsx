import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import type {
  MachineProcessRow,
  MachineProcessTable,
} from "@t3tools/client-runtime/state/machineProcessFrames";
import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { page } from "vite-plus/test/browser";

import { render } from "../../../../test/render";

const state = vi.hoisted(() => ({
  processes: null as unknown as MachineProcessTable,
  /** Every `machineProcesses` input, in render order. */
  requests: [] as Array<{ readonly intervalMs: number; readonly gpuProcesses?: boolean }>,
}));

vi.mock(import("~/state/machineResources"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const processes = Atom.make(() => AsyncResult.success(state.processes));
  return {
    machineIndicator: {} as never,
    machineResources: {
      machineProcesses: ((_id: unknown, input: (typeof state.requests)[number]) => {
        state.requests.push(input);
        return processes;
      }) as never,
    } as never,
  };
});
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
}));
vi.mock(import("./useProcessSignal"), () => ({
  useProcessSignal: () => ({
    canSignal: false,
    signalingKeys: new Set<string>(),
    requestKill: () => {},
    dialog: null,
  }),
}));

import { MachineProcessList } from "./MachineProcessList";

const process = (pid: number, gpu?: { gpuUtil: number | null; vram: number | null }) =>
  ({
    key: pid,
    pid,
    ppid: 1,
    startTimeMs: 0,
    name: `p${pid}`,
    user: "",
    command: `p${pid}`,
    cpu: 1,
    rss: 1024 ** 2,
    ...gpu,
  }) satisfies MachineProcessRow;

function setup(rows: ReadonlyArray<MachineProcessRow>) {
  state.requests.length = 0;
  state.processes = {
    generation: 1,
    sequence: 1,
    sampleAgeMs: 0,
    source: "t3",
    rows,
    truncated: 0,
  };
}

const renderList = (hasGpu: boolean) =>
  render(
    <RegistryContext value={AtomRegistry.make()}>
      <MachineProcessList
        environmentId={EnvironmentId.make("machine-a")}
        tick={1000}
        hasGpu={hasGpu}
        viewMode="raw"
        onViewModeChange={() => {}}
      />
    </RegistryContext>,
    { router: false }, // no links
  );

const lastRequest = () => state.requests.at(-1);
const menuItem = (name: string) => page.getByRole("menuitemcheckbox", { name });

describe("MachineProcessList", () => {
  it("shows GPU and VRAM and asks for per-process GPU on a machine with a GPU", async () => {
    setup([
      process(2, { gpuUtil: 40, vram: 2 * 1024 ** 3 }),
      process(3, { gpuUtil: null, vram: null }),
    ]);
    await using screen = await renderList(true);
    await expect.element(screen.getByRole("columnheader", { name: "GPU" })).toBeVisible();
    await expect.element(screen.getByRole("columnheader", { name: "VRAM" })).toBeVisible();
    await expect.element(screen.getByText("40%")).toBeVisible();
    await expect.element(screen.getByText("2.0 G")).toBeVisible();
    expect(lastRequest()).toEqual({ intervalMs: 1000, gpuProcesses: true });
  });

  it("keeps asking while either GPU column is shown and stops once both are hidden", async () => {
    setup([process(2, { gpuUtil: 40, vram: 1024 ** 3 })]);
    await using screen = await renderList(true);
    await screen.getByRole("button", { name: "Columns" }).click();

    await menuItem("GPU").click();
    await expect.element(menuItem("GPU")).not.toBeChecked();
    expect(lastRequest()).toEqual({ intervalMs: 1000, gpuProcesses: true });

    await menuItem("VRAM").click();
    await expect.element(menuItem("VRAM")).not.toBeChecked();
    expect(lastRequest()).toEqual({ intervalMs: 1000 });

    await menuItem("VRAM").click();
    await expect.element(menuItem("VRAM")).toBeChecked();
    expect(lastRequest()).toEqual({ intervalMs: 1000, gpuProcesses: true });
  });

  it("offers no GPU columns and asks for none on a machine without a GPU", async () => {
    // Even rows that carry GPU values don't bring the columns back.
    setup([process(2, { gpuUtil: 40, vram: 1024 ** 3 }), process(3)]);
    await using screen = await renderList(false);
    await expect.element(screen.getByRole("columnheader", { name: "CPU" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "GPU" }).query()).toBeNull();
    expect(screen.getByRole("columnheader", { name: "VRAM" }).query()).toBeNull();
    expect(state.requests.every((request) => !("gpuProcesses" in request))).toBe(true);

    await screen.getByRole("button", { name: "Columns" }).click();
    await expect.element(menuItem("Memory")).toBeVisible();
    expect(menuItem("GPU").query()).toBeNull();
    expect(menuItem("VRAM").query()).toBeNull();
  });
});
