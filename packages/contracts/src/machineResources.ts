import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ForwardCompatibleArray,
  ForwardCompatibleUnion,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

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
/** Load management resumes a paused thread after this long, even if the machine is still stressed. */
export const LOAD_PAUSE_MAX_MS = 30 * 60_000;
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
const GuardHoldSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: MACHINE_HOLD_MAX_MS / 1000 }),
);
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

export const MACHINE_BUCKET_MAX_RULES = 16;
export const MACHINE_BUCKETS_MAX = 50;
export const MACHINE_BUCKET_RULE_VALUE_MAX = 1_024;
export const MACHINE_BUCKET_NAME_MAX = 80;

export const MachineBucketId = TrimmedNonEmptyString.pipe(Schema.brand("MachineBucketId"));
export type MachineBucketId = typeof MachineBucketId.Type;

export const ClaimId = TrimmedNonEmptyString.pipe(Schema.brand("ClaimId"));
export type ClaimId = typeof ClaimId.Type;

/** Who wrote a bucket or a claim: the user in Settings, an agent, or the auto-buckets task. */
export const MachineActor = Schema.Union([
  Schema.Struct({ type: Schema.Literal("user") }),
  Schema.Struct({ type: Schema.Literal("agent"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("auto"), threadId: ThreadId }),
]);
export type MachineActor = typeof MachineActor.Type;

export const MachineBucketRuleField = Schema.Literals([
  "command",
  "exe",
  "cwd",
  "user",
  "container",
  "parent",
]);
export type MachineBucketRuleField = typeof MachineBucketRuleField.Type;

export const MachineBucketRuleOp = Schema.Literals(["equals", "contains", "glob"]);
export type MachineBucketRuleOp = typeof MachineBucketRuleOp.Type;

/** A process matches a bucket when any of its rules matches; a matched process's children follow it. */
export const BucketRule = Schema.Union([
  Schema.Struct({
    field: MachineBucketRuleField,
    op: MachineBucketRuleOp,
    value: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MACHINE_BUCKET_RULE_VALUE_MAX),
    ),
  }),
  /** Processes whose launch environment names the thread (`T3CODE_THREAD_ID`). */
  Schema.Struct({ field: Schema.Literal("thread"), threadId: ThreadId }),
  /** A pin: one process identity; removed once the process exits. */
  Schema.Struct({ field: Schema.Literal("pid"), pid: PositiveInt, startTimeMs: NonNegativeInt }),
]);
export type BucketRule = typeof BucketRule.Type;

export const BucketProvenance = Schema.Struct({
  createdBy: MachineActor,
  updatedBy: MachineActor,
  /** Stored in settings.json, which is decoded from parsed JSON, so the encoded form is a string. */
  updatedAt: Schema.DateTimeUtcFromString,
});
export type BucketProvenance = typeof BucketProvenance.Type;

const MachineBucketFields = {
  id: MachineBucketId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(MACHINE_BUCKET_NAME_MAX)),
  rules: Schema.Array(BucketRule).check(Schema.isMaxLength(MACHINE_BUCKET_MAX_RULES)),
};

export const MachineBucket = Schema.Struct({
  ...MachineBucketFields,
  provenance: BucketProvenance,
});
export type MachineBucket = typeof MachineBucket.Type;

/** What a client writes; the server stamps `provenance` and ignores any a client sends. */
export const MachineBucketInput = Schema.Struct(MachineBucketFields);
export type MachineBucketInput = typeof MachineBucketInput.Type;

/** A settings patch entry. `provenance` is set only by the server's own stamped writes. */
export const MachineBucketPatchEntry = Schema.Struct({
  ...MachineBucketFields,
  provenance: Schema.optionalKey(BucketProvenance),
});
export type MachineBucketPatchEntry = typeof MachineBucketPatchEntry.Type;

export class BucketEditedError extends Schema.TaggedError<BucketEditedError>()(
  "BucketEditedError",
  { bucketId: MachineBucketId },
) {
  override get message(): string {
    return `Bucket ${this.bucketId} was edited by someone else; create a new bucket.`;
  }
}

export class MachineBucketLimitError extends Schema.TaggedError<MachineBucketLimitError>()(
  "MachineBucketLimitError",
  { limit: PositiveInt },
) {
  override get message(): string {
    return `A machine holds at most ${this.limit} buckets.`;
  }
}

