import { useAtomValue } from "@effect/atom-react";
import {
  formatGiB,
  formatPercent,
  formatPerCore,
  formatProcessMemory,
  machineVerdictText,
  memoryUsedBytes,
  memoryUsedPercent,
  topProcessesByName,
} from "@t3tools/client-runtime/state/machineFormat";
import type { MachineIndicator } from "@t3tools/client-runtime/state/machineIndicator";
import type { MachineProcessTable } from "@t3tools/client-runtime/state/machineProcessFrames";
import type {
  EnvironmentId,
  MachineStatusSnapshot,
  MachineTotalsSummary,
  MachineVerdictRule,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { Platform, ScrollView, View } from "react-native";

import { cn } from "../../lib/cn";
import { machineIndicator, machineResources } from "../../state/machineResources";
import { AppActivityIndicator } from "../ui/AppActivityIndicator";
import { AppText as Text } from "../ui/AppText";
import { Sheet } from "../ui/Sheet";

const LIVE_SAMPLE_MS = 1000;
const PROCESS_SAMPLE_MS = 2000;
const PROCESS_TOP = 5;
const TOP_ROWS = 3;

/** The hover card's content at phone size. Mount it only while open: it holds the live subscriptions. */
export function MachineResourcesSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const indicator = useAtomValue(machineIndicator.machineIndicatorAtom(props.environmentId));
  return (
    <Sheet title={props.title} onClose={props.onClose}>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: 24,
          gap: 16,
        }}
      >
        <VerdictLine indicator={indicator} />
        {/* An unreachable machine has nothing live to show; the verdict line says when it was seen. */}
        {indicator.unreachable ? null : (
          <LiveMachine environmentId={props.environmentId} indicator={indicator} />
        )}
      </ScrollView>
    </Sheet>
  );
}

function VerdictLine(props: { readonly indicator: MachineIndicator }) {
  const text = machineVerdictText(props.indicator);
  if (text === null) return null;
  const stressed = !props.indicator.unreachable && props.indicator.verdict === "stressed";
  return (
    <Text className={cn("text-sm", stressed ? "text-danger-foreground" : "text-foreground-muted")}>
      {text}
    </Text>
  );
}

function LiveMachine(props: {
  readonly environmentId: EnvironmentId;
  readonly indicator: MachineIndicator;
}) {
  const live = useAtomValue(
    machineResources.machine(props.environmentId, { intervalMs: LIVE_SAMPLE_MS }),
  );
  // Already open for the app's life (startMachineStatus), so its cached totals show at once.
  const status = useAtomValue(machineResources.machine(props.environmentId));
  const processes = useAtomValue(
    machineResources.machineProcesses(props.environmentId, {
      intervalMs: PROCESS_SAMPLE_MS,
      top: PROCESS_TOP,
    }),
  );
  const snapshot: MachineStatusSnapshot | null =
    Option.getOrNull(AsyncResult.value(live)) ?? Option.getOrNull(AsyncResult.value(status));
  const totals = snapshot?.totals ?? null;
  const rule = props.indicator.reason?.rule ?? null;
  return (
    <>
      {snapshot === null ? (
        <AppActivityIndicator />
      ) : totals ? (
        <>
          <CpuSection totals={totals} perCore={snapshot.sample?.perCore} rule={rule} />
          <MemorySection totals={totals} rule={rule} />
        </>
      ) : null}
      <ProcessesSection result={processes} />
    </>
  );
}

function SectionTitle(props: { readonly title: string; readonly value?: ReactNode }) {
  return (
    <View className="flex-row items-baseline gap-2">
      <Text className="flex-1 text-sm font-t3-medium text-foreground-muted">{props.title}</Text>
      {props.value === undefined ? null : props.value}
    </View>
  );
}

function trippedClassName(tripped: boolean): string {
  return tripped ? "text-danger-foreground" : "text-foreground";
}

function CpuSection(props: {
  readonly totals: MachineTotalsSummary;
  readonly perCore: ReadonlyArray<number> | undefined;
  readonly rule: MachineVerdictRule | null;
}) {
  const { totals } = props;
  const load = totals.load;
  const loadClassName = trippedClassName(props.rule === "load");
  return (
    <View className="gap-1.5">
      <SectionTitle
        title="CPU"
        value={
          totals.cpuUtilization === null ? undefined : (
            <Text className={cn("text-sm tabular-nums", trippedClassName(props.rule === "cpu"))}>
              {formatPercent(totals.cpuUtilization * 100)}
            </Text>
          )
        }
      />
      {load ? (
        <View className="flex-row items-baseline gap-2">
          <Text className="text-sm text-foreground-muted">Load / core</Text>
          <Text className={cn("text-sm tabular-nums", loadClassName)}>
            {formatPerCore(load.one, totals.cpuCount)}
          </Text>
          <Text className={cn("text-sm font-t3-bold tabular-nums", loadClassName)}>
            {formatPerCore(load.five, totals.cpuCount)}
          </Text>
          <Text className="text-sm tabular-nums text-foreground">
            {formatPerCore(load.fifteen, totals.cpuCount)}
          </Text>
          <Text className="flex-1 text-right text-xs text-foreground-muted" numberOfLines={1}>
            {`${totals.cpuCount} cores`}
          </Text>
        </View>
      ) : null}
      {props.perCore && props.perCore.length > 0 ? <PerCoreStrip values={props.perCore} /> : null}
    </View>
  );
}

