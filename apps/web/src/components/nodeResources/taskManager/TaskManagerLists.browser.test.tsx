import "~/index.css";

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { MachineProcessTable } from "@t3tools/client-runtime/state/machineProcessFrames";
import { EnvironmentId } from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";

const state = vi.hoisted(() => ({
  /** Process streams mounted, by "processes:<intervalMs>". */
  mounted: new Set<string>(),
}));

vi.mock(import("~/state/machineResources"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const table: MachineProcessTable = {
    generation: 1,
    sequence: 1,
    sampleAgeMs: 0,
    source: "t3",
    rows: [
      { key: 2, pid: 2, ppid: 1, startTimeMs: 0, name: "p2", user: "", command: "p2", cpu: 9 },
      { key: 3, pid: 3, ppid: 1, startTimeMs: 0, name: "p3", user: "", command: "p3", cpu: 1 },
    ].map((row, index) => ({ ...row, rss: (index + 1) * 1024 ** 2 })),
    truncated: 0,
  };
  const atoms = new Map<string, Atom.Atom<unknown>>();
  return {
    machineIndicator: {} as never,
    machineResources: {
      machineProcesses: ((_id: unknown, input: { intervalMs: number }) => {
        const key = `processes:${input.intervalMs}`;
        let atom = atoms.get(key);
        if (!atom) {
          atom = Atom.make((get) => {
            state.mounted.add(key);
            get.addFinalizer(() => state.mounted.delete(key));
            return AsyncResult.success(table);
          });
          atoms.set(key, atom);
        }
        return atom;
      }) as never,
    } as never,
  };
});
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
}));
vi.mock(import("../processTable/useProcessSignal"), () => ({
  useProcessSignal: () => ({
    canSignal: false,
    signalingKeys: new Set<string>(),
    requestKill: () => {},
    dialog: null,
  }),
}));
vi.mock(import("../runningThreads"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const none = Atom.make([]);
  return { ...(await original()), runningThreadsAtom: (() => none) as never };
});

import {
  machineProcessesSource,
  useMachineProcessListState,
} from "../processTable/MachineProcessList";
import { TaskManagerLists } from "./TaskManagerLists";

function setup() {
  state.mounted.clear();
}

const environmentId = EnvironmentId.make("machine-a");

/** The page's wiring: one stream from the list state, also read above the tabs as the pool does. */
function Lists() {
  const processListState = useMachineProcessListState();
  const processes = machineProcessesSource({
    environmentId,
    tick: 1000,
    hasGpu: false,
    canReadDiagnostics: true,
    hidden: processListState.hidden,
    tab: processListState.tab,
  });
  useAtomValue(processes);
  return (
    <TaskManagerLists
      environmentId={environmentId}
      processes={processes}
      processListState={processListState}
      hasGpu={false}
      processesUnavailable={null}
      viewMode="raw"
      onViewModeChange={() => {}}
    />
  );
}

const renderLists = () =>
  render(
    <RegistryContext value={AtomRegistry.make()}>
      <Lists />
    </RegistryContext>,
  );

const header = (name: string) => page.getByRole("columnheader", { name, exact: true });

describe("TaskManagerLists", () => {
  it("keeps the process sort and columns across Threads, and closes the stream meanwhile", async () => {
    setup();
    await using screen = await renderLists();
    await expect.element(header("CPU")).toHaveAttribute("aria-sort", "descending");
    expect([...state.mounted]).toEqual(["processes:1000"]);

    await header("Memory").click();
    await expect.element(header("Memory")).toHaveAttribute("aria-sort", "descending");
    await screen.getByRole("button", { name: "Columns" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Command" }).click();
    await expect.element(header("Command")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByRole("menuitemcheckbox", { name: "Command" }))
      .not.toBeInTheDocument();

    await screen.getByRole("button", { name: "Threads" }).click();
    await expect.element(screen.getByText("Threads on this machine")).toBeVisible();
    expect(header("Memory").query()).toBeNull();
    // Closed even though the pool above the tabs still reads the stream.
    await vi.waitFor(() => expect([...state.mounted]).toEqual([]));

    await screen.getByRole("button", { name: "Processes" }).click();
    await expect.element(header("Memory")).toHaveAttribute("aria-sort", "descending");
    await expect.element(header("CPU")).toHaveAttribute("aria-sort", "none");
    expect(header("Command").query()).toBeNull();
    expect([...state.mounted]).toEqual(["processes:1000"]);
  });
});
