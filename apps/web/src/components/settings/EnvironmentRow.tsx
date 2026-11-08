import {
  type ConnectionTarget,
  connectionRouteId,
  connectionRouteLabel,
  connectionRoutes,
} from "@t3tools/client-runtime/connection";
import type {
  DesktopSshEnvironmentTarget,
  EnvironmentId,
  EnvironmentMachineKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { EnvironmentPresentation } from "~/state/environments";
import { usePreparedConnection } from "~/state/session";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { MachineHoverTarget } from "../nodeResources/MachineHoverTarget";
import { useSettingsSearchTarget } from "./settingsLayout";

export function formatDesktopSshTarget(target: DesktopSshEnvironmentTarget): string {
  const authority = target.username ? `${target.username}@${target.hostname}` : target.hostname;
  return target.port ? `${authority}:${target.port}` : authority;
}

export function environmentTransportLabel(
  environment: EnvironmentPresentation,
  activeTarget: ConnectionTarget | null = null,
): string {
  const { entry } = environment;
  if (entry.target._tag === "PrimaryConnectionTarget") return "This machine";
  const routes = connectionRoutes(entry);
  if (routes.length > 1) {
    const active =
      activeTarget === null
        ? undefined
        : routes.find(
            (route) => connectionRouteId(route.target) === connectionRouteId(activeTarget),
          );
    return active === undefined
      ? connectionRouteLabel(routes[0]!)
      : `via ${connectionRouteLabel(active)}`;
  }
  if (environment.relayManaged) return "T3 Connect";
  if (isDesktopLocalConnectionTarget(entry.target)) return "WSL";
  if (
    entry.target._tag === "SshConnectionTarget" &&
    Option.isSome(entry.profile) &&
    entry.profile.value._tag === "SshConnectionProfile"
  ) {
    return `SSH ${formatDesktopSshTarget(entry.profile.value.target)}`;
  }
  return environment.displayUrl ?? "Remote link";
}

export function useEnvironmentTransportLabel(environment: EnvironmentPresentation): string {
  const prepared = usePreparedConnection(environment.environmentId);
  return environmentTransportLabel(
    environment,
    environment.connection.phase === "connected" && prepared._tag === "Some"
      ? prepared.value.target
      : null,
  );
}

export function EnvironmentTransportLabel(props: {
  readonly environment: EnvironmentPresentation;
}) {
  return useEnvironmentTransportLabel(props.environment);
}

export function EnvironmentRow({
  kind,
  environmentId,
  machineCard = false,
  label,
  subtitle,
  below,
  detail,
  dimmed = false,
  className,
  settingsTargetId,
  children,
}: {
  readonly kind: EnvironmentMachineKind;
  /** Draws the machine's verdict on the icon. */
  readonly environmentId?: EnvironmentId | undefined;
  /** Opens the machine card from the icon. */
  readonly machineCard?: boolean;
  readonly label: string;
  readonly subtitle: ReactNode;
  readonly below?: ReactNode;
  readonly detail?: ReactNode;
  readonly dimmed?: boolean;
  readonly className?: string;
  /** Lets a settings link (`#id`) scroll to and highlight this row. */
  readonly settingsTargetId?: string;
  readonly children?: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(settingsTargetId);
  const icon = (
    <EnvironmentMachineIcon
      aria-hidden
      kind={kind}
      environmentId={environmentId}
      className={cn("size-4 text-muted-foreground", dimmed && "opacity-60")}
    />
  );
  return (
    <div
      id={settingsTargetId}
      ref={targetRef}
      tabIndex={settingsTargetId === undefined ? undefined : -1}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-2.5 sm:px-4",
        className,
      )}
    >
      {/* Dim only identity so switched-off controls remain readable and distinct from disabled controls. */}
      {machineCard && environmentId ? (
        <MachineHoverTarget environmentId={environmentId} label={label}>
          <span className="inline-flex">{icon}</span>
        </MachineHoverTarget>
      ) : (
        icon
      )}
      <div className={cn("min-w-0", dimmed && "opacity-60")}>
        <p className="truncate text-sm font-medium text-foreground">{label}</p>
        <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
        {below}
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
      {detail ? <div className="col-span-2 col-start-2 min-w-0">{detail}</div> : null}
    </div>
  );
}
