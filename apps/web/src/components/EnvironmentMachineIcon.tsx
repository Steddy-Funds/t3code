import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { CloudIcon, LaptopIcon, MonitorIcon, ServerIcon, type LucideProps } from "lucide-react";
import type { FunctionComponent, SVGProps } from "react";

import { machineIndicator } from "~/state/machineResources";
import { LinuxIcon } from "./Icons";
import {
  type MachineIconSize,
  type MachineIconState,
  machineIconProps,
  machineIconState,
  MachineSweatOverlay,
} from "./nodeResources/MachineSweatOverlay";

function LucideLike(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}

function MacMiniIcon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <LucideLike {...props}>
      <rect width="18" height="12" x="3" y="6" rx="2.5" />
      <circle cx="7.5" cy="12" r="1" fill="currentColor" stroke="none" />
      {children}
    </LucideLike>
  );
}

function MacStudioIcon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <LucideLike {...props}>
      <rect width="18" height="14" x="3" y="5" rx="2" />
      <path d="M7 15h.01M11 15h.01M15 15h.01" />
      {children}
    </LucideLike>
  );
}

const ICON_BY_KIND: Record<EnvironmentMachineKind, FunctionComponent<LucideProps>> = {
  server: ServerIcon,
  cloud: CloudIcon,
  linux: LinuxIcon,
  desktop: MonitorIcon,
  laptop: LaptopIcon,
  "mac-mini": MacMiniIcon,
  "mac-studio": MacStudioIcon,
};

export const ENVIRONMENT_MACHINE_KIND_LABELS: Record<EnvironmentMachineKind, string> = {
  server: "Server",
  cloud: "Cloud VM",
  linux: "Linux/WSL",
  desktop: "Desktop",
  laptop: "Laptop",
  "mac-mini": "Mini PC",
  "mac-studio": "Workstation",
};

export function environmentMachineIcon(
  kind: EnvironmentMachineKind,
): FunctionComponent<LucideProps> {
  return ICON_BY_KIND[kind];
}

// The Linux glyph draws in a 28-unit box offset by -2; every other glyph fills 0..24.
const GLYPH_BOX: Partial<Record<EnvironmentMachineKind, { x: number; size: number }>> = {
  linux: { x: -2, size: 28 },
};

type EnvironmentMachineIconProps = LucideProps & {
  readonly kind: EnvironmentMachineKind;
  /** Draws the machine's verdict: dimmed while unknown, sweating while stressed. */
  readonly environmentId?: EnvironmentId | null | undefined;
};

export function EnvironmentMachineIcon({
  environmentId,
  kind,
  ...props
}: EnvironmentMachineIconProps) {
  if (environmentId == null) {
    const Icon = ICON_BY_KIND[kind];
    return <Icon {...props} />;
  }
  return <MachineVerdictIcon environmentId={environmentId} kind={kind} {...props} />;
}

/** The icon state for a machine; "ok" for machines that don't serve the verdict. */
export function useMachineIconState(environmentId: EnvironmentId): MachineIconState {
  const indicator = useAtomValue(machineIndicator.machineIndicatorAtom(environmentId));
  return indicator.show ? machineIconState(indicator) : "ok";
}

function MachineVerdictIcon({
  environmentId,
  kind,
  ...props
}: LucideProps & { readonly kind: EnvironmentMachineKind; readonly environmentId: EnvironmentId }) {
  const state = useMachineIconState(environmentId);
  const Icon = ICON_BY_KIND[kind];
  if (state === "ok") return <Icon {...props} />;
  const box = GLYPH_BOX[kind] ?? { x: 0, size: 24 };
  return (
    // Lucide stops hiding an icon that has children; the overlay is decoration either way.
    <Icon aria-hidden={props["aria-label"] === undefined} {...props} {...machineIconProps(state)}>
      <MachineSweatOverlay
        state={state}
        size={overlaySize(props.className)}
        glyph={<Icon x={box.x} y={box.x} width={box.size} height={box.size} />}
      />
    </Icon>
  );
}

// The drip runs shorter on the 12 px icon; the class names are the size the caller chose.
function overlaySize(className: string | undefined): MachineIconSize {
  if (className && /(^|\s)size-3(\s|$)/.test(className)) return 12;
  if (className && /(^|\s)size-[45](\s|$)/.test(className)) return 18;
  return 14;
}
