import {
  DEFAULT_SNOOZE_REASONS,
  MAX_SHOWN_SNOOZE_REASONS,
  MAX_SNOOZE_REASONS,
  MIN_SHOWN_SNOOZE_REASONS,
  type SnoozeReasonSetting,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { PlusIcon, XIcon } from "lucide-react";

import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function SnoozeReasonPromptRow() {
  const enabled = useScopedSettings((settings) => settings.snoozeReasonPromptEnabled);
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("snooze-reason-prompt")}
      description="After each snooze, a small prompt asks why. Esc or a click outside skips it. Answers show in Snooze history."
      resetAction={
        enabled ? null : (
          <SettingResetButton
            label="snooze reason prompt"
            onClick={() => updateSettings({ snoozeReasonPromptEnabled: true })}
          />
        )
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) =>
            updateSettings({ snoozeReasonPromptEnabled: Boolean(checked) })
          }
          aria-label="Ask why after snoozing"
        />
      }
    />
  );
}

export function SnoozeReasonsRow() {
  const reasons = useScopedSettings((settings) => settings.snoozeReasons);
  const enabled = useScopedSettings((settings) => settings.snoozeReasonPromptEnabled);
  const updateSettings = useUpdateScopedSettings();
  const save = (snoozeReasons: ReadonlyArray<SnoozeReasonSetting>) =>
    updateSettings({ snoozeReasons });
  const shownCount = reasons.filter((reason) => reason.shown).length;
  const replace = (id: string, next: SnoozeReasonSetting) =>
    save(reasons.map((reason) => (reason.id === id ? next : reason)));

  if (!enabled) return null;
  return (
    <SettingsRow
      {...searchableSetting("snooze-reasons")}
      description={`The prompt offers ${MIN_SHOWN_SNOOZE_REASONS} to ${MAX_SHOWN_SNOOZE_REASONS} of these. "Other" also asks for a note.`}
      resetAction={
        Equal.equals(reasons, DEFAULT_SNOOZE_REASONS) ? null : (
          <SettingResetButton label="snooze reasons" onClick={() => save(DEFAULT_SNOOZE_REASONS)} />
        )
      }
    >
      <div className="flex flex-col gap-1.5 pt-3 pb-2">
        {reasons.map((reason) => (
          <div key={reason.id} className="flex items-center gap-2">
            <Input
              // Remounts when the saved label changes elsewhere, so the field never shows a stale draft.
              key={reason.label}
              size="sm"
              className="w-48"
              aria-label="Reason"
              defaultValue={reason.label}
              maxLength={40}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              onBlur={(event) => {
                const label = event.currentTarget.value.trim();
                if (!label) event.currentTarget.value = reason.label;
                else if (label !== reason.label) replace(reason.id, { ...reason, label });
              }}
            />
            <Switch
              checked={reason.shown}
              disabled={
                reason.shown
                  ? shownCount <= MIN_SHOWN_SNOOZE_REASONS
                  : shownCount >= MAX_SHOWN_SNOOZE_REASONS
              }
              onCheckedChange={(checked) => replace(reason.id, { ...reason, shown: checked })}
              aria-label={`Offer ${reason.label} in the prompt`}
            />
            <Button
              variant="ghost-muted"
              size="icon-sm"
              aria-label={`Remove ${reason.label}`}
              disabled={reason.shown && shownCount <= MIN_SHOWN_SNOOZE_REASONS}
              onClick={() => save(reasons.filter((candidate) => candidate.id !== reason.id))}
            >
              <XIcon />
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="ghost-muted"
            size="compact"
            disabled={reasons.length >= MAX_SNOOZE_REASONS}
            onClick={() =>
              save([
                ...reasons,
                {
                  // Snoozes keep the id they were given, so a new reason never reuses an old one.
                  id: `reason-${randomUUID()}`,
                  label: "New reason",
                  shown: shownCount < MAX_SHOWN_SNOOZE_REASONS,
                },
              ])
            }
          >
            <PlusIcon />
            Add reason
          </Button>
        </div>
      </div>
    </SettingsRow>
  );
}
