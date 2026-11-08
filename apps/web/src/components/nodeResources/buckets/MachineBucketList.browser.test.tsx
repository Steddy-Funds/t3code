import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  MACHINE_BUCKETS_MAX,
  type MachineBucket,
  MachineBucketId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";

const state = vi.hoisted(() => ({
  config: null as unknown as Atom.Writable<unknown>,
  canWrite: true,
  /** Calls `onFailed` instead of succeeding, as a rejected settings write does. */
  failSave: false,
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
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useUpdateEnvironmentSettings: (() => state.updateSettings) as never,
}));
vi.mock(import("~/state/threads"), async () => {
  const { Atom } = await import("effect/reactivity");
  const threads = Atom.make(() => [
    { id: "thread-agent", title: "Native monitor", projectId: "project-1" },
  ]);
  return { environmentThreadShells: { environmentThreadsAtom: () => threads } as never } as never;
});

import { MachineBucketList } from "./MachineBucketList";

const environmentId = EnvironmentId.make("machine-a");

const bucket = (id: string, name: string, overrides: Partial<MachineBucket> = {}): MachineBucket => ({
  id: MachineBucketId.make(id),
  name,
  rules: [{ field: "exe", op: "equals", value: "cargo" }],
  provenance: {
    createdBy: { type: "user" },
    updatedBy: { type: "user" },
    updatedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
  },
  ...overrides,
});

function setup({
  buckets = [bucket("bucket_builds", "Builds")],
  canWrite = true,
  failSave = false,
}: { buckets?: ReadonlyArray<MachineBucket>; canWrite?: boolean; failSave?: boolean } = {}) {
  state.canWrite = canWrite;
  state.failSave = failSave;
  state.updateSettings.mockReset();
  state.updateSettings.mockImplementation(
    (_patch: unknown, options?: { readonly onFailed?: () => void }) => {
      if (state.failSave) options?.onFailed?.();
    },
  );
  const registry = AtomRegistry.make();
  registry.set(state.config, {
    environment: { capabilities: { machineOwnership: true } },
    settings: {
      machineResources: {
        buckets: Object.fromEntries(buckets.map((entry) => [entry.id, entry])),
      },
    },
  });
  return registry;
}

const renderList = (registry: AtomRegistry.AtomRegistry) =>
  render(
    <RegistryContext value={registry}>
      <MachineBucketList environmentId={environmentId} />
    </RegistryContext>,
    { router: false }, // no links
  );

const patches = () => state.updateSettings.mock.calls.map(([patch]) => patch);

