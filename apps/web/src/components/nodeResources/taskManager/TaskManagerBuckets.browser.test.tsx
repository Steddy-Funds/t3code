import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import type {
  MachineProcessRow,
  MachineProcessTable,
} from "@t3tools/client-runtime/state/machineProcessFrames";
import {
  type Claim,
  ClaimId,
  type ClaimTarget,
  EnvironmentId,
  type MachineBucket,
  MachineBucketId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../../test/render";

const NOW = "2026-11-07T12:00";
const MIB = 1024 ** 2;

const state = vi.hoisted(() => ({
  config: null as unknown as Atom.Writable<unknown>,
  canRelease: null as unknown as Atom.Writable<boolean>,
  canReadDiagnostics: true,
  commands: [] as Array<unknown>,
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
vi.mock(import("~/state/machineResources"), async () => {
  const { Atom } = await import("effect/reactivity");
  state.canRelease = Atom.make(true).pipe(Atom.keepAlive);
  return {
    machineIndicator: {} as never,
    machineResources: {
      releaseClaim: { permissionAtom: () => state.canRelease },
    } as never,
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => (input: unknown) => {
    state.commands.push(input);
    return Promise.resolve();
  }) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((_id: unknown, scope: string) =>
    scope === "diagnostics:read" ? state.canReadDiagnostics : true) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useUpdateEnvironmentSettings: (() => () => {}) as never,
}));
vi.mock(import("~/hooks/useNowMinute"), () => ({ useNowMinute: () => NOW }));
vi.mock(import("~/state/threads"), async () => {
  const { Atom } = await import("effect/reactivity");
  const threads = Atom.make(() => [{ id: "thread-a", title: "Fix the build", projectId: "p" }]);
  return { environmentThreadShells: { environmentThreadsAtom: () => threads } as never } as never;
});

import { TaskManagerBuckets } from "./TaskManagerBuckets";

const environmentId = EnvironmentId.make("machine-a");
const THREAD = ThreadId.make("thread-a");
const BUCKET = MachineBucketId.make("bucket_builds");
const nowMs = Date.parse(`${NOW}:00Z`);

const BUILDS: MachineBucket = {
  id: BUCKET,
  name: "Builds",
  rules: [{ field: "exe", op: "equals", value: "cargo" }],
  provenance: {
    createdBy: { type: "user" },
    updatedBy: { type: "user" },
    updatedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  },
};

const claim = (overrides: Partial<Claim> = {}): Claim => ({
  id: ClaimId.make("claim-1"),
  threadId: THREAD,
  target: { type: "process", pid: 42, startTimeMs: 0 },
  createdAt: DateTime.makeUnsafe(nowMs - 2 * 3_600_000),
  createdBy: { type: "agent", threadId: THREAD },
  ...overrides,
});

const row = (pid: number, overrides: Partial<MachineProcessRow>): MachineProcessRow => ({
  key: pid,
  pid,
  ppid: 1,
  startTimeMs: 0,
  name: `p${pid}`,
  user: "",
  command: `p${pid}`,
  cpu: 10,
  rss: 100 * MIB,
  ...overrides,
});

const inBucket = { owner: { type: "bucket", bucketId: BUCKET } } as const;
const inClaim = {
  owner: { type: "claimed", claimId: ClaimId.make("claim-1"), threadId: THREAD },
} as const;

function setup({
  source = "host",
  rows = [row(2, inBucket), row(3, inBucket), row(4, inClaim)],
  claims = [claim()],
  canRelease = true,
  canReadDiagnostics = true,
}: {
  source?: MachineProcessTable["source"];
  rows?: ReadonlyArray<MachineProcessRow>;
  /** null: a server without claims. */
  claims?: ReadonlyArray<Claim> | null;
  canRelease?: boolean;
  canReadDiagnostics?: boolean;
} = {}) {
  state.commands.length = 0;
  state.canReadDiagnostics = canReadDiagnostics;
  const registry = AtomRegistry.make();
  registry.set(state.canRelease, canRelease);
  registry.set(state.config, {
    environment: { capabilities: { machineOwnership: true } },
    settings: { machineResources: { buckets: { [BUCKET]: BUILDS } } },
  });
  const table: MachineProcessTable = {
    generation: 1,
    sequence: 1,
    sampleAgeMs: 0,
    source,
    rows,
    truncated: 0,
    ...(claims === null ? {} : { claims }),
  };
  return { registry, processes: Atom.make(AsyncResult.success(table)) };
}

async function renderBuckets({ registry, processes }: ReturnType<typeof setup>) {
  const screen = await render(
    <RegistryContext value={registry}>
      <TaskManagerBuckets environmentId={environmentId} processes={processes} />
    </RegistryContext>,
    { router: false }, // no links
  );
  return {
    screen,
    /** A body row's cells, by text in the row. */
    cells: (text: string) =>
      [
        ...(screen.getByRole("row").filter({ hasText: text }).element().querySelectorAll("td") ??
          []),
      ].map((cell) => cell.textContent),
    [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose](),
  };
}

describe("TaskManagerBuckets", () => {
  it("totals each bucket and claim from host rows", async () => {
    await using view = await renderBuckets(setup());
    await expect.element(view.screen.getByRole("heading", { name: "Claims" })).toBeVisible();
    // Name, rules, pins, made by, then process count, CPU and memory.
    expect(view.cells("Builds").slice(4, 7)).toEqual(["2", "20%", "200 M"]);
    expect(view.cells("PID 42").slice(5, 7)).toEqual(["10%", "100 M"]);
  });

  it.each<[string, Parameters<typeof setup>[0], ReadonlyArray<string>]>([
    [
      "for buckets and claims when only T3's own processes are reported",
      { source: "t3" },
      ["unmeasured", "unmeasured", "unmeasured"],
    ],
    [
      "for a claim that can't be measured",
      { claims: [claim({ measurable: false })] },
      ["2", "20%", "200 M"],
    ],
  ])("shows unmeasured, never 0, %s", async (_name, options, bucketCells) => {
    await using view = await renderBuckets(setup(options));
    await expect.element(view.screen.getByRole("heading", { name: "Claims" })).toBeVisible();
    expect(view.cells("PID 42").slice(5, 7)).toEqual(["unmeasured", "unmeasured"]);
    expect(view.cells("Builds").slice(4, 7)).toEqual(bucketCells);
  });

  it("shows a null GPU value as unmeasured and a measured one as a percent", async () => {
    await using view = await renderBuckets(
      setup({
        rows: [
          row(2, { ...inBucket, gpuUtil: 30, vram: MIB }),
          row(3, { ...inBucket, gpuUtil: null, vram: null }),
          row(4, { ...inClaim, gpuUtil: 15, vram: MIB }),
        ],
      }),
    );
    await expect.element(view.screen.getByRole("heading", { name: "Claims" })).toBeVisible();
    expect(view.cells("Builds")[7]).toBe("unmeasured");
    expect(view.cells("PID 42")[7]).toBe("15%");
  });

  it.each([
    ["under a minute", 30_000, "< 1 m"],
    ["minutes", 5 * 60_000, "5 m"],
    ["hours", 2 * 3_600_000, "2 h"],
  ])("ages a claim made %s ago", async (_name, ageMs, text) => {
    await using view = await renderBuckets(
      setup({ claims: [claim({ createdAt: DateTime.makeUnsafe(nowMs - ageMs) })] }),
    );
    await expect.element(view.screen.getByRole("heading", { name: "Claims" })).toBeVisible();
    expect(view.cells("PID 42")[3]).toBe(text);
  });

  it.each<[ClaimTarget, string, string]>([
    [{ type: "process", pid: 42, startTimeMs: 0 }, "PID 42 + descendants", "process exits"],
    [{ type: "container", id: "pod-web" }, "pod-web", "container is removed"],
    [
      { type: "cgroup", path: "/system.slice/foo.service" },
      "/system.slice/foo.service",
      "cgroup is removed",
    ],
  ])("says when a %o claim ends", async (target, targetText, ends) => {
    await using view = await renderBuckets(setup({ claims: [claim({ target })] }));
    await expect.element(view.screen.getByRole("heading", { name: "Claims" })).toBeVisible();
    const cells = view.cells(targetText);
    expect(cells.slice(0, 2)).toEqual([targetText, target.type]);
    expect(cells[4]).toBe(`${ends} · or thread deleted`);
  });

  it("hides the claims section on a server without claims", async () => {
    await using view = await renderBuckets(setup({ claims: null }));
    await expect.element(view.screen.getByRole("heading", { name: "Buckets" })).toBeVisible();
    expect(view.screen.getByRole("heading", { name: "Claims" }).query()).toBeNull();
  });

  it("sends the claim id on Remove", async () => {
    await using view = await renderBuckets(setup());
    await view.screen.getByRole("button", { name: "Remove" }).click();
    expect(state.commands).toEqual([{ environmentId, input: { claimId: "claim-1" } }]);
  });

  it("hides Remove without release permission", async () => {
    await using view = await renderBuckets(setup({ canRelease: false }));
    await expect.element(view.screen.getByText("PID 42 + descendants")).toBeVisible();
    expect(view.screen.getByRole("button", { name: "Remove" }).query()).toBeNull();
    expect(view.screen.getByText(/Removing a claim/).query()).toBeNull();
  });

  it("says claims need diagnostics access", async () => {
    await using view = await renderBuckets(setup({ canReadDiagnostics: false }));
    await expect.element(view.screen.getByText("Claims need diagnostics access")).toBeVisible();
    expect(view.screen.getByText("PID 42 + descendants").query()).toBeNull();
  });
});