function PerCoreStrip(props: { readonly values: ReadonlyArray<number> }) {
  return (
    <View className="h-3.5 flex-row gap-px">
      {props.values.map((percent, index) => (
        <View
          // oxlint-disable-next-line react/no-array-index-key -- the index is the core number
          key={index}
          className="flex-1 overflow-hidden rounded-sm bg-card-alt"
        >
          <View
            className="flex-1 bg-primary"
            style={{ opacity: Math.max(5, Math.round(percent)) / 100 }}
          />
        </View>
      ))}
    </View>
  );
}

function MemorySection(props: {
  readonly totals: MachineTotalsSummary;
  readonly rule: MachineVerdictRule | null;
}) {
  const { totals } = props;
  const tripped = props.rule === "memory" || props.rule === "memoryPressure";
  const used = `${formatGiB(memoryUsedBytes(totals))} / ${formatGiB(totals.memoryTotalBytes)} GiB`;
  // macOS counts cache as used, so pressure replaces the percent.
  const usesPressure = totals.memoryPressure !== null;
  const usedPercent = memoryUsedPercent(totals);
  const pressure =
    totals.memoryPressure === "warn" || totals.memoryPressure === "critical"
      ? `Pressure ${totals.memoryPressure}`
      : null;
  return (
    <View className="gap-1.5">
      <SectionTitle
        title="Memory"
        value={
          <Text className="text-sm tabular-nums text-foreground">
            {usesPressure ? used : `${used} · ${formatPercent(usedPercent)}`}
          </Text>
        }
      />
      <View className="h-1.5 flex-row overflow-hidden rounded-full bg-card-alt">
        <View
          className={tripped ? "bg-danger-foreground" : "bg-primary"}
          style={{ width: `${Math.min(100, usedPercent)}%` }}
        />
      </View>
      <View className="flex-row gap-2">
        <Text className="text-xs text-foreground-muted">
          {`${formatGiB(totals.memoryAvailableBytes)} GiB available`}
        </Text>
        {pressure ? (
          <Text
            className={cn("text-xs", tripped ? "text-danger-foreground" : "text-foreground-muted")}
          >
            {pressure}
          </Text>
        ) : null}
        {totals.swapTotalBytes > 0 ? (
          <Text className="flex-1 text-right text-xs tabular-nums text-foreground-muted">
            {`Swap ${formatGiB(totals.swapUsedBytes)} / ${formatGiB(totals.swapTotalBytes)} GiB`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function ProcessesSection(props: {
  readonly result: AsyncResult.AsyncResult<MachineProcessTable, unknown>;
}) {
  if (AsyncResult.isFailure(props.result)) {
    const needsScope = Predicate.isTagged(
      Cause.squash(props.result.cause),
      "EnvironmentAuthorizationError",
    );
    return (
      <Text className="text-sm text-foreground-muted">
        {needsScope ? "Process list needs diagnostics access" : "Process list unavailable"}
      </Text>
    );
  }
  const table = Option.getOrNull(AsyncResult.value(props.result));
  if (table === null) return null;
  // The T3 subtree always holds the server itself, so an empty table means no monitor.
  if (table.rows.length === 0) {
    return (
      <Text className="text-sm text-foreground-muted">Process list needs the resource monitor</Text>
    );
  }
  const scope = table.source === "t3" ? " · T3" : "";
  return (
    <>
      <TopList
        title={`Top by CPU${scope}`}
        rows={topProcessesByName(table.rows, "cpu", TOP_ROWS).map((top) => ({
          top,
          value: formatPercent(top.value),
        }))}
      />
      <TopList
        title={`Top by memory${scope}`}
        rows={topProcessesByName(table.rows, "rss", TOP_ROWS).map((top) => ({
          top,
          value: formatProcessMemory(top.value),
        }))}
      />
    </>
  );
}

function TopList(props: {
  readonly title: string;
  readonly rows: ReadonlyArray<{
    readonly top: { readonly name: string; readonly count: number };
    readonly value: string;
  }>;
}) {
  return (
    <View className="gap-1">
      <SectionTitle title={props.title} />
      {props.rows.map(({ top, value }) => (
        <View key={top.name} className="flex-row items-baseline gap-2">
          <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
            {top.count > 1 ? `${top.name} ×${top.count}` : top.name}
          </Text>
          <Text className="text-sm tabular-nums text-foreground">{value}</Text>
        </View>
      ))}
    </View>
  );
}
