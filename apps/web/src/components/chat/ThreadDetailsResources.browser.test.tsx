import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ThreadId,
  type ThreadResources,
  type ThreadResourceTotals,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  driver: "codex",
  resources: null as unknown,
  machineProcesses: vi.fn<(...args: ReadonlyArray<unknown>) => unknown>(),
}));

vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: (_environmentId: unknown, scope: string) => state.scopes.has(scope),
}));
vi.mock("../../state/entities", () => ({
  useQuietThreadShell: () => ({ providerInstanceId: "instance-1", runtime: null }),
  useServerConfigs: () => ({
    get: () => ({ environment: { capabilities: { machineOwnership: true } } }),
  }),
}));
vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: () => Atom.make([{ instanceId: "instance-1", driver: state.driver }]),
    },
  };
});
vi.mock("../../state/machineResources", () => ({
  machineResources: {
    threadResources: () => state.resources,
    machineProcesses: (...args: ReadonlyArray<unknown>) => state.machineProcesses(...args),
  },
}));

import {
  machineSurface,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../../rightPanelStore";
import { ThreadDetailsResources } from "./ThreadDetailsResources";

const ENVIRONMENT = EnvironmentId.make("environment");
const THREAD = ThreadId.make("thread-1");
const GIB = 1024 ** 3;

const totals = (overrides: Partial<ThreadResourceTotals> = {}): ThreadResourceTotals => ({
  cpuPercent: 42,
  memoryBytes: 2 * GIB,
  gpuUtilPercent: null,
  vramBytes: null,
  processCount: 3,
  sampleAgeMs: 0,
  source: "sample",
  ...overrides,
});

function setup({
  scopes = [AuthOrchestrationReadScope],
  driver = "codex",
  resources,
}: {
  scopes?: ReadonlyArray<string>;
  driver?: string;
  resources: AsyncResult.AsyncResult<ThreadResources, unknown>;
}) {
  state.scopes = new Set(scopes);
  state.driver = driver;
  state.resources = Atom.make(resources);
  state.machineProcesses = vi.fn<(...args: ReadonlyArray<unknown>) => unknown>();
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
}

const ui = <ThreadDetailsResources environmentId={ENVIRONMENT} threadId={THREAD} />;

it("renders nothing without orchestration:read", async () => {
  setup({ scopes: [], resources: AsyncResult.success({ current: totals(), history: [] }) });
  await using screen = await render(ui);
  expect(screen.container.textContent).toBe("");
});

it("tells a Cursor thread with no processes how to count one", async () => {
  setup({
    driver: "cursor",
    resources: AsyncResult.success({ current: totals({ processCount: 0 }), history: [] }),
  });
  await using screen = await render(ui);
  await expect.element(screen.getByText(/Cursor runs inside the T3 server/)).toBeVisible();
});

it("sums up an idle thread", async () => {
  setup({
    resources: AsyncResult.success({
      current: null,
      history: [
        { ageMs: 90_000, cpuPercent: 80, memoryBytes: 256 * 1024 ** 2, gpuUtilPercent: null },
        { ageMs: 30_000, cpuPercent: 20, memoryBytes: 512 * 1024 ** 2, gpuUtilPercent: null },
      ],
    }),
  });
  await using screen = await render(ui);
  await expect
    .element(screen.getByText("0 processes · last active 30 s ago · peak 80% CPU, 512 M"))
    .toBeVisible();
});

it("shows CPU and memory of an active thread, and no GPU when unmeasured", async () => {
  setup({ resources: AsyncResult.success({ current: totals(), history: [] }) });
  await using screen = await render(ui);
  await expect.element(screen.getByText("42%")).toBeVisible();
  await expect.element(screen.getByText("2.0 G")).toBeVisible();
  expect(screen.getByText("GPU", { exact: true }).elements()).toHaveLength(0);
});

it("lists no processes and opens no process stream, even with diagnostics:read", async () => {
  setup({
    scopes: [AuthOrchestrationReadScope, AuthDiagnosticsReadScope],
    resources: AsyncResult.success({ current: totals(), history: [] }),
  });
  await using screen = await render(ui);
  await expect.element(screen.getByText("42%")).toBeVisible();
  expect(screen.getByText(/Processes/).elements()).toHaveLength(0);
  expect(state.machineProcesses).not.toHaveBeenCalled();
});

it.each([
  { label: "an active thread", current: totals() },
  { label: "an idle thread", current: null },
])("opens the machine tab focused on the thread from $label", async ({ current }) => {
  setup({ resources: AsyncResult.success({ current, history: [] }) });
  await using screen = await render(ui);
  await screen.getByRole("button", { name: /Show on the machine tab/ }).click();
  const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, {
    environmentId: ENVIRONMENT,
    threadId: THREAD,
  });
  expect(panel.activeSurfaceId).toBe(`machine:${ENVIRONMENT}`);
  expect(panel.surfaces).toEqual([machineSurface(ENVIRONMENT, THREAD)]);
});

it("shows an alert when the query fails", async () => {
  setup({ resources: AsyncResult.failure(Cause.fail(new Error("offline"))) });
  await using screen = await render(ui);
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Could not read this thread's resources.");
});
