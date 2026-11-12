import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HostPowerSnapshot } from "./background.ts";
import { DesktopUpdateChannelSchema, DesktopUpdateStateSchema } from "./ipc.ts";
import { GpuDeviceSample } from "./machineResources.ts";

export const RESOURCE_MONITOR_PROTOCOL_VERSION = 4 as const;
/** A monitor built before v4 still speaks this; the server then uses only v3 messages. */
export const RESOURCE_MONITOR_LEGACY_PROTOCOL_VERSION = 3 as const;
export const MAX_CLAIMED_PROCESSES = 256;

/** Messages whose shape v3 and v4 share. */
const SharedProtocolVersion = Schema.Literals([
  RESOURCE_MONITOR_LEGACY_PROTOCOL_VERSION,
  RESOURCE_MONITOR_PROTOCOL_VERSION,
]);
export type ResourceMonitorProtocolVersion = typeof SharedProtocolVersion.Type;
const V4ProtocolVersion = Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION);

export const HostResourcesSnapshot = Schema.Struct({
  sampledAt: NonNegativeInt,
  cpuUtilization: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  cpuCount: NonNegativeInt,
  availableMemoryBytes: NonNegativeInt,
  totalMemoryBytes: NonNegativeInt,
});
export type HostResourcesSnapshot = typeof HostResourcesSnapshot.Type;

export const ResourceTelemetryIoSemantics = Schema.Literals([
  "storage",
  "logical",
  "all-io",
  "unavailable",
]);
export type ResourceTelemetryIoSemantics = typeof ResourceTelemetryIoSemantics.Type;

export const ResourceTelemetryProcessCategory = Schema.Literals([
  "server",
  "server-child",
  "provider-root",
  "terminal-root",
  "electron-main",
  "electron-renderer",
  "electron-gpu",
  "electron-utility",
  "resource-monitor",
  "unknown-t3",
]);
export type ResourceTelemetryProcessCategory = typeof ResourceTelemetryProcessCategory.Type;

export const ResourceTelemetrySourceStatus = Schema.Literals([
  "starting",
  "healthy",
  "degraded",
  "unavailable",
  "stopped",
]);
export type ResourceTelemetrySourceStatus = typeof ResourceTelemetrySourceStatus.Type;

export const ResourceTelemetryProcessIdentity = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: NonNegativeInt,
});
export type ResourceTelemetryProcessIdentity = typeof ResourceTelemetryProcessIdentity.Type;

export const ResourceMonitorExternalProcess = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: Schema.optionalKey(NonNegativeInt),
});
export type ResourceMonitorExternalProcess = typeof ResourceMonitorExternalProcess.Type;

export const ResourceMonitorCapabilities = Schema.Struct({
  cumulativeCpuTime: Schema.Boolean,
  currentCpuPercent: Schema.Boolean,
  residentMemory: Schema.Boolean,
  virtualMemory: Schema.Boolean,
  ioBytes: Schema.Boolean,
  processStartTime: Schema.Boolean,
  processTree: Schema.Boolean,
  /** v4 "can try" flags; absent from a v3 monitor. */
  hostProcesses: Schema.optionalKey(Schema.Boolean),
  gpuNvidia: Schema.optionalKey(Schema.Boolean),
  gpuIntel: Schema.optionalKey(Schema.Boolean),
  hostTotals: Schema.optionalKey(Schema.Boolean),
});
export type ResourceMonitorCapabilities = typeof ResourceMonitorCapabilities.Type;

export const ResourceMonitorProcessSample = Schema.Struct({
  pid: PositiveInt,
  ppid: NonNegativeInt,
  startTimeMs: NonNegativeInt,
  runTimeMs: NonNegativeInt,
  name: Schema.String,
  command: Schema.String,
  status: Schema.String,
  cpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  residentBytes: NonNegativeInt,
  virtualBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioSemantics: Schema.Literals(["storage", "all-io"]),
});
export type ResourceMonitorProcessSample = typeof ResourceMonitorProcessSample.Type;

export const ResourceMonitorConfigureCommand = Schema.Struct({
  version: SharedProtocolVersion,
  type: Schema.Literal("configure"),
  rootPid: PositiveInt,
  sampleIntervalMs: NonNegativeInt,
  externalProcesses: Schema.Array(ResourceMonitorExternalProcess),
});
export type ResourceMonitorConfigureCommand = typeof ResourceMonitorConfigureCommand.Type;

