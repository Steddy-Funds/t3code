import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { Fragment, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import { machineIndicator } from "~/state/machineResources";

import { capableMachinesAtom } from "../capableMachines";
import { documentVisibleAtom } from "../documentVisible";
import {
  CROSS_MACHINE_GRID,
  CrossMachineRow,
  crossMachineSnapshotAtom,
  type TopConsumerBy,
} from "./CrossMachineRow";
import {
  CROSS_MACHINE_GROUPS,
  type CrossMachineGroup,
  crossMachineGroup,
  loadPerCore,
  orderCrossMachines,
} from "./crossMachineModel";

const TICKS = [2000, 5000, 10_000] as const;
const DEFAULT_TICK_MS = 5000;
const TOP_BY = [
  { value: "thread", label: "Thread" },
  { value: "bucket", label: "Bucket" },
  { value: "process", label: "Process" },
] as const satisfies ReadonlyArray<{ value: TopConsumerBy; label: string }>;

const GROUP_LABELS: Record<CrossMachineGroup, string> = {
  stressed: "Stressed",
  lastSeenStressed: "Unreachable · last seen stressed",
  byLoad: "By load",
  unknown: "Unknown",
};

interface OrderedMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly group: CrossMachineGroup;
  readonly unreachable: boolean;
}

const sameOrder = (a: ReadonlyArray<OrderedMachine>, b: ReadonlyArray<OrderedMachine>) =>
  a.length === b.length &&
  a.every(
    (machine, index) =>
      machine.environmentId === b[index]?.environmentId &&
      machine.label === b[index]?.label &&
      machine.group === b[index]?.group &&
      machine.unreachable === b[index]?.unreachable,
  );

// Reads the same per-machine streams the rows do, so ordering by load opens nothing extra.
const orderedMachinesAtom = Atom.family((tickMs: number) =>
  Atom.make((get): ReadonlyArray<OrderedMachine> => {
    const visible = get(documentVisibleAtom);
    const entries = get(capableMachinesAtom).map((identity) => {
      const view = get(machineIndicator.machineIndicatorAtom(identity.environmentId));
      const snapshot = Option.getOrNull(
        AsyncResult.value(
          get(crossMachineSnapshotAtom(identity.environmentId, view, tickMs, visible)),
        ),
      );
      return {
        item: { ...identity, unreachable: view.unreachable },
        group: crossMachineGroup(view),
        load: loadPerCore(snapshot?.totals ?? null),
      };
    });
    return orderCrossMachines(entries).map((entry) => ({ ...entry.item, group: entry.group }));
  }).pipe(Atom.withEquality(sameOrder), Atom.withLabel(`web-cross-machine-order:${tickMs}`)),
);

/** Every machine that reports resources, one dense row each, worst first. */
export function CrossMachineList() {
  const [tickMs, setTickMs] = useState(DEFAULT_TICK_MS);
  const [topBy, setTopBy] = useState<TopConsumerBy>("thread");
  const machines = useAtomValue(orderedMachinesAtom(tickMs));
  const stressed = machines.filter((machine) => machine.group === "stressed").length;
  const unreachable = machines.filter((machine) => machine.unreachable).length;
  const unknown = machines.filter(
    (machine) => machine.group === "unknown" && !machine.unreachable,
  ).length;
  return (
    <section className="flex min-w-0 flex-col rounded-xl border bg-card">
      <header className="flex min-w-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-semibold">All machines</h2>
        {stressed > 0 ? <Badge variant="error">{stressed} stressed</Badge> : null}
        {unreachable > 0 ? <Badge variant="outline">{unreachable} unreachable</Badge> : null}
        {unknown > 0 ? <Badge variant="outline">{unknown} unknown</Badge> : null}
        <span className="ms-auto text-xs text-muted-foreground">Top consumer by</span>
        <ToggleGroup
          aria-label="Top consumer by"
          variant="segmented"
          value={[topBy]}
          onValueChange={(next) => {
            const option = TOP_BY.find((value) => value.value === next[0]);
            if (option !== undefined) setTopBy(option.value);
          }}
        >
          {TOP_BY.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="text-xs text-muted-foreground">Tick</span>
        <ToggleGroup
          aria-label="Tick"
          variant="segmented"
          value={[String(tickMs)]}
          onValueChange={(next) => {
            const tick = TICKS.find((value) => String(value) === next[0]);
            if (tick !== undefined) setTickMs(tick);
          }}
        >
          {TICKS.map((tick) => (
            <ToggleGroupItem key={tick} value={String(tick)}>
              {tick / 1000} s
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </header>
      <div className="overflow-x-auto">
        <ul className="flex min-w-[934px] flex-col">
          <li
            aria-hidden
            className={cn(
              CROSS_MACHINE_GRID,
              "border-b px-3 py-1.5 text-2xs font-medium text-muted-foreground",
            )}
          >
            <span />
            <span>Machine</span>
            <span>Verdict</span>
            <span>Cores · 5 m</span>
            <span>Memory</span>
            <span>VRAM</span>
            <span>Top consumer</span>
            <span className="text-end">Threads</span>
          </li>
          {CROSS_MACHINE_GROUPS.map((group) => {
            const members = machines.filter((machine) => machine.group === group);
            if (members.length === 0) return null;
            return (
              <Fragment key={group}>
                <li className="px-3 pt-3 pb-1 text-2xs font-semibold text-muted-foreground">
                  {GROUP_LABELS[group]} · {members.length}
                </li>
                {members.map((machine) => (
                  <CrossMachineRow
                    key={machine.environmentId}
                    environmentId={machine.environmentId}
                    label={machine.label}
                    tickMs={tickMs}
                    topBy={topBy}
                  />
                ))}
              </Fragment>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
