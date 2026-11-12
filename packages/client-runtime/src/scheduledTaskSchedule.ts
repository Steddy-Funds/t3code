// @effect-diagnostics globalDate:off - Formats schedule labels in the viewer's locale for React, outside an Effect runtime.
import {
  MAX_LOAD_SUSTAIN_SECONDS,
  type LoadCondition,
  type LoadMetric,
  type ScheduledTaskLoadSchedule,
  type ScheduledTaskSchedule,
} from "@t3tools/contracts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WEEKDAYS_MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function formatScheduledTaskInterval(everyMs: number): string {
  const units = [
    [7 * DAY, "week"],
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
    [1_000, "second"],
    [1, "millisecond"],
  ] as const;
  let remaining = everyMs;
  const parts: string[] = [];
  for (const [size, unit] of units) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    if (count === 1 && remaining === everyMs && remaining === size) return `Every ${unit}`;
    parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
    remaining %= size;
  }
  return `Every ${parts.join(" ")}`;
}

export function scheduledTaskWeekdaysLabel(weekdays: ReadonlyArray<number> | undefined): string {
  const days = new Set(weekdays ?? []);
  if (days.size === 0 || days.size === 7) return "Every day";
  if (days.size === 5 && [1, 2, 3, 4, 5].every((day) => days.has(day))) return "Weekdays";
  return WEEKDAYS_MONDAY_FIRST.filter((day) => days.has(day))
    .map((day) => WEEKDAY_LABELS[day])
    .join(", ");
}