export const ResourceMonitorSetExternalProcessesCommand = Schema.Struct({
  version: SharedProtocolVersion,
  type: Schema.Literal("setExternalProcesses"),
  processes: Schema.Array(ResourceMonitorExternalProcess),
});
export type ResourceMonitorSetExternalProcessesCommand =
  typeof ResourceMonitorSetExternalProcessesCommand.Type;

export const ResourceMonitorSampleNowCommand = Schema.Struct({
  version: SharedProtocolVersion,
  type: Schema.Literal("sampleNow"),
  requestId: TrimmedNonEmptyString,
});
export type ResourceMonitorSampleNowCommand = typeof ResourceMonitorSampleNowCommand.Type;

export const ResourceMonitorProcessTableCommand = Schema.Struct({
  version: SharedProtocolVersion,
  type: Schema.Literal("processTable"),
  requestId: TrimmedNonEmptyString,
});
export type ResourceMonitorProcessTableCommand = typeof ResourceMonitorProcessTableCommand.Type;

export const ResourceMonitorSetSampleIntervalCommand = Schema.Struct({
  version: SharedProtocolVersion,
  type: Schema.Literal("setSampleInterval"),
  sampleIntervalMs: NonNegativeInt,
});
export type ResourceMonitorSetSampleIntervalCommand =
  typeof ResourceMonitorSetSampleIntervalCommand.Type;

export const ResourceMonitorSetStreamingCommand = Schema.Struct({
  version: SharedProtocolVersion,
  type: Schema.Literal("setStreaming"),
  enabled: Schema.Boolean,
});
export type ResourceMonitorSetStreamingCommand = typeof ResourceMonitorSetStreamingCommand.Type;

export const ResourceMonitorReadHistoryCommand = Schema.Struct({
  version: SharedProtocolVersion,
  type: Schema.Literal("readHistory"),
  requestId: TrimmedNonEmptyString,
  windowMs: NonNegativeInt,
});
export type ResourceMonitorReadHistoryCommand = typeof ResourceMonitorReadHistoryCommand.Type;

export const ResourceMonitorSetClaimedProcessesCommand = Schema.Struct({
  version: V4ProtocolVersion,
  type: Schema.Literal("setClaimedProcesses"),
  processes: Schema.Array(ResourceMonitorExternalProcess).check(
    Schema.isMaxLength(MAX_CLAIMED_PROCESSES),
  ),
});
export type ResourceMonitorSetClaimedProcessesCommand =
  typeof ResourceMonitorSetClaimedProcessesCommand.Type;

/** What one `hostSample` carries. */
export const ResourceMonitorHostSampleOptions = Schema.Struct({
  processes: Schema.Boolean,
  gpus: Schema.Boolean,
  gpuProcesses: Schema.Boolean,
});
export type ResourceMonitorHostSampleOptions = typeof ResourceMonitorHostSampleOptions.Type;

export const ResourceMonitorSetHostStreamingCommand = Schema.Struct({
  version: V4ProtocolVersion,
  type: Schema.Literal("setHostStreaming"),
  /** 0 stops streaming and frees the host process table; otherwise clamped to 1–60 s. */
  intervalMs: NonNegativeInt,
  ...ResourceMonitorHostSampleOptions.fields,
});
export type ResourceMonitorSetHostStreamingCommand =
  typeof ResourceMonitorSetHostStreamingCommand.Type;

export const ResourceMonitorHostSampleNowCommand = Schema.Struct({
  version: V4ProtocolVersion,
  type: Schema.Literal("hostSampleNow"),
  requestId: TrimmedNonEmptyString,
  ...ResourceMonitorHostSampleOptions.fields,
});
export type ResourceMonitorHostSampleNowCommand = typeof ResourceMonitorHostSampleNowCommand.Type;

export const ResourceMonitorHostTotalsCommand = Schema.Struct({
  version: V4ProtocolVersion,
  type: Schema.Literal("hostTotals"),
  requestId: TrimmedNonEmptyString,
});
export type ResourceMonitorHostTotalsCommand = typeof ResourceMonitorHostTotalsCommand.Type;

export const ResourceMonitorGpuTotalsCommand = Schema.Struct({
  version: V4ProtocolVersion,
  type: Schema.Literal("gpuTotals"),
  requestId: TrimmedNonEmptyString,
});
export type ResourceMonitorGpuTotalsCommand = typeof ResourceMonitorGpuTotalsCommand.Type;

