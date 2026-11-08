import { useAtomValue } from "@effect/atom-react";
import {
  formatAge,
  formatPercent,
  formatPerCore,
  machineVerdictText,
  type MachineIndicatorView,
  memoryUsedPercent,
} from "@t3tools/client-runtime/state/machineFormat";
import {
  EnvironmentId,
  type EnvironmentMachineKind,
  type MachineTotalsSummary,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import type { MachineCard, MachineCardSnapshot } from "@t3tools/shared/toolOutput";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode, useContext, useState } from "react";
import { Pressable, View } from "react-native";

import {
  ENVIRONMENT_MACHINE_SYMBOLS,
  EnvironmentMachineSymbol,
} from "../../components/EnvironmentMachineSymbol";
import { MachineResourcesSheet } from "../../components/machineResources/MachineResourcesSheet";
import { useMachineStressColor } from "../../components/machineResources/stressColor";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { machineIndicator, machineResources } from "../../state/machineResources";
import { environmentPresentations } from "../../state/presentation";
import { ThreadMediaVisibleContext } from "./ThreadMarkdownVideo";

const SYMBOL_SIZE = 16;

/**
 * The machine card an agent showed with `t3_machine_read { show: true }`. Live while on screen
 * in the current turn; otherwise the frozen snapshot from the tool call, with its age.
 */
export function InlineMachineCard(props: {
  readonly card: MachineCard;
  /** When the agent read the machine. */
  readonly capturedAt: string;
  /** In the current turn: goes live while on screen. */
  readonly current: boolean;
}) {
  const environmentId = EnvironmentId.make(props.card.environmentId);
  const presentation = useAtomValue(environmentPresentations.presentationAtom(environmentId));
  const visible = useContext(ThreadMediaVisibleContext);
  const [open, setOpen] = useState(false);
  const label = presentation?.entry.target.label ?? "Machine";
  const kind = resolveEnvironmentMachineKind(presentation?.serverConfig ?? null);
  const content =
    presentation === null ? (
      <SnapshotCard {...props} label={label} kind={kind} notice="Machine not connected" />
    ) : props.current && visible ? (
      <LiveCard environmentId={environmentId} label={label} kind={kind} />
    ) : (
      <SnapshotCard {...props} label={label} kind={kind} />
    );
  return (
    <View className="mb-3">
      {presentation === null ? (
        content
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label} machine resources`}
          className="active:opacity-60"
          onPress={() => setOpen(true)}
        >
          {content}
        </Pressable>
      )}
      {open ? (
        <MachineResourcesSheet
          environmentId={environmentId}
          title={label}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}

/** Mounted only while on screen: reads the verdict stream the app already keeps open. */
function LiveCard(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly kind: EnvironmentMachineKind;
}) {
  const indicator = useAtomValue(machineIndicator.machineIndicatorAtom(props.environmentId));
  const status = useAtomValue(machineResources.machine(props.environmentId));
  const totals = indicator.unreachable
    ? null
    : (Option.getOrNull(AsyncResult.value(status))?.totals ?? null);
  return (
    <CardFrame>
      <View className="flex-row items-center gap-2">
        <EnvironmentMachineSymbol
          environmentId={props.environmentId}
          kind={props.kind}
          size={SYMBOL_SIZE}
          tintColorClassName="text-foreground-muted"
        />
        <Text className="flex-1 text-sm font-t3-bold text-foreground" numberOfLines={1}>
          {props.label}
        </Text>
        <Text className="text-xs text-foreground-muted">Live</Text>
      </View>
      <VerdictText view={indicator} />
      {totals ? <KpiRow totals={totals} /> : null}
    </CardFrame>
  );
}

function SnapshotCard(props: {
  readonly card: MachineCard;
  readonly capturedAt: string;
  readonly label: string;
  readonly kind: EnvironmentMachineKind;
  readonly notice?: string;
}) {
  const { snapshot } = props.card;
  return (
    <CardFrame>
      <View className="flex-row items-center gap-2">
        <FrozenSymbol kind={props.kind} verdict={snapshot?.verdict ?? "unknown"} />
        <Text className="flex-1 text-sm font-t3-bold text-foreground" numberOfLines={1}>
          {props.label}
        </Text>
        <SnapshotAge capturedAt={props.capturedAt} />
      </View>
      {props.notice ? <Text className="text-sm text-foreground-muted">{props.notice}</Text> : null}
      {snapshot === undefined ? null : (
        <>
          <VerdictText view={frozenView(snapshot)} />
          {snapshot.totals ? <KpiRow totals={snapshot.totals} /> : null}
        </>
      )}
    </CardFrame>
  );
}

function CardFrame(props: { readonly children: ReactNode }) {
  return (
    <View className="gap-2 rounded-[20px] border border-border bg-card-alt p-4">
      {props.children}
    </View>
  );
}

function frozenView(snapshot: MachineCardSnapshot): MachineIndicatorView {
  return {
    verdict: snapshot.verdict,
    reason: snapshot.verdict === "stressed" ? snapshot.reason : null,
    unreachable: false,
    lastSeen: null,
  };
}

/** Quiet when fine: nothing while the machine is ok. */
function VerdictText(props: { readonly view: MachineIndicatorView }) {
  const text = machineVerdictText(props.view);
  if (text === null) return null;
  const stressed = !props.view.unreachable && props.view.verdict === "stressed";
  return (
    <Text
      className={cn("text-sm", stressed ? "text-danger-foreground" : "text-foreground-muted")}
      numberOfLines={2}
    >
      {text}
    </Text>
  );
}

function KpiRow(props: { readonly totals: MachineTotalsSummary }) {
  const { totals } = props;
  const kpis: ReadonlyArray<readonly [string, string]> = [
    ["CPU", totals.cpuUtilization === null ? "–" : formatPercent(totals.cpuUtilization * 100)],
    ["Load / core", totals.load ? formatPerCore(totals.load.five, totals.cpuCount) : "–"],
    [
      "Memory",
      // macOS counts cache as used, so pressure replaces the percent.
      totals.memoryPressure === null
        ? formatPercent(memoryUsedPercent(totals))
        : totals.memoryPressure,
    ],
  ];
  return (
    <View className="flex-row gap-3">
      {kpis.map(([title, value]) => (
        <View key={title} className="flex-1">
          <Text className="text-xs text-foreground-muted">{title}</Text>
          <Text className="text-sm font-t3-bold tabular-nums text-foreground">{value}</Text>
        </View>
      ))}
    </View>
  );
}

/** The verdict the card showed, drawn still: no halo animation or drip on a snapshot. */
function FrozenSymbol(props: {
  readonly kind: EnvironmentMachineKind;
  readonly verdict: MachineCardSnapshot["verdict"];
}) {
  const stressColor = useMachineStressColor();
  return (
    <View style={{ opacity: props.verdict === "unknown" ? 0.42 : 1 }}>
      <SymbolView
        name={ENVIRONMENT_MACHINE_SYMBOLS[props.kind]}
        size={SYMBOL_SIZE}
        type="monochrome"
        {...(props.verdict === "stressed"
          ? { tintColor: stressColor }
          : { tintColorClassName: "text-foreground-muted" })}
      />
    </View>
  );
}

const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

// Its own leaf, so the minute tick re-renders only the label.
function SnapshotAge(props: { readonly capturedAt: string }) {
  const now = useNowMinuteMs();
  const captured = Date.parse(props.capturedAt);
  return (
    <Text className="text-xs tabular-nums text-foreground-muted">
      {`as of ${timeFormatter.format(captured)} · ${formatAge(Math.max(0, now - captured))} ago`}
    </Text>
  );
}
