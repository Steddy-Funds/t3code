import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt } from "./baseSchemas.ts";

export const GpuVendor = Schema.Literals(["nvidia", "intel"]);
export type GpuVendor = typeof GpuVendor.Type;

export const GpuStatus = Schema.Literals(["active", "suspended", "unavailable"]);
export type GpuStatus = typeof GpuStatus.Type;

export const GpuDeviceSample = Schema.Struct({
  id: Schema.String,
  vendor: GpuVendor,
  name: Schema.String,
  /** A suspended device is never woken to be measured. */
  status: GpuStatus,
  utilPercent: Schema.NullOr(Schema.Number),
  vramTotalBytes: Schema.NullOr(NonNegativeInt),
  vramUsedBytes: Schema.NullOr(NonNegativeInt),
  /** Integrated GPUs use system RAM, so VRAM fields describe a share of it. */
  sharedMemory: Schema.Boolean,
});
export type GpuDeviceSample = typeof GpuDeviceSample.Type;

export const MACHINE_HOLD_MAX_MS = 3_600_000;
export const MACHINE_SAMPLE_MIN_INTERVAL_MS = 500;
export const MACHINE_HISTORY_MAX_MS = 3_600_000;
export const MACHINE_HISTORY_STEP_MS = 5_000;
export const MACHINE_PROCESSES_MIN_INTERVAL_MS = 1_000;
const MACHINE_PROCESSES_MAX_TOP = 10;
export const MACHINE_PROCESSES_MAX_ROWS = 4_000;

const Percent = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 100, exclusiveMinimum: true }),
);
const HoldMs = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MACHINE_HOLD_MAX_MS }));
const LoadPerCore = Schema.Number.check(Schema.isGreaterThan(0));
const ExitFactor = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 1, exclusiveMinimum: true }),
);

export const MachineThresholds = Schema.Struct({
  loadPerCore: LoadPerCore.pipe(Schema.withDecodingDefault(Effect.succeed(12.5))),
  memoryUsedPercent: Percent.pipe(Schema.withDecodingDefault(Effect.succeed(92.5))),
  windowsCpuPercent: Percent.pipe(Schema.withDecodingDefault(Effect.succeed(95))),
  windowsCpuHoldMs: HoldMs.pipe(Schema.withDecodingDefault(Effect.succeed(300_000))),
  enterHoldMs: HoldMs.pipe(Schema.withDecodingDefault(Effect.succeed(10_000))),
  exitHoldMs: HoldMs.pipe(Schema.withDecodingDefault(Effect.succeed(60_000))),
  exitFactor: ExitFactor.pipe(Schema.withDecodingDefault(Effect.succeed(0.85))),
  gpuVramUsedPercent: Percent.pipe(Schema.withDecodingDefault(Effect.succeed(92.5))),
  gpuUtilPercent: Percent.pipe(Schema.withDecodingDefault(Effect.succeed(95))),
  gpuUtilHoldMs: HoldMs.pipe(Schema.withDecodingDefault(Effect.succeed(300_000))),
});
export type MachineThresholds = typeof MachineThresholds.Type;

export const DEFAULT_MACHINE_THRESHOLDS: MachineThresholds = Schema.decodeSync(MachineThresholds)(
  {},
);

export const MachineThresholdsPatch = Schema.Struct({
  loadPerCore: Schema.optionalKey(LoadPerCore),
  memoryUsedPercent: Schema.optionalKey(Percent),
  windowsCpuPercent: Schema.optionalKey(Percent),
  windowsCpuHoldMs: Schema.optionalKey(HoldMs),
  enterHoldMs: Schema.optionalKey(HoldMs),
  exitHoldMs: Schema.optionalKey(HoldMs),
  exitFactor: Schema.optionalKey(ExitFactor),
  gpuVramUsedPercent: Schema.optionalKey(Percent),
  gpuUtilPercent: Schema.optionalKey(Percent),
  gpuUtilHoldMs: Schema.optionalKey(HoldMs),
});
export type MachineThresholdsPatch = typeof MachineThresholdsPatch.Type;