export const ResourceMonitorShutdownCommand = Schema.Struct({
  version: SharedProtocolVersion,
  type: Schema.Literal("shutdown"),
});
export type ResourceMonitorShutdownCommand = typeof ResourceMonitorShutdownCommand.Type;

export const ResourceMonitorCommand = Schema.Union([
  ResourceMonitorConfigureCommand,
  ResourceMonitorSetExternalProcessesCommand,
  ResourceMonitorSetSampleIntervalCommand,
  ResourceMonitorSetStreamingCommand,
  ResourceMonitorSampleNowCommand,
  ResourceMonitorProcessTableCommand,
  ResourceMonitorReadHistoryCommand,
  ResourceMonitorSetClaimedProcessesCommand,
  ResourceMonitorSetHostStreamingCommand,
  ResourceMonitorHostSampleNowCommand,
  ResourceMonitorHostTotalsCommand,
  ResourceMonitorGpuTotalsCommand,
  ResourceMonitorShutdownCommand,
]);
export type ResourceMonitorCommand = typeof ResourceMonitorCommand.Type;

export const ResourceMonitorHelloEvent = Schema.Struct({
  version: SharedProtocolVersion,
  type: Schema.Literal("hello"),
  sidecarVersion: TrimmedNonEmptyString,
  sidecarPid: PositiveInt,
  platform: TrimmedNonEmptyString,
  arch: TrimmedNonEmptyString,
  capabilities: ResourceMonitorCapabilities,
});
export type ResourceMonitorHelloEvent = typeof ResourceMonitorHelloEvent.Type;

export const ResourceMonitorSnapshotEvent = Schema.Struct({
  version: SharedProtocolVersion,
  type: Schema.Literal("snapshot"),
  sequence: NonNegativeInt,
  sampledAtUnixMs: NonNegativeInt,
  collectionDurationMicros: NonNegativeInt,
  scannedProcessCount: NonNegativeInt,
  retainedProcessCount: NonNegativeInt,
  inaccessibleProcessCount: NonNegativeInt,
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
  externalProcesses: Schema.optionalKey(Schema.Array(ResourceMonitorExternalProcess)),
  processes: Schema.Array(ResourceMonitorProcessSample),
  /** v4, while claims are set: the claimed roots still alive. */
  claimedProcesses: Schema.optionalKey(Schema.Array(ResourceMonitorExternalProcess)),
  /** v4: every pid in a claimed subtree. These rows belong to their claimant, not to T3. */
  claimedPids: Schema.optionalKey(Schema.Array(PositiveInt)),
});
export type ResourceMonitorSnapshotEvent = typeof ResourceMonitorSnapshotEvent.Type;

export const ResourceMonitorProcessTableEntry = Schema.Struct({
  pid: PositiveInt,
  ppid: NonNegativeInt,
  name: Schema.String,
  /** v4; on the same epoch as `hostSample` start times. */
  startTimeMs: Schema.optionalKey(NonNegativeInt),
});
export type ResourceMonitorProcessTableEntry = typeof ResourceMonitorProcessTableEntry.Type;

export const ResourceMonitorProcessTableEvent = Schema.Struct({
  version: SharedProtocolVersion,
  type: Schema.Literal("processTable"),
  requestId: TrimmedNonEmptyString,
  processes: Schema.Array(ResourceMonitorProcessTableEntry),
});
export type ResourceMonitorProcessTableEvent = typeof ResourceMonitorProcessTableEvent.Type;

export const ResourceMonitorHistoryChunkEvent = Schema.Struct({
  version: SharedProtocolVersion,
  type: Schema.Literal("historyChunk"),
  requestId: TrimmedNonEmptyString,
  done: Schema.Boolean,
  snapshots: Schema.Array(ResourceMonitorSnapshotEvent),
});
export type ResourceMonitorHistoryChunkEvent = typeof ResourceMonitorHistoryChunkEvent.Type;

export const ResourceMonitorErrorEvent = Schema.Struct({
  version: SharedProtocolVersion,
  type: Schema.Literal("error"),
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  recoverable: Schema.Boolean,
});
export type ResourceMonitorErrorEvent = typeof ResourceMonitorErrorEvent.Type;

