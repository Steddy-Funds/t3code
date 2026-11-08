import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { Profiler } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../../test/render";

type Shell = Pick<OrchestrationV2ThreadShell, "id" | "title" | "status">;

const shells = vi.hoisted(() => ({ atom: null as unknown }));

vi.mock(import("~/state/threads"), async () => {
  const { Atom } = await import("effect/reactivity");
  shells.atom = Atom.make<ReadonlyArray<Shell>>([]);
  return {
    environmentThreadShells: { environmentThreadsAtom: () => shells.atom } as never,
  } as never;
});

import { Atom } from "effect/reactivity";
import { TaskManagerThreads } from "./TaskManagerThreads";

const environmentId = EnvironmentId.make("machine-a");

const shell = (id: string, status: Shell["status"], title = `Thread ${id}`): Shell => ({
  id: ThreadId.make(id),
  title,
  status,
});

const ALL_STATUSES: ReadonlyArray<Shell> = [
  shell("t-idle", "idle"),
  shell("t-preparing", "preparing"),
  shell("t-queued", "queued"),
  shell("t-starting", "starting"),
  shell("t-running", "running"),
  shell("t-waiting", "waiting"),
  shell("t-completed", "completed"),
  shell("t-interrupted", "interrupted"),
  shell("t-failed", "failed"),
  shell("t-cancelled", "cancelled"),
  shell("t-rolled-back", "rolled_back"),
];

async function renderThreads(initial: ReadonlyArray<Shell>) {
  const registry = AtomRegistry.make();
  const source = shells.atom as Atom.Writable<ReadonlyArray<Shell>>;
  registry.set(source, initial);
  let commits = 0;
  const screen = await render(
    <RegistryContext value={registry}>
      <Profiler id="threads" onRender={() => (commits += 1)}>
        <TaskManagerThreads environmentId={environmentId} />
      </Profiler>
    </RegistryContext>,
  );
  return Object.assign(screen, {
    commits: () => commits,
    set: (next: ReadonlyArray<Shell>) => act(() => registry.set(source, next)),
    rows: () =>
      [...screen.container.querySelectorAll("li a")].map((link) => ({
        href: link.getAttribute("href"),
        text: [...link.querySelectorAll("span")].map((span) => span.textContent),
      })),
    detail: () => screen.container.querySelector("section")?.textContent ?? "",
  });
}

describe("TaskManagerThreads", () => {
  it("lists only preparing, queued, starting and running threads, each linking to the thread", async () => {
    await using screen = await renderThreads(ALL_STATUSES);

    await vi.waitFor(() =>
      expect(screen.rows()).toEqual([
        { href: "/machine-a/t-preparing", text: ["Thread t-preparing", "Preparing"] },
        { href: "/machine-a/t-queued", text: ["Thread t-queued", "Queued"] },
        { href: "/machine-a/t-starting", text: ["Thread t-starting", "Starting"] },
        { href: "/machine-a/t-running", text: ["Thread t-running", "Running"] },
      ]),
    );
    expect(screen.detail()).toContain("Threads on this machine");
    expect(screen.detail()).toContain("4 running");
  });

  it("shows 0 running and no list when nothing runs", async () => {
    await using screen = await renderThreads([shell("t-idle", "idle")]);

    await vi.waitFor(() => expect(screen.detail()).toContain("0 running"));
    expect(screen.container.querySelector("ul")).toBeNull();
  });

  it("re-renders only when a listed thread changes", async () => {
    const running = shell("t-running", "running");
    const idle = shell("t-idle", "idle");
    await using screen = await renderThreads([running, idle]);
    await vi.waitFor(() => expect(screen.rows()).toHaveLength(1));
    const settled = screen.commits();

    // A new shell object for the same running thread, and an idle thread's update.
    await screen.set([{ ...running }, { ...idle, title: "Renamed idle" }]);
    expect(screen.commits()).toBe(settled);

    await screen.set([{ ...running, title: "Renamed" }, idle]);
    await vi.waitFor(() =>
      expect(screen.rows()).toEqual([
        { href: "/machine-a/t-running", text: ["Renamed", "Running"] },
      ]),
    );
    expect(screen.commits()).toBeGreaterThan(settled);

    const changed = screen.commits();
    await screen.set([{ ...running, title: "Renamed", status: "completed" }, idle]);
    await vi.waitFor(() => expect(screen.rows()).toEqual([]));
    expect(screen.commits()).toBeGreaterThan(changed);
  });
});