export const ClaimTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("process"), pid: PositiveInt, startTimeMs: NonNegativeInt }),
  Schema.Struct({
    type: Schema.Literal("container"),
    /** A container id, id prefix or name, as `docker inspect` takes it. */
    id: TrimmedNonEmptyString,
    dockerHost: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  /** A unified cgroup path such as `/system.slice/foo.service`. */
  Schema.Struct({
    type: Schema.Literal("cgroup"),
    path: TrimmedNonEmptyString.check(Schema.isPattern(/^\//)),
  }),
]);
export type ClaimTarget = typeof ClaimTarget.Type;

/** A process, container or cgroup attached to a thread. In memory only, lost on restart. */
export const Claim = Schema.Struct({
  id: ClaimId,
  threadId: ThreadId,
  target: ClaimTarget,
  createdAt: Schema.DateTimeUtc,
  createdBy: MachineActor,
  /** False where the server cannot measure the target, such as Docker Desktop containers. */
  measurable: Schema.optionalKey(Schema.Boolean),
});
export type Claim = typeof Claim.Type;

export class MachineClaimError extends Schema.TaggedError<MachineClaimError>()(
  "MachineClaimError",
  {
    reason: Schema.Literals([
      "not-found",
      "refused",
      "docker-unavailable",
      "limit",
      "not-supported",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Whose a process is, first match wins: roots, shared units, claims, buckets, provider, container. */
export const ProcessOwner = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("thread"),
    threadId: ThreadId,
    terminalId: Schema.optionalKey(Schema.String),
  }),
  /** A process serving several threads that could not be split, such as Codex `app-server`. */
  Schema.Struct({
    type: Schema.Literal("shared"),
    provider: ProviderDriverKind,
    label: Schema.String,
    threadCount: NonNegativeInt,
  }),
  Schema.Struct({ type: Schema.Literal("t3"), label: Schema.String }),
  Schema.Struct({ type: Schema.Literal("claimed"), claimId: ClaimId, threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("bucket"), bucketId: MachineBucketId }),
  Schema.Struct({ type: Schema.Literal("provider"), provider: ProviderDriverKind }),
  Schema.Struct({ type: Schema.Literal("container"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("other") }),
]);
export type ProcessOwner = typeof ProcessOwner.Type;

/** An owner kind from a newer server decodes as an unknown member, so the frame still decodes. */
export const ReceivedProcessOwner = ForwardCompatibleUnion(ProcessOwner.members, "type");
export type ReceivedProcessOwner = typeof ReceivedProcessOwner.Type;

export const ThreadResourceSource = Schema.Literals(["cgroup", "sample", "none"]);
export type ThreadResourceSource = typeof ThreadResourceSource.Type;

/** What one thread's processes, its claims included, use now. Each process counts once. */
export const ThreadResourceTotals = Schema.Struct({
  /** Percent of one core; null when an on-demand read has no reading under 10 s old to compare. */
  cpuPercent: Schema.NullOr(Schema.Number),
  memoryBytes: NonNegativeInt,
  gpuUtilPercent: Schema.NullOr(Schema.Number),
  vramBytes: Schema.NullOr(NonNegativeInt),
  processCount: NonNegativeInt,
  sampleAgeMs: NonNegativeInt,
  source: ThreadResourceSource,
});
export type ThreadResourceTotals = typeof ThreadResourceTotals.Type;

/** One 30 s rollup. Two points more than 30 s apart mean no turn ran between them. */
export const ThreadResourcePoint = Schema.Struct({
  ageMs: NonNegativeInt,
  cpuPercent: Schema.Number,
  memoryBytes: NonNegativeInt,
  gpuUtilPercent: Schema.NullOr(Schema.Number),
});
export type ThreadResourcePoint = typeof ThreadResourcePoint.Type;

export const THREAD_RESOURCE_HISTORY_POINTS = 240;

export const ServerGetThreadResourcesInput = Schema.Struct({ threadId: ThreadId });
export type ServerGetThreadResourcesInput = typeof ServerGetThreadResourcesInput.Type;

export const ThreadResources = Schema.Struct({
  /** Null when nothing is known to belong to the thread. */
  current: Schema.NullOr(ThreadResourceTotals),
  /** Oldest first, at most 240 points. */
  history: Schema.Array(ThreadResourcePoint),
});
export type ThreadResources = typeof ThreadResources.Type;

export const MachineClaimsReleaseInput = Schema.Struct({ claimId: ClaimId });
export type MachineClaimsReleaseInput = typeof MachineClaimsReleaseInput.Type;

/**
 * A bucket a newer writer stored with a rule or actor this version lacks is dropped whole, not
 * shown without that rule: saving it back would erase the rule. Writes are per entry, so a
 * dropped bucket is never rewritten. The encoded side is untyped because `withDecodingDefault`
 * validates it before any per-entry recovery could run.
 */
const decodesAsBucket = Schema.decodeUnknownOption(MachineBucket);
const ReceivedBuckets = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Record(MachineBucketId, MachineBucket),
    SchemaTransformation.transform<
      Readonly<Record<string, (typeof MachineBucket)["Encoded"]>>,
      Readonly<Record<string, unknown>>
    >({
      decode: (buckets) => {
        const kept: Record<string, (typeof MachineBucket)["Encoded"]> = {};
        for (const [id, bucket] of Object.entries(buckets)) {
          if (Option.isSome(decodesAsBucket(bucket)))
            kept[id] = bucket as (typeof MachineBucket)["Encoded"];
        }
        return kept;
      },
      encode: (buckets) => buckets,
    }),
  ),
);

/** The built-in task that groups unbucketed processes. A null model means the cheapest available. */
export const MachineAutoBucketsSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  modelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type MachineAutoBucketsSettings = typeof MachineAutoBucketsSettings.Type;

/** Off by default: no guard env, unguarded `t3 guard`, no load pauses. */
export const MachineLoadManagementSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  guardHoldSeconds: GuardHoldSeconds.pipe(Schema.withDecodingDefault(Effect.succeed(120))),
  pauseHoldSeconds: GuardHoldSeconds.pipe(Schema.withDecodingDefault(Effect.succeed(60))),
});
export type MachineLoadManagementSettings = typeof MachineLoadManagementSettings.Type;