export const GpuProcessSample = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: NonNegativeInt,
  deviceId: Schema.String,
  utilPercent: Schema.NullOr(Schema.Number),
  vramBytes: Schema.NullOr(NonNegativeInt),
});
export type GpuProcessSample = typeof GpuProcessSample.Type;

/** Index-aligned columns, one entry per process on the host. */
export const ResourceMonitorHostProcessColumns = Schema.Struct({
  pid: Schema.Array(PositiveInt),
  ppid: Schema.Array(NonNegativeInt),
  startTimeMs: Schema.Array(NonNegativeInt),
  /** Percent of one core. */
  cpuPercent: Schema.Array(Schema.Number),
  residentBytes: Schema.Array(NonNegativeInt),
});
export type ResourceMonitorHostProcessColumns = typeof ResourceMonitorHostProcessColumns.Type;

/** Static fields, sent once per process identity until the next `staticReset`. */
export const ResourceMonitorHostProcessStatic = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: NonNegativeInt,
  name: Schema.String,
  user: Schema.String,
  command: Schema.String,
  exe: Schema.String,
  cwd: Schema.String,
  cgroup: Schema.String,
  /** "" outside a container. */
  containerId: Schema.String,
});
export type ResourceMonitorHostProcessStatic = typeof ResourceMonitorHostProcessStatic.Type;

export const ResourceMonitorHostSampleEvent = Schema.Struct({
  version: V4ProtocolVersion,
  type: Schema.Literal("hostSample"),
  sequence: NonNegativeInt,
  sampledAtUnixMs: NonNegativeInt,
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
  collectionDurationMicros: NonNegativeInt,
  scannedProcessCount: NonNegativeInt,
  inaccessibleProcessCount: NonNegativeInt,
  /** Drop every static field held for this monitor before applying `added`. */
  staticReset: Schema.Boolean,
  processes: Schema.optionalKey(ResourceMonitorHostProcessColumns),
  added: Schema.optionalKey(Schema.Array(ResourceMonitorHostProcessStatic)),
  gpus: Schema.optionalKey(Schema.Array(GpuDeviceSample)),
  gpuProcesses: Schema.optionalKey(Schema.Array(GpuProcessSample)),
  /** Devices whose process walk succeeded; a process is unmeasured on any other device. */
  gpuProcessDevices: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ResourceMonitorHostSampleEvent = typeof ResourceMonitorHostSampleEvent.Type;

export const ResourceMonitorHostTotalsEvent = Schema.Struct({
  version: V4ProtocolVersion,
  type: Schema.Literal("hostTotals"),
  requestId: TrimmedNonEmptyString,
  /** macOS only; null fields elsewhere. */
  memoryPressure: Schema.NullOr(Schema.Literals(["normal", "warn", "critical"])),
  memoryAvailableBytes: Schema.NullOr(NonNegativeInt),
  swapTotalBytes: Schema.NullOr(NonNegativeInt),
  swapUsedBytes: Schema.NullOr(NonNegativeInt),
});
export type ResourceMonitorHostTotalsEvent = typeof ResourceMonitorHostTotalsEvent.Type;

export const ResourceMonitorGpuTotalsEvent = Schema.Struct({
  version: V4ProtocolVersion,
  type: Schema.Literal("gpuTotals"),
  requestId: TrimmedNonEmptyString,
  /** Absent when this one query failed; empty when there are no GPUs or GPUs are off. */
  gpus: Schema.optionalKey(Schema.Array(GpuDeviceSample)),
});
export type ResourceMonitorGpuTotalsEvent = typeof ResourceMonitorGpuTotalsEvent.Type;

export const ResourceMonitorEvent = Schema.Union([
  ResourceMonitorHelloEvent,
  ResourceMonitorSnapshotEvent,
  ResourceMonitorProcessTableEvent,
  ResourceMonitorHistoryChunkEvent,
  ResourceMonitorErrorEvent,
  ResourceMonitorHostSampleEvent,
  ResourceMonitorHostTotalsEvent,
  ResourceMonitorGpuTotalsEvent,
]);
export type ResourceMonitorEvent = typeof ResourceMonitorEvent.Type;

export const DesktopElectronProcessType = Schema.Literals([
  "Browser",
  "Tab",
  "Utility",
  "Zygote",
  "Sandbox helper",
  "GPU",
  "Pepper Plugin",
  "Pepper Plugin Broker",
  "Unknown",
]);
export type DesktopElectronProcessType = typeof DesktopElectronProcessType.Type;

export const DesktopElectronProcessMetric = Schema.Struct({
  pid: PositiveInt,
  creationTimeMs: NonNegativeInt,
  type: DesktopElectronProcessType,
  name: Schema.optionalKey(Schema.String),
  serviceName: Schema.optionalKey(Schema.String),
  cpuPercent: Schema.Number,
  cumulativeCpuSeconds: Schema.optionalKey(Schema.Number),
  idleWakeupsPerSecond: Schema.Number,
  workingSetBytes: NonNegativeInt,
  peakWorkingSetBytes: NonNegativeInt,
});
export type DesktopElectronProcessMetric = typeof DesktopElectronProcessMetric.Type;

const DesktopHostPowerSnapshot = Schema.Struct({
  ...HostPowerSnapshot.fields,
  updatedAt: Schema.DateTimeUtcFromString,
});

export const DesktopHostTelemetrySnapshot = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("desktopTelemetry"),
  sequence: NonNegativeInt,
  sampledAtUnixMs: NonNegativeInt,
  electronPid: PositiveInt,
  power: DesktopHostPowerSnapshot,
  speedLimitPercent: Schema.OptionFromNullOr(Schema.Number),
  electronProcesses: Schema.Array(DesktopElectronProcessMetric),
});
export type DesktopHostTelemetrySnapshot = typeof DesktopHostTelemetrySnapshot.Type;

