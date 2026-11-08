import { EnvironmentId, type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

type Shell = Pick<OrchestrationV2ThreadShell, "id" | "title" | "status">;

vi.mock(import("~/state/threads"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadShells: {
      environmentThreadsAtom: Atom.family((_id: string) => Atom.make<ReadonlyArray<Shell>>([])),
    } as never,
  } as never;
});

import { environmentThreadShells } from "~/state/threads";

import { runningThreadCountAtom, runningThreadsAtom } from "./runningThreads";

const machineA = EnvironmentId.make("machine-a");
const machineB = EnvironmentId.make("machine-b");

const shell = (id: string, status: Shell["status"], title = `Thread ${id}`): Shell => ({
  id: ThreadId.make(id),
  title,
  status,
});

const STATUSES: ReadonlyArray<Shell["status"]> = [
  "idle",
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
];

function setup() {
  const registry = AtomRegistry.make();
  const shells = (id: EnvironmentId) =>
    environmentThreadShells.environmentThreadsAtom(id) as unknown as Atom.Writable<
      ReadonlyArray<Shell>
    >;
  return {
    registry,
    set: (id: EnvironmentId, next: ReadonlyArray<Shell>) => registry.set(shells(id), next),
    /** Every value a mounted reader is told about. */
    watch: <A>(atom: Atom.Atom<A>) => {
      const seen: Array<A> = [];
      registry.subscribe(atom, (value) => seen.push(value));
      return seen;
    },
  };
}

describe("runningThreadsAtom", () => {
  it("keeps preparing, queued, starting and running threads, in shell order", () => {
    const { registry, set } = setup();
    set(
      machineA,
      STATUSES.map((status) => shell(`t-${status}`, status)),
    );

    expect(registry.get(runningThreadsAtom(machineA))).toEqual([
      shell("t-preparing", "preparing"),
      shell("t-queued", "queued"),
      shell("t-starting", "starting"),
      shell("t-running", "running"),
    ]);
    expect(registry.get(runningThreadCountAtom(machineA))).toBe(4);
  });

  it("reads only its own environment's shells", () => {
    const { registry, set } = setup();
    set(machineA, [shell("a", "running")]);
    set(machineB, [shell("b1", "running"), shell("b2", "queued")]);

    expect(registry.get(runningThreadCountAtom(machineA))).toBe(1);
    expect(registry.get(runningThreadCountAtom(machineB))).toBe(2);
  });

  it("does not notify readers when a shell change leaves the running list equal", () => {
    const { set, watch } = setup();
    const running = shell("a", "running");
    set(machineA, [running, shell("idle", "idle")]);
    const threads = watch(runningThreadsAtom(machineA));
    const counts = watch(runningThreadCountAtom(machineA));
    const settled = [threads.length, counts.length];

    set(machineA, [{ ...running }, shell("idle", "idle", "Renamed idle"), shell("x", "completed")]);
    expect([threads.length, counts.length]).toEqual(settled);

    set(machineA, [{ ...running, title: "Renamed" }]);
    expect(threads.at(-1)).toEqual([shell("a", "running", "Renamed")]);
    expect(threads.length).toBe(settled[0]! + 1);

    set(machineA, [{ ...running, status: "queued" }]);
    expect(threads.at(-1)).toEqual([shell("a", "queued")]);
  });

  it("moves the count with the list", () => {
    const { set, watch } = setup();
    const counts = watch(runningThreadCountAtom(machineA));

    set(machineA, [shell("a", "running")]);
    set(machineA, [shell("a", "running"), shell("b", "starting")]);
    set(machineA, [shell("a", "completed"), shell("b", "starting")]);
    set(machineA, [shell("a", "completed"), shell("b", "failed")]);

    expect(counts.slice(-4)).toEqual([1, 2, 1, 0]);
  });
});
