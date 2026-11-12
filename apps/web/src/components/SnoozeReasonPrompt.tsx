import {
  MAX_SNOOZE_REASON_NOTE_LENGTH,
  SNOOZE_REASON_OTHER_ID,
  type SnoozeReasonSetting,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import {
  answerSnoozeReason,
  type SnoozeReasonAnchor,
  snoozeReasonAnswer,
  useSnoozeReasonPrompt,
} from "./SnoozeReasonPrompt.logic";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverPopup } from "./ui/popover";

export { requestSnoozeReason } from "./SnoozeReasonPrompt.logic";

/** Read before the snooze lands: a snoozed row can leave the list before the prompt opens. */
export function snoozeReasonAnchor(threadKey: string): SnoozeReasonAnchor | null {
  const row = document.querySelector(`[data-thread-item="${CSS.escape(threadKey)}"]`);
  const rect = row?.getBoundingClientRect();
  return rect && rect.height > 0
    ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    : null;
}

export function SnoozeReasonPromptHost() {
  const open = useSnoozeReasonPrompt((state) => state.open);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- settles a pending reason request as skipped when the host unmounts
  useEffect(() => () => answerSnoozeReason(null), []);
  return open ? (
    <SnoozeReasonPrompt key={open.openedAtMs} anchor={open.anchor} reasons={open.reasons} />
  ) : null;
}

function SnoozeReasonPrompt({
  anchor,
  reasons,
}: {
  anchor: SnoozeReasonAnchor | null;
  reasons: ReadonlyArray<SnoozeReasonSetting>;
}) {
  const [other, setOther] = useState<SnoozeReasonSetting | null>(null);
  const [note, setNote] = useState("");
  const [virtualAnchor] = useState(() => ({
    getBoundingClientRect: () =>
      anchor
        ? new DOMRect(anchor.x, anchor.y, anchor.width, anchor.height)
        : // By the sidebar footer, where the "Snoozed, Undo" notice shows.
          new DOMRect(12, window.innerHeight - 44, 0, 0),
  }));

  return (
    <Popover
      open
      onOpenChange={(open) => {
        // Dismissing after picking Other keeps Other and whatever note was typed.
        if (!open) answerSnoozeReason(other ? snoozeReasonAnswer(other, note) : null);
      }}
    >
      <PopoverPopup
        anchor={virtualAnchor}
        side={anchor ? "right" : "top"}
        align="start"
        padding="compact"
        width="sm"
        aria-labelledby="snooze-reason-title"
      >
        <p id="snooze-reason-title" className="mb-2 text-xs text-muted-foreground">
          {other ? "What's going on?" : "Why snooze?"}
        </p>
        {other ? (
          <form
            className="flex gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              answerSnoozeReason(snoozeReasonAnswer(other, note));
            }}
          >
            <Input
              autoFocus
              size="sm"
              aria-label="Note"
              placeholder="Optional note"
              maxLength={MAX_SNOOZE_REASON_NOTE_LENGTH}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
            <Button type="submit" size="sm">
              Save
            </Button>
          </form>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {reasons.map((reason) => (
              <Button
                key={reason.id}
                variant="outline"
                size="sm"
                onClick={() =>
                  reason.id === SNOOZE_REASON_OTHER_ID
                    ? setOther(reason)
                    : answerSnoozeReason(snoozeReasonAnswer(reason))
                }
              >
                {reason.label}
              </Button>
            ))}
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}