export const MachineResourcesSettings = Schema.Struct({
  thresholds: MachineThresholds.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MACHINE_THRESHOLDS)),
  ),
});
export type MachineResourcesSettings = typeof MachineResourcesSettings.Type;

export const DEFAULT_MACHINE_RESOURCES_SETTINGS: MachineResourcesSettings = Schema.decodeSync(
  MachineResourcesSettings,
)({});

export const MachineResourcesSettingsPatch = Schema.Struct({
  thresholds: Schema.optionalKey(MachineThresholdsPatch),
});
export type MachineResourcesSettingsPatch = typeof MachineResourcesSettingsPatch.Type;

export const MachineVerdict = Schema.Literals(["ok", "stressed", "unknown"]);
export type MachineVerdict = typeof MachineVerdict.Type;

// GPU rules arrive with GPU collection (PR2); older fork clients must already decode them.
export const MachineVerdictRule = Schema.Literals([
  "load",
  "memory",
  "memoryPressure",
  "cpu",
  "gpuVram",
  "gpuUtil",
]);
export type MachineVerdictRule = typeof MachineVerdictRule.Type;

// value/threshold use the rule's unit: load per core, percent, or macOS pressure level (4 = critical).
export const MachineVerdictReason = Schema.Struct({
  rule: MachineVerdictRule,
  value: Schema.Number,
  threshold: Schema.Number,
  heldForMs: NonNegativeInt,
  deviceId: Schema.optionalKey(Schema.String),
  deviceName: Schema.optionalKey(Schema.String),
});
export type MachineVerdictReason = typeof MachineVerdictReason.Type;

export const MachineMemoryPressure = Schema.Literals(["normal", "warn", "critical"]);
export type MachineMemoryPressure = typeof MachineMemoryPressure.Type;

export const MachineTotalsSummary = Schema.Struct({
  cpuUtilization: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  cpuCount: NonNegativeInt,
  load: Schema.NullOr(
    Schema.Struct({ one: Schema.Number, five: Schema.Number, fifteen: Schema.Number }),
  ),
  memoryTotalBytes: NonNegativeInt,
  memoryAvailableBytes: NonNegativeInt,
  swapTotalBytes: NonNegativeInt,
  swapUsedBytes: NonNegativeInt,
  memoryPressure: Schema.NullOr(MachineMemoryPressure),
});
export type MachineTotalsSummary = typeof MachineTotalsSummary.Type;

export const MachineStatusSample = Schema.Struct({
  /** Percent 0–100 per logical core. */
  perCore: Schema.Array(Schema.Number),
  gpus: Schema.optionalKey(Schema.Array(GpuDeviceSample)),
});
export type MachineStatusSample = typeof MachineStatusSample.Type;

/** Permille 0–1000, or -1 where the tick had no reading. */
const Permille = Schema.Int.check(Schema.isBetween({ minimum: -1, maximum: 1000 }));

/** Columns are index-aligned, oldest first, one entry per 5 s tick. */
export const MachineHistory = Schema.Struct({
  stepMs: PositiveInt,
  count: NonNegativeInt,
  /** Age of the newest entry when the snapshot was built. */
  endAgeMs: NonNegativeInt,
  cpu: Schema.Array(Permille),
  /** `count` × `cores`, row-major. */
  perCore: Schema.Array(Permille),
  cores: NonNegativeInt,
  /** Of total memory. */
  memoryUsed: Schema.Array(Permille),
  /** Of total swap. */
  swapUsed: Schema.Array(Permille),
  /** One-minute load average; -1 where unmeasured (Windows). */
  load1: Schema.Array(Schema.Number),
  gpus: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      util: Schema.Array(Permille),
      /** Of the device's VRAM. */
      vramUsed: Schema.Array(Permille),
    }),
  ),
});
export type MachineHistory = typeof MachineHistory.Type;

