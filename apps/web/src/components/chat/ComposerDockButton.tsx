import { FoldVerticalIcon, UnfoldVerticalIcon } from "lucide-react";

import { formatShortcutLabel } from "../../keybindings";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DOCK_SHORTCUT = {
  key: "enter",
  modKey: true,
  shiftKey: true,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
};

export function ComposerDockButton(props: { docked: boolean; onToggle: () => void }) {
  const label = props.docked ? "Return composer to the bottom" : "Open full-height composer";
  const shortcut = formatShortcutLabel(DOCK_SHORTCUT);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-pressed={props.docked}
            onPointerDown={(event) => event.preventDefault()}
            onClick={props.onToggle}
          />
        }
      >
        {props.docked ? <FoldVerticalIcon /> : <UnfoldVerticalIcon />}
      </TooltipTrigger>
      <TooltipPopup>
        {props.docked ? `${label} · ${shortcut} sends` : `${label} · ${shortcut}`}
      </TooltipPopup>
    </Tooltip>
  );
}
