import {
  type MachineIndicatorView,
  machineVerdictText,
} from "@t3tools/client-runtime/state/machineFormat";

import { cn } from "~/lib/utils";

/** One line of verdict text; renders nothing while the machine is ok. */
export function MachineVerdictLine({
  view,
  className,
}: {
  readonly view: MachineIndicatorView;
  readonly className?: string;
}) {
  const text = machineVerdictText(view);
  if (text === null) return null;
  const stressed = !view.unreachable && view.verdict === "stressed";
  return (
    <span
      className={cn(
        "truncate",
        stressed ? "text-error-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {text}
    </span>
  );
}