export const DesktopHostTelemetryHello = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("desktopTelemetryHello"),
  electronPid: PositiveInt,
});
export type DesktopHostTelemetryHello = typeof DesktopHostTelemetryHello.Type;

export const DesktopUpdateRemoteOutcome = Schema.Literals([
  "ready-to-install",
  "up-to-date",
  "failed",
]);
export type DesktopUpdateRemoteOutcome = typeof DesktopUpdateRemoteOutcome.Type;

export const DesktopUpdateStatusReport = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("desktopUpdateStatus"),
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
  outcome: Schema.optionalKey(DesktopUpdateRemoteOutcome),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
  state: DesktopUpdateStateSchema,
});
export type DesktopUpdateStatusReport = typeof DesktopUpdateStatusReport.Type;

export const ShellEnvironmentPatch = Schema.Struct({
  PATH: Schema.optionalKey(Schema.NullOr(Schema.String)),
  DBUS_SESSION_BUS_ADDRESS: Schema.optionalKey(Schema.NullOr(Schema.String)),
  DISPLAY: Schema.optionalKey(Schema.NullOr(Schema.String)),
  LANG: Schema.optionalKey(Schema.NullOr(Schema.String)),
  LC_ALL: Schema.optionalKey(Schema.NullOr(Schema.String)),
  LC_CTYPE: Schema.optionalKey(Schema.NullOr(Schema.String)),
  SSH_AUTH_SOCK: Schema.optionalKey(Schema.NullOr(Schema.String)),
  HOMEBREW_PREFIX: Schema.optionalKey(Schema.NullOr(Schema.String)),
  HOMEBREW_CELLAR: Schema.optionalKey(Schema.NullOr(Schema.String)),
  HOMEBREW_REPOSITORY: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_CONFIG_HOME: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_CURRENT_DESKTOP: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_DATA_HOME: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_RUNTIME_DIR: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_SESSION_DESKTOP: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_SESSION_TYPE: Schema.optionalKey(Schema.NullOr(Schema.String)),
  WAYLAND_DISPLAY: Schema.optionalKey(Schema.NullOr(Schema.String)),
  SSL_CERT_FILE: Schema.optionalKey(Schema.NullOr(Schema.String)),
  SSL_CERT_DIR: Schema.optionalKey(Schema.NullOr(Schema.String)),
  NODE_EXTRA_CA_CERTS: Schema.optionalKey(Schema.NullOr(Schema.String)),
  T3CODE_TELEMETRY_ENABLED: Schema.optionalKey(Schema.NullOr(Schema.String)),
  T3CODE_GITHUB_APP_CLIENT_ID: Schema.optionalKey(Schema.NullOr(Schema.String)),
  __MISE_DIFF: Schema.optionalKey(Schema.NullOr(Schema.String)),
  JAVA_HOME: Schema.optionalKey(Schema.NullOr(Schema.String)),
  FNM_DIR: Schema.optionalKey(Schema.NullOr(Schema.String)),
  FNM_MULTISHELL_PATH: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ShellEnvironmentPatch = typeof ShellEnvironmentPatch.Type;

export const DesktopShellEnvironmentSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("shellEnvironment"),
  discovered: Schema.Boolean,
  platform: Schema.String,
  environment: ShellEnvironmentPatch,
});
export type DesktopShellEnvironmentSnapshot = typeof DesktopShellEnvironmentSnapshot.Type;