describe("MachineBucketList", () => {
  it("saves a new bucket as one bucket_<uuid> entry with trimmed name and rules", async () => {
    await using screen = await renderList(setup());
    await screen.getByRole("button", { name: "New bucket" }).click();
    const form = screen.getByRole("form", { name: "New bucket" });
    await userEvent.type(form.getByRole("textbox", { name: "Bucket name" }), "  Pods  ");
    await userEvent.type(form.getByRole("textbox", { name: "Rule value" }), " cargo ");
    await form.getByRole("button", { name: "Save" }).click();

    expect(patches()).toHaveLength(1);
    const entries = Object.entries(patches()[0].machineResources.buckets);
    expect(entries).toHaveLength(1);
    const [id, entry] = entries[0]!;
    expect(id).toMatch(/^bucket_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(entry).toEqual({
      id,
      name: "Pods",
      rules: [{ field: "exe", op: "equals", value: "cargo" }],
    });
    await expect.element(form).not.toBeInTheDocument();
  });

  it("saves an edit under the bucket's own id", async () => {
    await using screen = await renderList(setup());
    await screen.getByRole("button", { name: "Edit" }).click();
    const name = screen.getByRole("form", { name: "Edit Builds" }).getByRole("textbox", {
      name: "Bucket name",
    });
    await userEvent.clear(name);
    await userEvent.type(name, "CI builds");
    await screen.getByRole("button", { name: "Save" }).click();

    expect(patches()).toEqual([
      {
        machineResources: {
          buckets: {
            bucket_builds: {
              id: "bucket_builds",
              name: "CI builds",
              rules: [{ field: "exe", op: "equals", value: "cargo" }],
            },
          },
        },
      },
    ]);
  });

  it("deletes after confirming, sending null for the bucket", async () => {
    await using screen = await renderList(setup());
    await screen.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect.element(dialog).toMatchTextContent("Delete bucket Builds?");
    expect(patches()).toEqual([]);

    await dialog.getByRole("button", { name: "Delete" }).click();
    expect(patches()).toEqual([{ machineResources: { buckets: { bucket_builds: null } } }]);
    await expect.element(dialog).not.toBeInTheDocument();
  });

  it("reopens the editor with what was typed when the save fails", async () => {
    await using screen = await renderList(setup({ failSave: true }));
    await screen.getByRole("button", { name: "New bucket" }).click();
    await userEvent.type(screen.getByRole("textbox", { name: "Bucket name" }), "Pods");
    await userEvent.type(screen.getByRole("textbox", { name: "Rule value" }), "kubelet");
    await screen.getByRole("button", { name: "Save" }).click();

    expect(patches()).toHaveLength(1);
    const form = screen.getByRole("form", { name: "New bucket" });
    await expect.element(form.getByRole("textbox", { name: "Bucket name" })).toHaveValue("Pods");
    await expect.element(form.getByRole("textbox", { name: "Rule value" })).toHaveValue("kubelet");
  });

  it("shows what blocks a save only after Save, and sends nothing", async () => {
    await using screen = await renderList(setup());
    await screen.getByRole("button", { name: "New bucket" }).click();
    const form = screen.getByRole("form", { name: "New bucket" });
    await expect.element(form.getByRole("textbox", { name: "Bucket name" })).toBeVisible();
    expect(form.getByRole("alert").query()).toBeNull();

    await form.getByRole("button", { name: "Save" }).click();
    await expect.element(form.getByRole("alert")).toHaveTextContent("Enter a name");

    await userEvent.type(form.getByRole("textbox", { name: "Bucket name" }), "Pods");
    await expect.element(form.getByRole("alert")).toHaveTextContent("Enter a value");
    expect(patches()).toEqual([]);
  });

  it.each([
    [MACHINE_BUCKETS_MAX, true],
    [MACHINE_BUCKETS_MAX - 1, false],
  ])("with %i buckets, New bucket is disabled: %s", async (count, disabled) => {
    const buckets = Array.from({ length: count }, (_, index) =>
      bucket(`bucket_${index}`, `Bucket ${String(index).padStart(2, "0")}`),
    );
    await using screen = await renderList(setup({ buckets }));
    const button = screen.getByRole("button", { name: "New bucket" });
    if (disabled) await expect.element(button).toBeDisabled();
    else await expect.element(button).toBeEnabled();
  });

  it("hides New bucket, Edit and Delete without settings-write access", async () => {
    await using screen = await renderList(setup({ canWrite: false }));
    await expect.element(screen.getByText("Builds")).toBeVisible();
    for (const name of ["New bucket", "Edit", "Delete"]) {
      expect(screen.getByRole("button", { name }).query()).toBeNull();
    }
  });

  it("names rules, pins and who made each bucket", async () => {
    const agentThread = ThreadId.make("thread-agent");
    await using screen = await renderList(
      setup({
        buckets: [
          bucket("bucket_a", "Agent made", {
            rules: [
              { field: "thread", threadId: agentThread },
              { field: "pid", pid: 4242, startTimeMs: 1 },
            ],
            provenance: {
              createdBy: { type: "agent", threadId: agentThread },
              updatedBy: { type: "agent", threadId: agentThread },
              updatedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
            },
          }),
          bucket("bucket_b", "Auto made", {
            provenance: {
              createdBy: { type: "auto", threadId: ThreadId.make("thread-unloaded") },
              updatedBy: { type: "user" },
              updatedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z"),
            },
          }),
          bucket("bucket_c", "User made"),
        ],
      }),
    );
    const row = (name: string) => screen.getByRole("row").filter({ hasText: name });
    await expect.element(row("Agent made")).toMatchTextContent("thread Native monitor");
    await expect.element(row("Agent made")).toMatchTextContent("4242");
    // A thread this client hasn't loaded shows a short id.
    await expect.element(row("Auto made")).toMatchTextContent("Autothread thread-u");
    await expect.element(row("User made")).toMatchTextContent("exe = cargo");
    await expect.element(row("User made")).toMatchTextContent("You");
  });
});
