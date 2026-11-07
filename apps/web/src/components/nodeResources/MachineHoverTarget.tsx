import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactElement,
  useRef,
  useState,
} from "react";

import { machineIndicator } from "~/state/machineResources";

import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { MachineHoverCard } from "./MachineHoverCard";

/**
 * Opens the machine card on hover; a click, Enter or Space opens the machine's task manager. The
 * card, and its live streams, mount only while open. Machines that don't serve the verdict get no
 * card. Pass `label` when the child is not already a focusable control: the trigger then becomes a
 * tab stop named "<label> machine resources".
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
  // Set by a navigating click or key until the pointer leaves or focus moves, so the hover delay
  // started before the click can't open the card over the task manager.
  const suppressedRef = useRef(false);
  const navigate = useNavigate();
  if (!show) return children;
  const openTaskManager = () => {
    suppressedRef.current = true;
    setOpen(false);
    void navigate({ to: "/machines/$environmentId", params: { environmentId } });
  };
  const openOnKey = (event: KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openTaskManager();
  };
  return (
    <PreviewCard
      open={open}
      onOpenChange={(next) => {
        if (next && suppressedRef.current) return;
        setOpen(next);
      }}
    >
      <PreviewCardTrigger
        render={children}
        delay={350}
        closeDelay={120}
        onClick={openTaskManager}
        onKeyDown={openOnKey}
        onPointerLeave={() => {
          suppressedRef.current = false;
        }}
        onBlur={() => {
          suppressedRef.current = false;
        }}
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