export const DesktopHostTelemetryMessage = Schema.Union([
  DesktopHostTelemetryHello,
  DesktopShellEnvironmentSnapshot,
  DesktopHostTelemetrySnapshot,
  DesktopUpdateStatusReport,
]);
export type DesktopHostTelemetryMessage = typeof DesktopHostTelemetryMessage.Type;

export const DesktopTelemetrySetDiagnosticsDemand = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("setDiagnosticsDemand"),
  enabled: Schema.Boolean,
});
export type DesktopTelemetrySetDiagnosticsDemand = typeof DesktopTelemetrySetDiagnosticsDemand.Type;

export const DesktopTelemetrySetHostPowerIntervals = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("setHostPowerIntervals"),
  activeIntervalMs: PositiveInt,
  idleIntervalMs: PositiveInt,
});
export type DesktopTelemetrySetHostPowerIntervals =
  typeof DesktopTelemetrySetHostPowerIntervals.Type;

/** Runs check/download/quit-and-install without local confirmation; the remote RPC click supplies consent. */
export const DesktopTelemetryRequestDesktopUpdate = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("requestDesktopUpdate"),
  requestId: TrimmedNonEmptyString,
  /** A track switch: move to this channel first, and install only `targetVersion`. */
  channel: Schema.optionalKey(DesktopUpdateChannelSchema),
  targetVersion: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DesktopTelemetryRequestDesktopUpdate = typeof DesktopTelemetryRequestDesktopUpdate.Type;

export const DesktopTelemetryCommitDesktopUpdate = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("commitDesktopUpdate"),
  requestId: TrimmedNonEmptyString,
});
export type DesktopTelemetryCommitDesktopUpdate = typeof DesktopTelemetryCommitDesktopUpdate.Type;

export const DesktopTelemetryCancelDesktopUpdate = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("cancelDesktopUpdate"),
  requestId: TrimmedNonEmptyString,
});
export type DesktopTelemetryCancelDesktopUpdate = typeof DesktopTelemetryCancelDesktopUpdate.Type;

export const DesktopTelemetryControlMessage = Schema.Union([
  DesktopTelemetrySetDiagnosticsDemand,
  DesktopTelemetrySetHostPowerIntervals,
  DesktopTelemetryRequestDesktopUpdate,
  DesktopTelemetryCommitDesktopUpdate,
  DesktopTelemetryCancelDesktopUpdate,
]);
export type DesktopTelemetryControlMessage = typeof DesktopTelemetryControlMessage.Type;

export const ResourceTelemetryProcess = Schema.Struct({
  identity: ResourceTelemetryProcessIdentity,
  ppid: NonNegativeInt,
  childPids: Schema.Array(PositiveInt),
  depth: NonNegativeInt,
  name: Schema.String,
  command: Schema.String,
  status: Schema.String,
  category: ResourceTelemetryProcessCategory,
  electronType: Schema.optionalKey(DesktopElectronProcessType),
  electronServiceName: Schema.optionalKey(Schema.String),
  cpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  residentBytes: NonNegativeInt,
  peakResidentBytes: NonNegativeInt,
  virtualBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioReadBytesPerSecond: Schema.Number,
  ioWriteBytesPerSecond: Schema.Number,
  ioSemantics: ResourceTelemetryIoSemantics,
  idleWakeupsPerSecond: Schema.optionalKey(Schema.Number),
  runTimeMs: NonNegativeInt,
  firstSeenAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
});
export type ResourceTelemetryProcess = typeof ResourceTelemetryProcess.Type;

export const ResourceTelemetryAggregate = Schema.Struct({
  processCount: NonNegativeInt,
  currentCpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  currentRssBytes: NonNegativeInt,
  peakRssBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioReadBytesPerSecond: Schema.Number,
  ioWriteBytesPerSecond: Schema.Number,
  processStarts: NonNegativeInt,
  processExits: NonNegativeInt,
});
export type ResourceTelemetryAggregate = typeof ResourceTelemetryAggregate.Type;

