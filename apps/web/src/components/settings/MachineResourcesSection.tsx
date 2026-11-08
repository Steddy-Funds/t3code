import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import {
  AuthSettingsWriteScope,
  DEFAULT_MACHINE_THRESHOLDS,
  type EnvironmentId,
  type ExecutionEnvironmentPlatformOs,
  type MachineThresholds,
  MachineThresholdsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { SettingsIcon } from "lucide-react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { MachineBucketList } from "../nodeResources/buckets/MachineBucketList";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type ThresholdKey = keyof MachineThresholds;

interface ThresholdField {
  readonly key: ThresholdKey;
  readonly title: string;
  readonly description: string;
  readonly unit: "per core" | "%" | "s";
  /** Shown value = stored value × scale. */
  readonly scale: number;
  readonly boundsMessage: string;
  readonly appliesTo: (os: ExecutionEnvironmentPlatformOs) => boolean;
}

const isPatchValid = Schema.is(MachineThresholdsPatch);
const notWindows = (os: ExecutionEnvironmentPlatformOs) => os !== "windows";
const everywhere = () => true;
// The monitor reads NVIDIA and Intel GPUs on Linux and Windows only.
const hasGpuCollection = (os: ExecutionEnvironmentPlatformOs) => os !== "darwin";
const HOLD_BOUNDS = "Use 0 to 3600 seconds.";
const PERCENT_BOUNDS = "Use a percent above 0, up to 100.";

const THRESHOLD_FIELDS: ReadonlyArray<ThresholdField> = [
  {
    key: "loadPerCore",
    title: "Load per core",
    description: "5-minute load average ÷ logical cores. Stressed at or above.",
    unit: "per core",
    scale: 1,
    boundsMessage: "Use a number above 0.",
    appliesTo: notWindows,
  },
  {
    key: "windowsCpuPercent",
    title: "CPU used",
    description: "Windows has no load average, so CPU use replaces the load rule.",
    unit: "%",
    scale: 1,
    boundsMessage: PERCENT_BOUNDS,
    appliesTo: (os) => os === "windows",
  },
  {
    key: "windowsCpuHoldMs",
    title: "CPU hold",
    description: "How long CPU use must stay above its threshold.",
    unit: "s",
    scale: 1 / 1000,
    boundsMessage: HOLD_BOUNDS,
    appliesTo: (os) => os === "windows",
  },
  {
    key: "memoryUsedPercent",
    title: "RAM used",
    description: "(total − available) ÷ total. Stressed at or above.",
    unit: "%",
    scale: 1,
    boundsMessage: PERCENT_BOUNDS,
    appliesTo: (os) => os !== "darwin",
  },
  {
    key: "gpuVramUsedPercent",
    title: "GPU memory used",
    description: "VRAM used on an NVIDIA GPU. Stressed at or above.",
    unit: "%",
    scale: 1,
    boundsMessage: PERCENT_BOUNDS,
    appliesTo: hasGpuCollection,
  },
  {
    key: "gpuUtilPercent",
    title: "GPU busy",
    description: "Utilisation of any GPU. A suspended GPU is never woken to check.",
    unit: "%",
    scale: 1,
    boundsMessage: PERCENT_BOUNDS,
    appliesTo: hasGpuCollection,
  },
  {
    key: "gpuUtilHoldMs",
    title: "GPU busy hold",
    description: "How long a GPU must stay busy before the machine counts as stressed.",
    unit: "s",
    scale: 1 / 1000,
    boundsMessage: HOLD_BOUNDS,
    appliesTo: hasGpuCollection,
  },
  {
    key: "enterHoldMs",
    title: "Hold before stressed",
    description: "How long a rule must stay tripped before the machine counts as stressed.",
    unit: "s",
    scale: 1 / 1000,
    boundsMessage: HOLD_BOUNDS,
    appliesTo: everywhere,
  },
  {
    key: "exitFactor",
    title: "Clears below",
    description: "Share of each threshold the machine must drop under to clear.",
    unit: "%",
    scale: 100,
    boundsMessage: PERCENT_BOUNDS,
    appliesTo: everywhere,
  },
  {
    key: "exitHoldMs",
    title: "Hold before clearing",
    description: "How long the machine must stay under before it clears.",
    unit: "s",
    scale: 1 / 1000,
    boundsMessage: HOLD_BOUNDS,
    appliesTo: everywhere,
  },
];

const formatShown = (stored: number, scale: number) => String(Number((stored * scale).toFixed(3)));

function toStored(field: ThresholdField, shown: number): number {
  const stored = shown / field.scale;
  return field.unit === "s" ? Math.round(stored) : stored;
}

export function MachineSettingsToggle({
  label,
  open,
  onToggle,
}: {
  readonly label: string;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost-muted"
      size="icon-xs"
      aria-expanded={open}
      aria-label={`Machine settings for ${label}`}
      onClick={onToggle}
    >
      <SettingsIcon className="size-3.5" />
    </Button>
  );
}

/** Thresholds for one machine, saved to that machine's server settings. */
export function MachineResourcesSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  if (config?.environment.capabilities.machineResources !== true) return null;

  const os = config.environment.platform.os;
  const thresholds = config.settings.machineResources.thresholds;
  const fields = THRESHOLD_FIELDS.filter((field) => field.appliesTo(os));
  const changedKeys = fields
    .map((field) => field.key)
    .filter((key) => thresholds[key] !== DEFAULT_MACHINE_THRESHOLDS[key]);
  const saveThresholds = (patch: MachineThresholdsPatch, onFailed?: () => void) =>
    updateSettings(
      { machineResources: { thresholds: patch } },
      onFailed ? { onFailed } : undefined,
    );
  const resetKeys = (keys: ReadonlyArray<ThresholdKey>) =>
    saveThresholds(Object.fromEntries(keys.map((key) => [key, DEFAULT_MACHINE_THRESHOLDS[key]])));

  return (
    <div className="mt-2 border-t border-border/50 pt-2">
      <div className="flex items-center gap-2 px-3 sm:px-4">
        <h3 className="flex-1 text-sm font-semibold text-foreground">
          {searchableSetting("machine-stress-thresholds").title}
        </h3>
        {canWrite && changedKeys.length > 0 ? (
          <Button size="xs" variant="ghost" onClick={() => resetKeys(changedKeys)}>
            Reset to defaults
          </Button>
        ) : null}
      </div>
      {canWrite ? null : (
        <p className="px-3 pt-1 text-xs text-muted-foreground sm:px-4">
          This connection lacks permission to change settings on this machine.
        </p>
      )}
      {fields.map((field) => (
        <SettingsRow
          key={field.key}
          title={field.title}
          description={field.description}
          resetAction={
            canWrite && thresholds[field.key] !== DEFAULT_MACHINE_THRESHOLDS[field.key] ? (
              <SettingResetButton label={field.title} onClick={() => resetKeys([field.key])} />
            ) : null
          }
          control={
            <ThresholdInput
              field={field}
              stored={thresholds[field.key]}
              disabled={!canWrite}
              onCommit={(stored, onFailed) => saveThresholds({ [field.key]: stored }, onFailed)}
            />
          }
        />
      ))}
      {os === "darwin" ? (
        <SettingsRow
          title="Memory"
          description="macOS counts cache as used, so memory pressure reaching critical replaces the RAM rule."
        />
      ) : null}
      <div className="px-3 pt-2 sm:px-4">
        <MachineBucketList environmentId={environmentId} />
      </div>
    </div>
  );
}

