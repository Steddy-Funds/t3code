import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { type ComponentProps, type ReactElement, useState } from "react";

import { machineIndicator } from "~/state/machineResources";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { MachineHoverCard } from "./MachineHoverCard";

/**
 * Opens the machine card on hover or click. The card, and its live streams, mount only while open.
 * Machines that don't serve the verdict get no card.
 */
export function MachineHoverTarget({
  environmentId,
  side,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly side?: ComponentProps<typeof PreviewCardPopup>["side"];
  readonly children: ReactElement;
}) {
  const { show } = useAtomValue(machineIndicator.machineIndicatorAtom(environmentId));
  const [open, setOpen] = useState(false);
  if (!show) return children;
  return (
    <PreviewCard open={open} onOpenChange={setOpen}>
      <PreviewCardTrigger
        render={children}
        delay={350}
        closeDelay={120}
        onClick={() => setOpen(true)}
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