export const ResourceTelemetryGroups = Schema.Struct({
  backend: ResourceTelemetryAggregate,
  electron: ResourceTelemetryAggregate,
  monitor: ResourceTelemetryAggregate,
  allT3: ResourceTelemetryAggregate,
});
export type ResourceTelemetryGroups = typeof ResourceTelemetryGroups.Type;

export const ResourceTelemetrySourceHealth = Schema.Struct({
  status: ResourceTelemetrySourceStatus,
  lastSampleAt: Schema.Option(Schema.DateTimeUtc),
  lastError: Schema.Option(TrimmedNonEmptyString),
});
export type ResourceTelemetrySourceHealth = typeof ResourceTelemetrySourceHealth.Type;

export const ResourceTelemetryHealth = Schema.Struct({
  native: ResourceTelemetrySourceHealth,
  desktop: ResourceTelemetrySourceHealth,
  sidecarVersion: Schema.Option(TrimmedNonEmptyString),
  sidecarPid: Schema.Option(PositiveInt),
  restartCount: NonNegativeInt,
  collectionDurationMicros: NonNegativeInt,
  scannedProcessCount: NonNegativeInt,
  retainedProcessCount: NonNegativeInt,
  inaccessibleProcessCount: NonNegativeInt,
});
export type ResourceTelemetryHealth = typeof ResourceTelemetryHealth.Type;

export const ResourceAttributionEntry = Schema.Struct({
  component: TrimmedNonEmptyString,
  operation: TrimmedNonEmptyString,
  logicalReadBytes: NonNegativeInt,
  logicalWriteBytes: NonNegativeInt,
  count: NonNegativeInt,
  durationMs: NonNegativeInt,
});
export type ResourceAttributionEntry = typeof ResourceAttributionEntry.Type;

export const ResourceAttributionSnapshot = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  entries: Schema.Array(ResourceAttributionEntry),
});
export type ResourceAttributionSnapshot = typeof ResourceAttributionSnapshot.Type;

export const ResourceTelemetrySnapshot = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  sampleIntervalMs: NonNegativeInt,
  processes: Schema.Array(ResourceTelemetryProcess),
  groups: ResourceTelemetryGroups,
  power: HostPowerSnapshot,
  speedLimitPercent: Schema.Option(Schema.Number),
  attribution: ResourceAttributionSnapshot,
  health: ResourceTelemetryHealth,
});
export type ResourceTelemetrySnapshot = typeof ResourceTelemetrySnapshot.Type;

export const ResourceTelemetryHistoryInput = Schema.Struct({
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
});
export type ResourceTelemetryHistoryInput = typeof ResourceTelemetryHistoryInput.Type;

export const ResourceTelemetryHistoryBucket = Schema.Struct({
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.DateTimeUtc,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  maxRssBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  maxProcessCount: NonNegativeInt,
});
export type ResourceTelemetryHistoryBucket = typeof ResourceTelemetryHistoryBucket.Type;

export const ResourceTelemetryProcessSummary = Schema.Struct({
  identity: ResourceTelemetryProcessIdentity,
  ppid: NonNegativeInt,
  depth: NonNegativeInt,
  name: Schema.String,
  command: Schema.String,
  category: ResourceTelemetryProcessCategory,
  firstSeenAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
  currentCpuPercent: Schema.Number,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  currentRssBytes: NonNegativeInt,
  peakRssBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioSemantics: ResourceTelemetryIoSemantics,
  sampleCount: NonNegativeInt,
});
export type ResourceTelemetryProcessSummary = typeof ResourceTelemetryProcessSummary.Type;

export const ResourceTelemetryHistory = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
  sampleIntervalMs: NonNegativeInt,
  retainedSampleCount: NonNegativeInt,
  buckets: Schema.Array(ResourceTelemetryHistoryBucket),
  topProcesses: Schema.Array(ResourceTelemetryProcessSummary),
  health: ResourceTelemetryHealth,
});
export type ResourceTelemetryHistory = typeof ResourceTelemetryHistory.Type;

export const ResourceTelemetryRetryResult = Schema.Struct({
  accepted: Schema.Boolean,
  snapshot: ResourceTelemetrySnapshot,
});
export type ResourceTelemetryRetryResult = typeof ResourceTelemetryRetryResult.Type;
