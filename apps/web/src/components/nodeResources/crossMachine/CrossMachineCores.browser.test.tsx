import { RegistryContext } from "@effect/atom-react";
import type { MachineHistory, MachineStatusSnapshot } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../../test/render";
import { SeriesRing } from "../charts/SeriesRing";
import { CrossMachineCores } from "./CrossMachineCores";

type SnapshotResult = AsyncResult.AsyncResult<MachineStatusSnapshot, unknown>;

const T = 1_000_000;

// Two cores, three 5 s ticks ending at T: core 0 reads 10, 30, 50 and core 1 reads 20, 40, 60.
const HISTORY: MachineHistory = {
  stepMs: 5_000,
  count: 3,
  endAgeMs: 0,
  cpu: [150, 350, 550],
  perCore: [100, 200, 300, 400, 500, 600],
  cores: 2,
  memoryUsed: [0, 0, 0],
  swapUsed: [0, 0, 0],
  load1: [0, 0, 0],
  gpus: [],
};

const snapshot = (
  perCore: ReadonlyArray<number>,
  { history, sampleAgeMs = 0 }: { history?: MachineHistory; sampleAgeMs?: number } = {},
): MachineStatusSnapshot => ({
  sequence: 1,
  verdict: "ok",
  verdictAgeMs: 0,
  reason: null,
  sampleAgeMs,
  totals: null,
  sample: { perCore },
  ...(history ? { history } : {}),
});

const rows = (ring: SeriesRing) =>
  Array.from({ length: ring.length }, (_, index) => ({
    at: ring.timeAt(index) - T,
    cores: Array.from({ length: ring.columns }, (_, column) => ring.valueAt(column, index)),
  }));

async function renderCores(tickMs = 5_000) {
  const registry = AtomRegistry.make();
  const source = Atom.make<SnapshotResult>(AsyncResult.initial());
  const tree = (atom: Atom.Atom<SnapshotResult>, tick: number) => (
    <RegistryContext value={registry}>
      <CrossMachineCores source={atom} tickMs={tick} />
    </RegistryContext>
  );
  // The cores grid reads no route.
  const screen = await render(tree(source, tickMs), { router: false });
  const create = vi.spyOn(SeriesRing, "create");
  const rings = () => create.mock.results.map((result) => result.value as SeriesRing);
  return {
    screen,
    rings,
    emit: (value: MachineStatusSnapshot, timestamp: number, atom = source) =>
      act(() => registry.set(atom, AsyncResult.success(value, { timestamp }))),
    /** Re-keys the stream the way CrossMachineList does: a new source atom per tick. */
    rekey: async (tick: number) => {
      const next = Atom.make<SnapshotResult>(AsyncResult.initial());
      await screen.rerender(tree(next, tick));
      return next;
    },
    [Symbol.asyncDispose]: async () => {
      create.mockRestore();
      await screen[Symbol.asyncDispose]();
    },
  };
}

describe("CrossMachineCores", () => {
  it("draws nothing until a snapshot carries cores", async () => {
    await using cores = await renderCores();
    await cores.emit(snapshot([]), T);

    expect(cores.rings()).toEqual([]);
    expect(cores.screen.container.querySelector("canvas")).toBeNull();
  });

  it("seeds from the first snapshot's history, then pushes live samples", async () => {
    await using cores = await renderCores();
    await cores.emit(snapshot([50, 60], { history: HISTORY }), T);

    expect(cores.rings()).toHaveLength(1);
    const ring = cores.rings()[0]!;
    expect(ring.columns).toBe(2);
    expect(ring.capacity).toBe(60);
    // The live sample at T is the history's newest tick, so the push is dropped.
    expect(rows(ring)).toEqual([
      { at: -10_000, cores: [10, 20] },
      { at: -5_000, cores: [30, 40] },
      { at: 0, cores: [50, 60] },
    ]);

    await cores.emit(snapshot([70, 80]), T + 5_000);
    expect(rows(ring).at(-1)).toEqual({ at: 5_000, cores: [70, 80] });
    expect(ring.length).toBe(4);
    await expect.element(cores.screen.getByRole("img")).toBeInTheDocument();
  });

  it("drops a live sample at or before the seed's end", async () => {
    await using cores = await renderCores();
    // Sampled 2 s before T, inside the seeded span.
    await cores.emit(
      snapshot([99, 99], { history: { ...HISTORY, endAgeMs: 0 }, sampleAgeMs: 2_000 }),
      T,
    );

    expect(rows(cores.rings()[0]!).map((row) => row.at)).toEqual([-10_000, -5_000, 0]);
  });

  it("adds nothing for a heartbeat repeating the last sample time", async () => {
    await using cores = await renderCores();
    await cores.emit(snapshot([50, 60], { history: HISTORY }), T);
    await cores.emit(snapshot([70, 80]), T + 5_000);
    await cores.emit(snapshot([71, 81], { sampleAgeMs: 1_000 }), T + 6_000);

    const ring = cores.rings()[0]!;
    expect(ring.length).toBe(4);
    expect(rows(ring).at(-1)).toEqual({ at: 5_000, cores: [70, 80] });
  });

  it.each([
    [2_000, 150, [-10_000, -8_000, -6_000, -4_000, -2_000, 0], [10, 10, 10, 30, 30, 50]],
    [10_000, 30, [-10_000, 0], [10, 50]],
  ])(
    "makes a new ring at a %i ms tick, seeded on that tick",
    async (tickMs, capacity, times, core0) => {
      await using cores = await renderCores();
      await cores.emit(snapshot([50, 60], { history: HISTORY }), T);
      const first = cores.rings()[0]!;

      const source = await cores.rekey(tickMs);
      await cores.emit(snapshot([50, 60], { history: HISTORY }), T, source);

      expect(cores.rings()).toHaveLength(2);
      const ring = cores.rings()[1]!;
      expect(ring).not.toBe(first);
      expect(ring.capacity).toBe(capacity);
      expect(rows(ring).map((row) => row.at)).toEqual(times);
      expect(rows(ring).map((row) => row.cores[0])).toEqual(core0);

      await cores.emit(snapshot([70, 80]), T + tickMs, source);
      expect(rows(ring).at(-1)).toEqual({ at: tickMs, cores: [70, 80] });
    },
  );

  it("keeps the ring and its line when the row goes unreachable", async () => {
    await using cores = await renderCores();
    await cores.emit(snapshot([50, 60], { history: HISTORY }), T);
    await cores.emit(snapshot([70, 80]), T + 5_000);
    const ring = cores.rings()[0]!;

    // An unreachable row's source never produces a snapshot.
    await cores.rekey(5_000);

    expect(cores.rings()).toEqual([ring]);
    expect(rows(ring).at(-1)).toEqual({ at: 5_000, cores: [70, 80] });
    await expect.element(cores.screen.getByRole("img")).toBeInTheDocument();
  });
});
