import { RegistryContext } from "@effect/atom-react";
import type { MachineHistory, MachineStatusSnapshot } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { act, render } from "../../../../test/render";
import type { MachineSeries } from "./machineSeries";
import { useMachineSeries } from "./useMachineSeries";

type SnapshotResult = AsyncResult.AsyncResult<MachineStatusSnapshot, unknown>;

const T = 10_000_000;
const GIB = 1024 ** 3;

const history = (count: number, cores = 2): MachineHistory => ({
  stepMs: 5_000,
  count,
  endAgeMs: 0,
  cpu: Array.from({ length: count }, () => 500),
  perCore: Array.from({ length: count * cores }, () => 100),
  cores,
  memoryUsed: Array.from({ length: count }, () => 250),
  swapUsed: Array.from({ length: count }, () => 0),
  load1: Array.from({ length: count }, () => 1),
  gpus: [],
});

const snapshot = ({
  history: seed,
  cores = 2,
}: { history?: MachineHistory; cores?: number } = {}): MachineStatusSnapshot => ({
  sequence: 1,
  verdict: "ok",
  verdictAgeMs: 0,
  reason: null,
  sampleAgeMs: 0,
  totals: {
    cpuUtilization: 0.5,
    cpuCount: cores,
    load: { one: 1, five: 1, fifteen: 1 },
    memoryTotalBytes: 16 * GIB,
    memoryAvailableBytes: 8 * GIB,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
    memoryPressure: null,
  },
  sample: { perCore: Array.from({ length: cores }, () => 10) },
  ...(seed ? { history: seed } : {}),
});

function Probe({
  source,
  tickMs,
  rangeMs,
  seen,
}: {
  readonly source: Atom.Atom<SnapshotResult>;
  readonly tickMs: number;
  readonly rangeMs: number;
  readonly seen: Array<MachineSeries | null>;
}) {
  seen.push(useMachineSeries(source, tickMs, rangeMs));
  return null;
}

async function renderSeries(tickMs = 1_000, rangeMs = 900_000) {
  const registry = AtomRegistry.make();
  const seen: Array<MachineSeries | null> = [];
  let source = Atom.make<SnapshotResult>(AsyncResult.initial());
  const tree = (tick: number, range: number) => (
    <RegistryContext value={registry}>
      <Probe source={source} tickMs={tick} rangeMs={range} seen={seen} />
    </RegistryContext>
  );
  // The hook reads no route.
  const screen = await render(tree(tickMs, rangeMs), { router: false });
  return {
    current: () => seen.at(-1) ?? null,
    distinct: () => [...new Set(seen.filter((series) => series !== null))],
    emit: (value: MachineStatusSnapshot, timestamp = T) =>
      act(() => registry.set(source, AsyncResult.success(value, { timestamp }))),
    /** A new stream for the new settings, as the view keys machine() by tick and range. */
    rekey: (tick: number, range: number) => {
      source = Atom.make<SnapshotResult>(AsyncResult.initial());
      return screen.rerender(tree(tick, range));
    },
    [Symbol.asyncDispose]: () => screen[Symbol.asyncDispose](),
  };
}

describe("useMachineSeries", () => {
  it("is null until the first snapshot, then seeds a series from its history", async () => {
    await using hook = await renderSeries();
    expect(hook.current()).toBeNull();

    await hook.emit(snapshot({ history: history(180) }));

    const series = hook.current();
    expect(series).toMatchObject({ tickMs: 1_000, rangeMs: 900_000 });
    expect(series?.cpu.capacity).toBe(900);
    expect(series?.cpu.length).toBe(896);
    expect(series?.cores.columns).toBe(2);

    await hook.emit(snapshot(), T + 1_000);
    expect(hook.current()).toBe(series);
    expect(series?.cpu.length).toBe(897);
  });

  it.each([
    ["the tick", 5_000, 900_000, 180, 180],
    ["the range at the same tick", 1_000, 3_600_000, 3_600, 3_596],
  ])(
    "builds a new series when %s changes, seeded from the next history",
    async (_name, tickMs, rangeMs, capacity, seeded) => {
      await using hook = await renderSeries();
      await hook.emit(snapshot({ history: history(180) }));
      const first = hook.current();

      await hook.rekey(tickMs, rangeMs);
      // Nothing new until the re-keyed stream answers.
      expect(hook.current()).toBe(first);
      await hook.emit(snapshot({ history: history(720) }));

      const next = hook.current();
      expect(next).not.toBe(first);
      expect(next).toMatchObject({ tickMs, rangeMs });
      expect(next?.cpu.capacity).toBe(capacity);
      expect(next?.cpu.length).toBe(seeded);
      expect(next?.cpu.timeAt(seeded - 1)).toBe(T);
      expect(next!.cpu.timeAt(1) - next!.cpu.timeAt(0)).toBe(tickMs);
    },
  );

  it("builds a new series when the core count changes", async () => {
    await using hook = await renderSeries();
    await hook.emit(snapshot());
    const first = hook.current();

    await hook.emit(snapshot({ cores: 4 }), T + 1_000);
    expect(hook.current()).not.toBe(first);
    expect(hook.current()?.cores.columns).toBe(4);
  });

  it("keeps the series and its points when the machine goes unreachable", async () => {
    await using hook = await renderSeries();
    await hook.emit(snapshot({ history: history(180) }));
    const series = hook.current();

    // An unreachable machine's source never produces a snapshot.
    await hook.rekey(1_000, 900_000);

    expect(hook.current()).toBe(series);
    expect(hook.distinct()).toEqual([series]);
    expect(series?.cpu.length).toBe(896);
  });
});
