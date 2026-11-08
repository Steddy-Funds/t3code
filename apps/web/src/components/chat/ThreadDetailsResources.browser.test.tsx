import type {
  MachineProcessRow,
  MachineProcessTable,
} from "@t3tools/client-runtime/state/machineProcessFrames";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  type ClaimId,
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
  processes: null as unknown,
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

const processRow = (
  pid: number,
  ppid: number,
  name: string,
  owner: MachineProcessRow["owner"] = { type: "thread", threadId: THREAD },
): MachineProcessRow => ({
  key: pid,
  pid,
  ppid,
  startTimeMs: pid,
  name,
  user: "",
  command: name,
  owner,
  cpu: 10,
  rss: 1_000,
});

const ROWS = [
  processRow(1, 0, "claude"),
  processRow(2, 1, "vite"),
  processRow(3, 0, "postgres", {
    type: "claimed",
    claimId: "claim-1" as ClaimId,
    threadId: THREAD,
  }),
];

function setup({
  scopes = [AuthOrchestrationReadScope, AuthDiagnosticsReadScope],
  driver = "codex",
  resources,
  rows = ROWS,
}: {
  scopes?: ReadonlyArray<string>;
  driver?: string;
  resources: AsyncResult.AsyncResult<ThreadResources, unknown>;
  rows?: ReadonlyArray<MachineProcessRow>;
}) {
  state.scopes = new Set(scopes);
  state.driver = driver;
  state.resources = Atom.make(resources);
  const table: MachineProcessTable = {
    generation: 1,
    sequence: 1,
    sampleAgeMs: 0,
    source: "host",
    rows,
    truncated: 0,
  };
  const processes = Atom.make(AsyncResult.success(table));
  state.machineProcesses = vi.fn<(...args: ReadonlyArray<unknown>) => unknown>(() => processes);
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

it("shows CPU, memory and the process rows of an active thread, and no GPU when unmeasured", async () => {
  setup({ resources: AsyncResult.success({ current: totals(), history: [] }) });
  await using screen = await render(ui);
  await expect.element(screen.getByText("42%")).toBeVisible();
  await expect.element(screen.getByText("2.0 G")).toBeVisible();
  await expect.element(screen.getByText("Processes · 2 + 1 claimed")).toBeVisible();
  await expect.element(screen.getByText("claude", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("vite", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("postgres", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("claimed", { exact: true })).toBeVisible();
  expect(screen.getByText("GPU", { exact: true }).elements()).toHaveLength(0);
  expect(state.machineProcesses).toHaveBeenCalledWith(ENVIRONMENT, {
    intervalMs: 2_000,
    threadId: THREAD,
  });
});

it("shows totals but no process list without diagnostics:read", async () => {
  setup({
    scopes: [AuthOrchestrationReadScope],
    resources: AsyncResult.success({ current: totals(), history: [] }),
  });
  await using screen = await render(ui);
  await expect.element(screen.getByText("42%")).toBeVisible();
  expect(screen.getByText(/Processes/).elements()).toHaveLength(0);
  expect(state.machineProcesses).not.toHaveBeenCalled();
});

it("shows an alert when the query fails", async () => {
  setup({ resources: AsyncResult.failure(Cause.fail(new Error("offline"))) });
  await using screen = await render(ui);
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Could not read this thread's resources.");
});
