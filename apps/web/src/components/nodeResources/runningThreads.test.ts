import {
  EnvironmentId,
  type OrchestrationV2LoadPause,
  type OrchestrationV2ThreadShell,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

type Shell = Pick<OrchestrationV2ThreadShell, "id" | "title" | "status" | "tags" | "loadPause">;

vi.mock(import("~/state/threads"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadShells: {
      environmentThreadsAtom: Atom.family((_id: string) => Atom.make<ReadonlyArray<Shell>>([])),
    } as never,
  } as never;
});

import { environmentThreadShells } from "~/state/threads";

import { type RunningThread, runningThreadCountAtom, runningThreadsAtom } from "./runningThreads";

const machineA = EnvironmentId.make("machine-a");
const machineB = EnvironmentId.make("machine-b");

const shell = (id: string, status: Shell["status"], title = `Thread ${id}`): Shell => ({
  id: ThreadId.make(id),
  title,
  status,
});

/** The atom's row for `shell(id, status, title)`, with no tags and no pause. */
const row = (
  id: string,
  status: Shell["status"],
  title = `Thread ${id}`,
  extra: Partial<RunningThread> = {},
): RunningThread => ({
  id: ThreadId.make(id),
  title,
  status,
  priority: "normal",
  loadPaused: false,
  ...extra,
});

const loadPause: OrchestrationV2LoadPause = {
  runId: RunId.make("run:paused"),
  episodeId: "episode:1",
  pausedAt: "2026-11-08T10:00:00.000Z",
  reason: { rule: "load", value: 4, threshold: 3, shareOfLoad: 0.5 },
  containersPaused: [],
};

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
      row("t-preparing", "preparing"),
      row("t-queued", "queued"),
      row("t-starting", "starting"),
      row("t-running", "running"),
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
    expect(threads.at(-1)).toEqual([row("a", "running", "Renamed")]);
    expect(threads.length).toBe(settled[0]! + 1);

    set(machineA, [{ ...running, status: "queued" }]);
    expect(threads.at(-1)).toEqual([row("a", "queued")]);

    const before = threads.length;
    set(machineA, [{ ...running, status: "queued", tags: ["backgrounded"] }]);
    expect(threads.at(-1)).toEqual([row("a", "queued", undefined, { priority: "low" })]);
    set(machineA, [{ ...running, status: "queued", tags: ["backgrounded"], loadPause }]);
    expect(threads.at(-1)).toEqual([
      row("a", "queued", undefined, { priority: "low", loadPaused: true }),
    ]);
    expect(threads.length).toBe(before + 2);
  });

  it("derives priority from tags, keeps load-paused threads listed and leaves them out of the count", () => {
    const { registry, set } = setup();
    set(machineA, [
      shell("plain", "running"),
      { ...shell("bg", "running"), tags: ["backgrounded"] },
      { ...shell("bg-normal", "running"), tags: ["backgrounded", "priority:normal"] },
      { ...shell("low", "queued"), tags: ["priority:low"] },
      // The pause interrupted its run, so the shell reads interrupted.
      { ...shell("paused", "interrupted"), tags: ["backgrounded"], loadPause },
      { ...shell("paused-idle", "idle"), loadPause },
      { ...shell("done", "interrupted"), loadPause: null },
    ]);

    expect(registry.get(runningThreadsAtom(machineA))).toEqual([
      row("plain", "running"),
      row("bg", "running", undefined, { priority: "low" }),
      row("bg-normal", "running"),
      row("low", "queued", undefined, { priority: "low" }),
      row("paused", "interrupted", undefined, { priority: "low", loadPaused: true }),
      row("paused-idle", "idle", undefined, { loadPaused: true }),
    ]);
    expect(registry.get(runningThreadCountAtom(machineA))).toBe(4);
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
