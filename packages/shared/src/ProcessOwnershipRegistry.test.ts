import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  ProcessOwnershipRegistry,
  type ProcessRoot,
  makeProcessOwnershipRegistry,
} from "./ProcessOwnershipRegistry.ts";

const SELF = "/user.slice/t3.service";
const MOVED = "/user.slice/agent-1.scope";

function harness(
  initial: Record<number, string | undefined> = {},
  startTicks?: Map<number, number>,
) {
  const cgroups = new Map(Object.entries(initial).map(([pid, path]) => [Number(pid), path]));
  const reads: Array<number> = [];
  let now = 1_000;
  const registry = makeProcessOwnershipRegistry({
    readPidCgroup: (pid) => {
      reads.push(pid);
      return cgroups.get(pid);
    },
    selfCgroup: SELF,
    now: () => now,
    ...(startTicks === undefined ? {} : { readPidStartTicks: (pid) => startTicks.get(pid) }),
  });
  return {
    registry,
    reads,
    move: (pid: number, path: string) => cgroups.set(pid, path),
    tick: (ms: number) => {
      now += ms;
    },
  };
}

const threadRoot = (pid: number, extra: Partial<ProcessRoot> = {}): ProcessRoot => ({
  pid,
  owner: { type: "thread", threadId: `thread-${pid}` },
  ...extra,
});

describe("makeProcessOwnershipRegistry", () => {
  it("stamps each root with a fresh id, its registration time and its cgroup", () => {
    const { registry, tick } = harness({ 10: MOVED });
    registry.registerRoot(threadRoot(10));
    tick(500);
    registry.registerRoot(threadRoot(11));
    expect(registry.roots()).toEqual([
      {
        id: 0,
        root: threadRoot(10),
        registeredAtMs: 1_000,
        cgroup: { type: "adopted", cgroup: MOVED },
      },
      { id: 1, root: threadRoot(11), registeredAtMs: 1_500, cgroup: { type: "none" } },
    ]);
  });

  it("prefers the unit cgroup the spawn site names without reading the pid", () => {
    const { registry } = harness({ 10: SELF });
    registry.registerRoot(threadRoot(10, { cgroup: MOVED }));
    expect(registry.roots()[0]?.cgroup).toEqual({ type: "adopted", cgroup: MOVED });
  });

  it("registers a cgroup-only root without a pid", () => {
    const { registry, reads } = harness();
    registry.registerRoot({ cgroup: MOVED, owner: { type: "t3", label: "machine terminal" } });
    expect(registry.roots()[0]?.cgroup).toEqual({ type: "adopted", cgroup: MOVED });
    expect(reads).toEqual([]);
  });

  it("re-reads a root sharing the server's cgroup until it moves, then stops", () => {
    const { registry, reads, move } = harness({ 10: SELF });
    registry.registerRoot(threadRoot(10));
    expect(registry.roots()[0]?.cgroup).toEqual({ type: "pending" });
    expect(reads).toEqual([10, 10]);

    move(10, MOVED);
    expect(registry.roots()[0]?.cgroup).toEqual({ type: "adopted", cgroup: MOVED });
    registry.roots();
    expect(reads).toEqual([10, 10, 10]);
  });

  it("adopts a moved cgroup only while the pid is the process it registered", () => {
    const ticks = new Map([
      [10, 500],
      [11, 600],
    ]);
    const { registry, move } = harness({ 10: SELF, 11: SELF }, ticks);
    registry.registerRoot(threadRoot(10));
    registry.registerRoot(threadRoot(11));
    expect(registry.roots().map((entry) => entry.cgroup.type)).toEqual(["pending", "pending"]);

    // Pid 11 exits and a stranger in its own scope reuses it.
    ticks.set(11, 900);
    move(10, MOVED);
    move(11, "/user.slice/stranger.scope");
    const [same, reused] = registry.roots();
    expect(same?.cgroup).toEqual({ type: "adopted", cgroup: MOVED });
    expect(reused?.cgroup).toEqual({ type: "none" });
    expect(reused?.root).not.toHaveProperty("pid");
  });

  it("does not re-read adopted or cgroup-less roots", () => {
    const { registry, reads } = harness({ 10: MOVED });
    registry.registerRoot(threadRoot(10));
    registry.registerRoot(threadRoot(11));
    registry.roots();
    registry.roots();
    expect(reads).toEqual([10, 11]);
  });

  it("unregisters only its own root, and twice is harmless", () => {
    const { registry } = harness();
    const first = registry.registerRoot(threadRoot(10));
    registry.registerRoot(threadRoot(11));
    first();
    first();
    expect(registry.roots().map((entry) => entry.root.pid)).toEqual([11]);
  });
});

describe("ProcessOwnershipRegistry", () => {
  it.effect("is a no-op unless the server provides one", () =>
    Effect.gen(function* () {
      const registry = yield* ProcessOwnershipRegistry;
      const unregister = registry.registerRoot(threadRoot(10));
      expect(registry.roots()).toEqual([]);
      unregister();
    }),
  );
});