function ThresholdInput({
  field,
  stored,
  disabled,
  onCommit,
}: {
  readonly field: ThresholdField;
  readonly stored: number;
  readonly disabled: boolean;
  readonly onCommit: (stored: number, onFailed: () => void) => void;
}) {
  const [draft, setDraft] = useState({
    saved: stored,
    text: formatShown(stored, field.scale),
    error: null as string | null,
  });
  if (draft.saved !== stored) {
    setDraft({ saved: stored, text: formatShown(stored, field.scale), error: null });
  }

  const commit = () => {
    const shown = draft.text.trim() === "" ? Number.NaN : Number(draft.text);
    const next = toStored(field, shown);
    if (!Number.isFinite(shown) || !isPatchValid({ [field.key]: next })) {
      setDraft((current) => ({ ...current, error: field.boundsMessage }));
      return;
    }
    setDraft((current) => ({ ...current, text: formatShown(next, field.scale), error: null }));
    if (next === stored) return;
    onCommit(next, () =>
      setDraft((current) => ({ ...current, text: formatShown(current.saved, field.scale) })),
    );
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <Input
          size="sm"
          font="mono"
          inputMode="decimal"
          className="w-20"
          aria-label={field.title}
          aria-invalid={draft.error !== null || undefined}
          disabled={disabled}
          value={draft.text}
          onChange={(event) => {
            const text = event.currentTarget.value;
            setDraft((current) => ({ ...current, text, error: null }));
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
        <span className="w-12 text-xs text-muted-foreground">{field.unit}</span>
      </div>
      {draft.error ? (
        <p role="alert" className="text-xs text-destructive">
          {draft.error}
        </p>
      ) : null}
    </div>
  );
}