export const MachineResourcesSettings = Schema.Struct({
  thresholds: MachineThresholds.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MACHINE_THRESHOLDS)),
  ),
  buckets: ReceivedBuckets.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  autoBuckets: MachineAutoBucketsSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  loadManagement: MachineLoadManagementSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type MachineResourcesSettings = typeof MachineResourcesSettings.Type;

export const MachineResourcesSettingsPatch = Schema.Struct({
  thresholds: Schema.optionalKey(MachineThresholdsPatch),
  /** Per entry; null deletes. */
  buckets: Schema.optionalKey(
    Schema.Record(MachineBucketId, Schema.NullOr(MachineBucketPatchEntry)).check(
      Schema.isMaxProperties(MACHINE_BUCKETS_MAX),
    ),
  ),
  /** `modelSelection` replaces the stored one whole; null returns to automatic. */
  autoBuckets: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
    }),
  ),
  loadManagement: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      guardHoldSeconds: Schema.optionalKey(GuardHoldSeconds),
      pauseHoldSeconds: Schema.optionalKey(GuardHoldSeconds),
    }),
  ),
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
  /** Re-sent with the row when it changes. Absent from servers before ownership. */
  owner: Schema.optionalKey(ReceivedProcessOwner),
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
  /**
   * Every claim on this machine; on full frames and whenever the list changes, else absent.
   * A claim with a target or actor kind this version lacks is dropped on its own.
   */
  claims: Schema.optionalKey(ForwardCompatibleArray(Claim)),
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
  /** Only processes this thread owns, directly or through a claim. */
  threadId: Schema.optionalKey(ThreadId),
});
export type SubscribeMachineProcessesInput = typeof SubscribeMachineProcessesInput.Type;

export const MACHINE_PROCESS_SNAPSHOT_MAX_LIMIT = 200;

export const MachineProcessSnapshotGroupBy = Schema.Literals(["none", "owner", "bucket"]);
export type MachineProcessSnapshotGroupBy = typeof MachineProcessSnapshotGroupBy.Type;

/** One process walk for an agent (`t3_machine_read`); not streamed to clients. */
export const MachineProcessSnapshot = Schema.Struct({
  sampleAgeMs: NonNegativeInt,
  source: MachineProcessSource,
  /** Top by CPU together with top by memory, busiest first. */
  processes: Schema.Array(
    Schema.Struct({
      pid: PositiveInt,
      ppid: NonNegativeInt,
      name: Schema.String,
      user: Schema.String,
      /** Only for callers not reaching this machine through a peer link. */
      command: Schema.optionalKey(Schema.String),
      /** Percent of one core. */
      cpuPercent: Schema.Number,
      rssBytes: NonNegativeInt,
      gpuUtilPercent: Schema.optionalKey(Schema.Number),
      vramBytes: Schema.optionalKey(NonNegativeInt),
      owner: Schema.optionalKey(ReceivedProcessOwner),
    }),
  ),
  /** Every process counted once, busiest group first. */
  groups: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        label: Schema.String,
        owner: Schema.optionalKey(ReceivedProcessOwner),
        bucketId: Schema.optionalKey(MachineBucketId),
        cpuPercent: Schema.Number,
        rssBytes: NonNegativeInt,
        count: PositiveInt,
      }),
    ),
  ),
  /** Processes left out past the limit. */
  truncated: Schema.optionalKey(PositiveInt),
});
export type MachineProcessSnapshot = typeof MachineProcessSnapshot.Type;