export const MachineStatusSnapshot = Schema.Struct({
  /** Advances only when the verdict or reason rule changes; heartbeats repeat it. */
  sequence: NonNegativeInt,
  verdict: MachineVerdict,
  verdictAgeMs: NonNegativeInt,
  reason: Schema.NullOr(MachineVerdictReason),
  sampleAgeMs: NonNegativeInt,
  totals: Schema.NullOr(MachineTotalsSummary),
  sample: Schema.optionalKey(MachineStatusSample),
  /** Only on the first snapshot of a subscription that asked for `historyMs`. */
  history: Schema.optionalKey(MachineHistory),
});
export type MachineStatusSnapshot = typeof MachineStatusSnapshot.Type;

export const SubscribeMachineInput = Schema.Struct({
  intervalMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(MACHINE_SAMPLE_MIN_INTERVAL_MS)),
  ),
  historyMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MACHINE_HISTORY_MAX_MS })),
  ),
});
export type SubscribeMachineInput = typeof SubscribeMachineInput.Type;

export const MachineProcessSource = Schema.Literals(["t3", "host"]);
export type MachineProcessSource = typeof MachineProcessSource.Type;

/** Static fields, sent once per process key within a generation. */
export const MachineProcessAdded = Schema.Struct({
  key: NonNegativeInt,
  pid: PositiveInt,
  ppid: NonNegativeInt,
  startTimeMs: NonNegativeInt,
  name: Schema.String,
  /** "" for source "t3". */
  user: Schema.String,
  command: Schema.String,
  containerId: Schema.optionalKey(Schema.String),
});
export type MachineProcessAdded = typeof MachineProcessAdded.Type;

/**
 * Columnar live values, index-aligned. A full frame lists every row in view; a diff lists only
 * rows whose values changed, and the client keeps the rest.
 */
export const MachineProcessRows = Schema.Struct({
  key: Schema.Array(NonNegativeInt),
  /** Percent of one core. */
  cpu: Schema.Array(Schema.Number),
  /** Resident bytes. */
  rss: Schema.Array(NonNegativeInt),
  /** GPU util percent; null where unmeasured. Only with `gpuProcesses`. */
  gpuUtil: Schema.optionalKey(Schema.Array(Schema.NullOr(Schema.Number))),
  /** VRAM bytes across devices; null where unmeasured. Only with `gpuProcesses`. */
  vram: Schema.optionalKey(Schema.Array(Schema.NullOr(NonNegativeInt))),
});
export type MachineProcessRows = typeof MachineProcessRows.Type;

export const MachineProcessFrame = Schema.Struct({
  /** Keys are valid only within one generation; a new generation always starts with a full frame. */
  generation: NonNegativeInt,
  /** Replaces the table. */
  full: Schema.Boolean,
  /** On a split full frame, false on every part but the last; absent when not split. */
  complete: Schema.optionalKey(Schema.Boolean),
  sequence: NonNegativeInt,
  sampleAgeMs: NonNegativeInt,
  source: MachineProcessSource,
  added: Schema.Array(MachineProcessAdded),
  removed: Schema.Array(NonNegativeInt),
  rows: MachineProcessRows,
  gpus: Schema.optionalKey(Schema.Array(GpuDeviceSample)),
  /** Rows left out past the row cap. */
  truncated: Schema.optionalKey(PositiveInt),
});
export type MachineProcessFrame = typeof MachineProcessFrame.Type;

export const SubscribeMachineProcessesInput = Schema.Struct({
  /** Raised to at least 1 s on the server; a process walk costs too much to run faster. */
  intervalMs: PositiveInt,
  /** Top N by CPU together with top N by memory; omitted means the whole table. */
  top: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MACHINE_PROCESSES_MAX_TOP })),
  ),
  /** Per-process GPU columns; the host walks DRM fdinfo or asks NVML for them. */
  gpuProcesses: Schema.optionalKey(Schema.Boolean),
});
export type SubscribeMachineProcessesInput = typeof SubscribeMachineProcessesInput.Type;
