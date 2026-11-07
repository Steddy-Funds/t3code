import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { type ComponentProps, type KeyboardEvent, type ReactElement, useState } from "react";

import { machineIndicator } from "~/state/machineResources";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { MachineHoverCard } from "./MachineHoverCard";

/**
 * Opens the machine card on hover or click. The card, and its live streams, mount only while open.
 * Machines that don't serve the verdict get no card. Pass `label` when the child is not already
 * a focusable control: the trigger then becomes a tab stop named "<label> machine resources".
 */
export function MachineHoverTarget({
  environmentId,
  side,
  label,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly label?: string;
  readonly side?: ComponentProps<typeof PreviewCardPopup>["side"];
  readonly children: ReactElement;
}) {
  const { show } = useAtomValue(machineIndicator.machineIndicatorAtom(environmentId));
  const [open, setOpen] = useState(false);
  if (!show) return children;
  const openOnKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setOpen(true);
  };
  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger
        render={children}
        delay={350}
        closeDelay={120}
        onClick={() => setOpen(true)}
        onKeyDown={openOnKey}
        {...(label === undefined
          ? {}
          : { role: "button", tabIndex: 0, "aria-label": `${label} machine resources` })}
      />
      <PreviewCardPopup
        align="start"
        side={side ?? "top"}
        className="max-w-[calc(100vw-2rem)] overflow-hidden"
      >
        <MachineHoverCard environmentId={environmentId} />
      </PreviewCardPopup>
    </PreviewCard>
  );
}
