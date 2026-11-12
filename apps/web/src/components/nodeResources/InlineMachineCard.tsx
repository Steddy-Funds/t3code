import { formatAge, type MachineIndicatorView } from "@t3tools/client-runtime/state/machineFormat";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import type { MachineCardSnapshot } from "@t3tools/shared/toolOutput";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { observeIntersection } from "~/lib/observeIntersection";
import { cn } from "~/lib/utils";
import { useEnvironment } from "~/state/environments";
import { formatShortTimestamp } from "~/timestampFormat";
import type { TimestampFormat } from "@t3tools/contracts/settings";

import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import { MachineCardBody } from "./MachineCardBody";
import { MachineHoverCard } from "./MachineHoverCard";
import { machineIconProps } from "./MachineSweatOverlay";

export interface InlineMachineCardProps {
  readonly environmentId: EnvironmentId;
  readonly snapshot: MachineCardSnapshot | undefined;
  /** When the agent read the machine. */
  readonly capturedAt: string;
  readonly timestampFormat: TimestampFormat;
  /** In the current turn: goes live while on screen. */
  readonly current: boolean;
  /** A guest of a shared thread reaches no machine, so the card stays a snapshot. */
  readonly guest: boolean;
}

/** The machine card an agent showed with `t3_machine_read { show: true }`. */
export function InlineMachineCard(props: InlineMachineCardProps) {
  return (
    <div className="w-[372px] max-w-full overflow-hidden rounded-lg border border-border bg-card">
      {props.guest ? (
        <SnapshotCard {...props} label={null} kind={resolveEnvironmentMachineKind(null)} />
      ) : (
        <OwnedMachineCard {...props} />
      )}
    </div>
  );
}

function OwnedMachineCard(props: InlineMachineCardProps) {
  const environment = useEnvironment(props.environmentId);
  const [onScreen, setOnScreen] = useState(false);
  const { current } = props;
  const observe = (element: HTMLDivElement) =>
    current
      ? observeIntersection(element, (entry) => setOnScreen(entry.isIntersecting))
      : undefined;
  if (environment === null) {
    return (
      <SnapshotCard
        {...props}
        label={null}
        kind={resolveEnvironmentMachineKind(null)}
        notice="Machine not connected"
      />
    );
  }
  const live = current && onScreen;
  return (
    <div ref={observe}>
      {live ? (
        <MachineHoverCard environmentId={props.environmentId} />
      ) : (
        <SnapshotCard
          {...props}
          label={environment.label}
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
        />
      )}
      <div className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-2xs">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {live ? "Live" : null}
        </span>
        <Button
          variant="ghost"
          size="micro"
          render={
            <Link to="/machines/$environmentId" params={{ environmentId: props.environmentId }} />
          }
        >
          Task manager
          <ArrowRightIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function SnapshotCard(
  props: InlineMachineCardProps & {
    readonly label: string | null;
    readonly kind: EnvironmentMachineKind;
    readonly notice?: string;
  },
) {
  const { snapshot } = props;
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 border-b border-border px-3 py-2.5 text-xs">
        <FrozenMachineIcon kind={props.kind} verdict={snapshot?.verdict ?? "unknown"} />
        <span className="min-w-0 truncate font-semibold text-foreground">
          {props.label ?? "Machine"}
        </span>
        <SnapshotAge capturedAt={props.capturedAt} timestampFormat={props.timestampFormat} />
      </div>
      {props.notice ? (
        <div className="border-b border-border px-3 py-2.5 text-xs text-muted-foreground">
          {props.notice}
        </div>
      ) : null}
      {snapshot === undefined ? null : (
        <MachineCardBody view={frozenView(snapshot)} snapshot={{ totals: snapshot.totals }} />
      )}
    </>
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

/** The verdict the card showed, drawn still: no pulse or drip on a snapshot. */
function FrozenMachineIcon({
  kind,
  verdict,
}: {
  readonly kind: EnvironmentMachineKind;
  readonly verdict: MachineCardSnapshot["verdict"];
}) {
  return (
    <EnvironmentMachineIcon
      kind={kind}
      aria-hidden
      className={cn(
        "size-4 shrink-0",
        verdict === "stressed" ? "text-(--machine-stress)" : "text-muted-foreground",
      )}
      {...(verdict === "unknown" ? machineIconProps("unknown") : {})}
    />
  );
}

// Its own leaf, so the minute tick re-renders only the label.
function SnapshotAge({
  capturedAt,
  timestampFormat,
}: {
  readonly capturedAt: string;
  readonly timestampFormat: TimestampFormat;
}) {
  // The tick is a UTC minute without its zone.
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const age = Math.max(0, now - Date.parse(capturedAt));
  return (
    <span className="ms-auto shrink-0 text-2xs text-muted-foreground tabular-nums">
      as of {formatShortTimestamp(capturedAt, timestampFormat)} · {formatAge(age)} ago
    </span>
  );
}
