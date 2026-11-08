import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import type {
  MachineProcessRow,
  MachineProcessTable,
} from "@t3tools/client-runtime/state/machineProcessFrames";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../../test/render";

const state = vi.hoisted(() => ({
  processes: null as unknown as MachineProcessTable,
  /** Every `machineProcesses` input, in render order. */
  requests: [] as Array<{ readonly intervalMs: number; readonly gpuProcesses?: boolean }>,
  /** Replaces the table's result while set, such as a failed or emptied stream. */
  result: null as unknown as Atom.Writable<AsyncResult.AsyncResult<
    MachineProcessTable,
    unknown
  > | null>,
  registry: null as unknown as AtomRegistry.AtomRegistry,
}));

vi.mock(import("~/state/machineResources"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  state.result = Atom.make<AsyncResult.AsyncResult<MachineProcessTable, unknown> | null>(null);
  const processes = Atom.make((get) => get(state.result) ?? AsyncResult.success(state.processes));
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
vi.mock(import("~/state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  const permission = Atom.make(true);
  const config = Atom.make(null);
  return {
    serverEnvironment: {
      signalProcess: { permissionAtom: () => permission },
      configValueAtom: () => config,
    } as never,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => () => new Promise(() => {})) as never,
}));

import { MachineProcessList, useMachineProcessListState } from "./MachineProcessList";

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
  state.registry = AtomRegistry.make();
  state.processes = {
    generation: 1,
    sequence: 1,
    sampleAgeMs: 0,
    source: "t3",
    rows,
    truncated: 0,
  };
}

function List({
  hasGpu,
  unavailable,
}: {
  readonly hasGpu: boolean | null;
  readonly unavailable: string | null;
}) {
  return (
    <MachineProcessList
      environmentId={EnvironmentId.make("machine-a")}
      tick={1000}
      hasGpu={hasGpu}
      unavailable={unavailable}
      state={useMachineProcessListState()}
      viewMode="raw"
      onViewModeChange={() => {}}
    />
  );
}

const renderList = (hasGpu: boolean | null, unavailable: string | null = null) =>
  render(
    <RegistryContext value={state.registry}>
      <List hasGpu={hasGpu} unavailable={unavailable} />
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

  it("opens no process stream until the GPU flag is known", async () => {
    setup([process(2)]);
    await using screen = await renderList(null);
    await expect.element(screen.getByText("Loading processes…")).toBeVisible();
    expect(state.requests).toEqual([]);
  });

  it("says why instead of waiting when the GPU flag won't arrive", async () => {
    setup([process(2)]);
    await using screen = await renderList(null, "Machine unreachable");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Machine unreachable");
    expect(screen.getByText("Loading processes…").query()).toBeNull();
    expect(state.requests).toEqual([]);
  });

  it.each<{
    label: string;
    result: () => AsyncResult.AsyncResult<MachineProcessTable, unknown>;
    message: string;
  }>([
    {
      label: "fails",
      result: () => AsyncResult.failure(Cause.fail(new Error("stream closed"))),
      message: "stream closed",
    },
    {
      label: "empties",
      result: () => AsyncResult.success({ ...state.processes, rows: [] }),
      message: "Process list needs the resource monitor",
    },
  ])("keeps an open kill confirm while the table $label", async ({ result, message }) => {
    setup([process(2)]);
    await using screen = await renderList(false);
    await screen.getByRole("button", { name: "Kill p2 (PID 2)" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog.getByRole("button", { name: "Kill", exact: true })).toBeEnabled();

    state.registry.set(state.result, result());
    await expect.element(page.getByText(message)).toBeInTheDocument();
    await expect.element(dialog).toBeVisible();

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect.element(dialog).not.toBeInTheDocument();
    state.registry.set(state.result, null);
    await expect.element(screen.getByRole("button", { name: "Kill p2 (PID 2)" })).toBeVisible();
    expect(dialog.query()).toBeNull();
  });
});
