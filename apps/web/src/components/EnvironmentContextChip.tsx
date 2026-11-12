import { type EnvironmentContextRecord, resolveEnvironmentMachineKind } from "@t3tools/contracts";

import { useEnvironment } from "~/state/environments";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { MachineHoverTarget } from "./nodeResources/MachineHoverTarget";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Inline chip for a mentioned machine, in the composer and in sent messages. Prefers the
 * name this client knows the machine by, and draws it with its machine icon.
 */
export function EnvironmentContextChip(props: {
  record: Pick<EnvironmentContextRecord, "environmentId" | "label">;
  copyMarkdown?: string;
}) {
  const environment = useEnvironment(props.record.environmentId);
  const label = environment?.label.trim() || props.record.label;
  const chip = (
    <ContextChip
      kind="environment"
      tabIndex={0}
      aria-label={`Machine, ${label}`}
      data-markdown-copy={props.copyMarkdown}
    >
      <EnvironmentMachineIcon
        kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
        environmentId={environment ? props.record.environmentId : null}
      />
      <ContextChipLabel>{label}</ContextChipLabel>
    </ContextChip>
  );
  if (!environment) {
    return (
      <Tooltip>
        <TooltipTrigger render={chip} />
        <TooltipPopup side="top">Machine not in this app</TooltipPopup>
      </Tooltip>
    );
  }
  // The chip sits in the composer and in sent messages; a click must not leave the draft.
  return (
    <MachineHoverTarget environmentId={props.record.environmentId} navigateOnClick={false}>
      {chip}
    </MachineHoverTarget>
  );
}
