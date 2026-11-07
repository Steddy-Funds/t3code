import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { SettingsIcon, TerminalIcon } from "lucide-react";

import { EnvironmentMachineIcon } from "~/components/EnvironmentMachineIcon";
import { Button } from "~/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { useEnvironmentMachines } from "~/state/environments";
import { machineIndicator } from "~/state/machineResources";

import { MachineVerdictLine } from "../MachineVerdictLine";
import { TASK_MANAGER_TICKS, type TaskManagerTick } from "../taskManagerPreferences";

const tickLabel = (tick: TaskManagerTick) => `${tick / 1000} s`;

/** Identity, verdict (nothing while ok), tick picker, Open terminal and the settings gear. */
export function TaskManagerHeader({
  environmentId,
  label,
  tick,
  onTickChange,
  onOpenTerminal,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly tick: TaskManagerTick;
  readonly onTickChange: (tick: TaskManagerTick) => void;
  /** Omitted while the terminal can't open here; the button is hidden. */
  readonly onOpenTerminal?: () => void;
}) {
  const view = useAtomValue(machineIndicator.machineIndicatorAtom(environmentId));
  const kind = useEnvironmentMachines().get(environmentId) ?? "server";
  return (
    <header className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-0 items-center gap-2">
        <EnvironmentMachineIcon
          kind={kind}
          environmentId={environmentId}
          className="size-4.5 shrink-0"
        />
        <h2 className="truncate text-base font-semibold">{label}</h2>
      </div>
      <MachineVerdictLine view={view} className="min-w-0 text-xs" />
      <div className="ms-auto flex shrink-0 items-center gap-2">
        <span className="text-xs text-muted-foreground" aria-hidden>
          Tick
        </span>
        <ToggleGroup
          aria-label="Tick"
          variant="segmented"
          value={[String(tick)]}
          onValueChange={(next) => {
            const picked = TASK_MANAGER_TICKS.find((value) => String(value) === next[0]);
            if (picked !== undefined) onTickChange(picked);
          }}
        >
          {TASK_MANAGER_TICKS.map((value) => (
            <ToggleGroupItem key={value} value={String(value)}>
              {tickLabel(value)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {onOpenTerminal ? (
          <Button variant="outline" size="xs" onClick={onOpenTerminal}>
            <TerminalIcon />
            Open terminal
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Machine settings"
          render={<Link to="/settings/connections" />}
        >
          <SettingsIcon />
        </Button>
      </div>
    </header>
  );
}