function formatTimeOfDay(timeOfDay: string): string {
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return timeOfDay;
  const time = new Date(2000, 0, 1, hours, minutes);
  return time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatRunAt(runAt: string): string {
  const date = new Date(runAt);
  if (Number.isNaN(date.getTime())) return runAt;
  const day = date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${day} at ${time}`;
}

export const LOAD_METRICS: ReadonlyArray<{
  readonly metric: LoadMetric;
  readonly label: string;
  readonly unit: "" | "%";
}> = [
  { metric: "verdict", label: "Machine status", unit: "" },
  { metric: "loadPerCore", label: "Load per core", unit: "" },
  { metric: "cpuPercent", label: "CPU", unit: "%" },
  { metric: "memoryUsedPercent", label: "RAM used", unit: "%" },
  { metric: "swapUsedPercent", label: "Swap used", unit: "%" },
  { metric: "gpuUtilPercent", label: "GPU util", unit: "%" },
  { metric: "vramUsedPercent", label: "VRAM used", unit: "%" },
  { metric: "unbucketedSharePercent", label: "Unbucketed share", unit: "%" },
];

const LOAD_METRIC_SHORT_LABELS: Record<LoadMetric, string> = {
  verdict: "machine",
  loadPerCore: "load/core",
  cpuPercent: "CPU",
  memoryUsedPercent: "RAM",
  swapUsedPercent: "swap",
  gpuUtilPercent: "GPU util",
  vramUsedPercent: "VRAM",
  unbucketedSharePercent: "unbucketed share",
};

export function isGpuLoadMetric(metric: LoadMetric): boolean {
  return metric === "gpuUtilPercent" || metric === "vramUsedPercent";
}

/** Verdict is 1 while stressed and 0 while ok. */
export function loadVerdictState(condition: Pick<LoadCondition, "op" | "threshold">) {
  if (condition.op === ">=" && condition.threshold > 0 && condition.threshold <= 1)
    return "stressed";
  if (condition.op === "<=" && condition.threshold >= 0 && condition.threshold < 1) return "ok";
  return null;
}

function formatThreshold(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function formatSustain(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} s`;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

function loadConditionSummary(condition: LoadCondition): string {
  const sustain =
    condition.sustainSeconds > 0 ? ` for ${formatSustain(condition.sustainSeconds)}` : "";
  if (condition.metric === "verdict") {
    const state = loadVerdictState(condition);
    if (state !== null) return `machine ${state}${sustain}`;
  }
  const label = LOAD_METRIC_SHORT_LABELS[condition.metric];
  const subject =
    condition.gpuId !== undefined && isGpuLoadMetric(condition.metric)
      ? `GPU ${condition.gpuId} ${label}`
      : label;
  const unit = LOAD_METRICS.find((entry) => entry.metric === condition.metric)?.unit ?? "";
  const op = condition.op === ">=" ? "≥" : "≤";
  return `${subject} ${op} ${formatThreshold(condition.threshold)}${unit}${sustain}`;
}

export function scheduledTaskScheduleSummary(schedule: ScheduledTaskSchedule): string {
  switch (schedule.type) {
    case "webhook":
      return "On webhook";
    case "once":
      return `Once, ${formatRunAt(schedule.runAt)}`;
    case "interval":
      return formatScheduledTaskInterval(schedule.everyMs);
    case "fixed_time":
      return `${scheduledTaskWeekdaysLabel(schedule.weekdays)} at ${formatTimeOfDay(schedule.timeOfDay)}`;
    case "load":
      return schedule.clear === undefined
        ? `On load · ${loadConditionSummary(schedule.condition)}`
        : `On load · ${loadConditionSummary(schedule.condition)} · clears when ${loadConditionSummary(schedule.clear)}`;
  }
}

/** Form text for one condition; the editors parse it back with `loadScheduleFromDraft`. */
export interface LoadConditionDraft {
  readonly metric: LoadMetric;
  readonly op: LoadCondition["op"];
  readonly threshold: string;
  readonly sustainSeconds: string;
  /** Empty means the max over all GPUs. */
  readonly gpuId: string;
}

export interface LoadScheduleDraft {
  readonly condition: LoadConditionDraft;
  readonly clearEnabled: boolean;
  readonly clear: LoadConditionDraft;
}

const DEFAULT_LOAD_CONDITION_DRAFT: LoadConditionDraft = {
  metric: "verdict",
  op: "<=",
  threshold: "0",
  sustainSeconds: "60",
  gpuId: "",
};

export const DEFAULT_LOAD_SCHEDULE_DRAFT: LoadScheduleDraft = {
  condition: DEFAULT_LOAD_CONDITION_DRAFT,
  clearEnabled: false,
  clear: { ...DEFAULT_LOAD_CONDITION_DRAFT, op: ">=", threshold: "1", sustainSeconds: "0" },
};

/** The verdict picker edits op and threshold together. */
export function withLoadVerdictState(
  draft: LoadConditionDraft,
  state: "stressed" | "ok",
): LoadConditionDraft {
  return state === "stressed"
    ? { ...draft, op: ">=", threshold: "1" }
    : { ...draft, op: "<=", threshold: "0" };
}

export function withLoadMetric(draft: LoadConditionDraft, metric: LoadMetric): LoadConditionDraft {
  if (metric === draft.metric) return draft;
  const next = { ...draft, metric, gpuId: isGpuLoadMetric(metric) ? draft.gpuId : "" };
  if (metric === "verdict")
    return withLoadVerdictState(next, draft.op === ">=" ? "stressed" : "ok");
  return draft.metric === "verdict" ? { ...next, threshold: "" } : next;
}

function conditionDraft(condition: LoadCondition): LoadConditionDraft {
  return {
    metric: condition.metric,
    op: condition.op,
    threshold: String(condition.threshold),
    sustainSeconds: String(condition.sustainSeconds),
    gpuId: condition.gpuId ?? "",
  };
}

export function loadScheduleDraft(schedule: ScheduledTaskLoadSchedule): LoadScheduleDraft {
  return {
    condition: conditionDraft(schedule.condition),
    clearEnabled: schedule.clear !== undefined,
    clear:
      schedule.clear === undefined
        ? DEFAULT_LOAD_SCHEDULE_DRAFT.clear
        : conditionDraft(schedule.clear),
  };
}

function parseDecimal(value: string): number {
  const trimmed = value.trim().replace(",", ".");
  return trimmed === "" ? Number.NaN : Number(trimmed);
}

function conditionFromDraft(draft: LoadConditionDraft): LoadCondition | null {
  const threshold = parseDecimal(draft.threshold);
  const sustainSeconds = parseDecimal(draft.sustainSeconds);
  if (
    !Number.isFinite(threshold) ||
    !Number.isInteger(sustainSeconds) ||
    sustainSeconds < 0 ||
    sustainSeconds > MAX_LOAD_SUSTAIN_SECONDS
  )
    return null;
  const gpuId = isGpuLoadMetric(draft.metric) ? draft.gpuId.trim() : "";
  return {
    metric: draft.metric,
    op: draft.op,
    threshold,
    sustainSeconds,
    ...(gpuId ? { gpuId } : {}),
  };
}

export function loadScheduleFromDraft(draft: LoadScheduleDraft): ScheduledTaskLoadSchedule | null {
  const condition = conditionFromDraft(draft.condition);
  if (condition === null) return null;
  if (!draft.clearEnabled) return { type: "load", condition };
  const clear = conditionFromDraft(draft.clear);
  return clear === null ? null : { type: "load", condition, clear };
}

export const LOAD_SCHEDULE_DRAFT_ERROR = {
  title: "Invalid load condition",
  description: `Enter a number for each threshold and whole seconds from 0 to ${MAX_LOAD_SUSTAIN_SECONDS}.`,
} as const;
