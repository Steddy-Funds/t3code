// @effect-diagnostics nodeBuiltinImport:off -- `registerRoot` is synchronous, so its /proc reads are too.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import {
  BucketEditedError,
  ClaimId,
  MACHINE_BUCKETS_MAX,
  MachineBucketLimitError,
  MachineClaimError,
  isProviderDriverKind,
  ThreadId,
  type MachineActor,
  type BucketRule,
  type Claim,
  type ClaimTarget,
  type MachineBucket,
  type MachineBucketId,
  type MachineBucketInput,
  type MachineBucketPatchEntry,
  type ProcessOwner,
  type ResourceMonitorExternalProcess,
  type ResourceMonitorProcessTableEntry,
  type ResourceTelemetryProcessCategory,
  type ServerSettings,
  type ServerSettingsError,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  cgroupDirectory,
  isCgroupWithin,
  parseUnifiedCgroupPath,
  pickRootCgroup,
} from "@t3tools/shared/cgroup";
import { processProviderGroup } from "@t3tools/shared/processProviderGroup";
import {
  makeProcessOwnershipRegistry,
  parseProcStatStartTicks,
  ProcessOwnershipRegistry,
  type RegisteredRoot,
} from "@t3tools/shared/ProcessOwnershipRegistry";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import { serverLineage } from "../diagnostics/ProcessDiagnostics.ts";
import { parseProcEnvironThread, parsePsEnvironmentThreads } from "../preview/PortScanner.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import { childGroup } from "./ProcessGroupMetrics.ts";

/** Start times from the monitor jitter by a few milliseconds between reads. */
const START_TIME_TOLERANCE_MS = 1_000;
/** A root registered without a start time binds the process with its pid that started by then. */
const ROOT_BIND_TOLERANCE_MS = 2_000;
const MAX_CLAIMS = 256;
const PRUNE_INTERVAL_MS = 30_000;
const DOCKER_TIMEOUT = Duration.seconds(10);

export const processKey = (pid: number, startTimeMs: number) => `${pid}:${startTimeMs}`;

const sameStartTime = (a: number, b: number) => Math.abs(a - b) <= START_TIME_TOLERANCE_MS;

/** One process as attribution sees it; static fields are "" where the source lacks them. */
export interface OwnershipRow {
  readonly pid: number;
  readonly ppid: number;
  readonly startTimeMs: number;
  readonly name: string;
  readonly command: string;
  readonly exe: string;
  readonly cwd: string;
  readonly user: string;
  readonly cgroup: string;
  readonly containerId: string;
}

/** A claim with what the server resolved for it once, at claim time. */
export interface ResolvedClaim {
  readonly claim: Claim;
  /** The cgroup the claim is measured through: a container's or a cgroup claim's path. */
  readonly cgroup?: string;
  /** A container's full id, matched against each process's container id. */
  readonly containerId?: string;
  /** A container's init process, whose replacement means the container was recreated. */
  readonly init?: { readonly pid: number; readonly startTimeMs: number };
}

export function ownerThreadId(owner: ProcessOwner): ThreadId | null {
  return owner.type === "thread" || owner.type === "claimed" ? owner.threadId : null;
}

interface ProcessTree {
  readonly rows: ReadonlyArray<OwnershipRow>;
  readonly byPid: ReadonlyMap<number, OwnershipRow>;
  readonly parent: (row: OwnershipRow) => OwnershipRow | undefined;
}

export function buildProcessTree(rows: ReadonlyArray<OwnershipRow>): ProcessTree {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  return {
    rows,
    byPid,
    // A parent that started after its child is a reused pid, not the parent.
    parent: (row) => {
      if (row.ppid <= 0 || row.ppid === row.pid) return undefined;
      const parent = byPid.get(row.ppid);
      return parent !== undefined && parent.startTimeMs <= row.startTimeMs ? parent : undefined;
    },
  };
}

/** The nearest of the row and its ancestors that `mark` names, memoised per call. */
function nearestMarked<T>(
  tree: ProcessTree,
  mark: (row: OwnershipRow) => T | undefined,
): (row: OwnershipRow) => T | undefined {
  const memo = new Map<OwnershipRow, T | null>();
  return (start) => {
    const path: Array<OwnershipRow> = [];
    let found: T | null = null;
    let current: OwnershipRow | undefined = start;
    while (current !== undefined) {
      const known = memo.get(current);
      if (known !== undefined) {
        found = known;
        break;
      }
      const marked = mark(current);
      path.push(current);
      if (marked !== undefined) {
        found = marked;
        break;
      }
      // Bounded by the table size, in case a reused pid makes the parent chain loop.
      if (path.length > tree.rows.length) break;
      current = tree.parent(current);
    }
    for (const row of path) memo.set(row, found);
    return found ?? undefined;
  };
}

interface ProcessIdentity {
  readonly pid: number;
  readonly startTimeMs: number;
}

/** The process each pid root names: its own start time, else the one with that pid started by registration. */
export function boundRootRow<Row extends ProcessIdentity>(
  entry: RegisteredRoot,
  byPid: ReadonlyMap<number, Row>,
): Row | undefined {
  const pid = entry.root.pid;
  if (pid === undefined) return undefined;
  const row = byPid.get(pid);
  if (row === undefined) return undefined;
  const startTimeMs = entry.root.startTimeMs;
  if (startTimeMs !== undefined)
    return sameStartTime(row.startTimeMs, startTimeMs) ? row : undefined;
  return row.startTimeMs <= entry.registeredAtMs + ROOT_BIND_TOLERANCE_MS ? row : undefined;
}

/** `provider-root` and `terminal-root` for every bound pid root, by process key. */
export function rootCategories(
  roots: ReadonlyArray<RegisteredRoot>,
  rows: ReadonlyArray<ProcessIdentity>,
): ReadonlyMap<string, ResourceTelemetryProcessCategory> {
  const categories = new Map<string, ResourceTelemetryProcessCategory>();
  if (roots.length === 0) return categories;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (const entry of roots) {
    if (entry.root.owner.type === "t3") continue;
    const row = boundRootRow(entry, byPid);
    if (row === undefined) continue;
    const terminal =
      entry.root.owner.type === "thread" && entry.root.owner.terminalId !== undefined;
    categories.set(
      processKey(row.pid, row.startTimeMs),
      terminal ? "terminal-root" : "provider-root",
    );
  }
  return categories;
}

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split("")
    .map((char) =>
      char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`);
}

const globCache = new Map<string, RegExp>();
function matchesText(op: "equals" | "contains" | "glob", value: string, text: string): boolean {
  if (text === "") return false;
  if (op === "equals") return text === value;
  if (op === "contains") return text.includes(value);
  let pattern = globCache.get(value);
  if (pattern === undefined) {
    if (globCache.size > 512) globCache.clear();
    pattern = globToRegExp(value);
    globCache.set(value, pattern);
  }
  return pattern.test(text);
}

function ruleMatches(
  rule: BucketRule,
  row: OwnershipRow,
  parent: OwnershipRow | undefined,
  envThread: ThreadId | null | undefined,
): boolean {
  switch (rule.field) {
    case "pid":
      return row.pid === rule.pid && sameStartTime(row.startTimeMs, rule.startTimeMs);
    case "thread":
      return envThread === rule.threadId;
    case "parent":
      return (
        parent !== undefined &&
        (matchesText(rule.op, rule.value, parent.name) ||
          matchesText(rule.op, rule.value, parent.command))
      );
    case "container":
      return matchesText(rule.op, rule.value, row.containerId);
    default:
      return matchesText(rule.op, rule.value, row[rule.field]);
  }
}

/** The first bucket (in settings order) with a rule matching the process itself. */
export function matchBucket(
  buckets: ReadonlyArray<MachineBucket>,
  row: OwnershipRow,
  parent: OwnershipRow | undefined,
  envThread: ThreadId | null | undefined,
): MachineBucketId | null {
  for (const bucket of buckets) {
    if (bucket.rules.some((rule) => ruleMatches(rule, row, parent, envThread))) return bucket.id;
  }
  return null;
}

const bucketsHaveThreadRules = (buckets: ReadonlyArray<MachineBucket>) =>
  buckets.some((bucket) => bucket.rules.some((rule) => rule.field === "thread"));

/** Whether `actor` may change a bucket as it stands: `auto` only touches buckets nobody else edited. */
export const mayWriteBucket = (existing: MachineBucket | undefined, actor: MachineActor) =>
  existing === undefined || actor.type !== "auto" || existing.provenance.updatedBy.type === "auto";

/**
 * Stamps a per-entry bucket patch with provenance, ignoring any a client sent, and applies the
 * write rules: `auto` never changes a bucket someone else edited, and the total stays bounded.
 */
export function stampBucketPatch(input: {
  readonly current: Readonly<Record<string, MachineBucket>>;
  readonly entries: Readonly<Record<string, MachineBucketPatchEntry | MachineBucketInput | null>>;
  readonly actor: MachineActor;
  readonly now: DateTime.Utc;
}): Result.Result<
  Record<string, MachineBucket | null>,
  BucketEditedError | MachineBucketLimitError
> {
  const stamped: Record<string, MachineBucket | null> = {};
  const ids = new Set(Object.keys(input.current));
  for (const [key, entry] of Object.entries(input.entries)) {
    const id = key as MachineBucketId;
    const existing = Object.hasOwn(input.current, key) ? input.current[key] : undefined;
    if (!mayWriteBucket(existing, input.actor)) {
      return Result.fail(new BucketEditedError({ bucketId: id }));
    }
    if (entry === null) {
      stamped[key] = null;
      ids.delete(key);
      continue;
    }
    stamped[key] = {
      id,
      name: entry.name,
      rules: entry.rules,
      provenance: {
        createdBy: existing?.provenance.createdBy ?? input.actor,
        updatedBy: input.actor,
        updatedAt: input.now,
      },
    };
    ids.add(key);
  }
  const before = Object.keys(input.current).length;
  if (ids.size > MACHINE_BUCKETS_MAX && ids.size > before) {
    return Result.fail(new MachineBucketLimitError({ limit: MACHINE_BUCKETS_MAX }));
  }
  return Result.succeed(stamped);
}

/** Buckets whose pins name exited processes, with those pins removed. Provenance is unchanged. */
export function prunePins(
  buckets: ReadonlyArray<MachineBucket>,
  isAlive: (pid: number, startTimeMs: number) => boolean,
): Record<string, MachineBucket> {
  const pruned: Record<string, MachineBucket> = {};
  for (const bucket of buckets) {
    const rules = bucket.rules.filter(
      (rule) => rule.field !== "pid" || isAlive(rule.pid, rule.startTimeMs),
    );
    if (rules.length !== bucket.rules.length) pruned[bucket.id] = { ...bucket, rules };
  }
  return pruned;
}

export interface AttributionInput {
  readonly tree: ProcessTree;
  readonly roots: ReadonlyArray<RegisteredRoot>;
  /** Oldest first; with several claims on one process or container, the first wins. */
  readonly claims: ReadonlyArray<ResolvedClaim>;
  readonly buckets: ReadonlyArray<MachineBucket>;
  readonly serverPid: number;
  readonly monitorPid: number | undefined;
  /** `T3CODE_THREAD_ID` from a process's launch environment; undefined when unread. */
  readonly envThread: (row: OwnershipRow) => ThreadId | null | undefined;
  /** Bucket matches carried across samples: static fields never change for one identity. */
  readonly bucketMemo: Map<string, MachineBucketId | null>;
}

/**
 * One owner per process, so per-thread sums never count a process twice. In order: registered
 * roots and their subtrees (shared units split by environment), claims, buckets, the provider or
 * T3 group under the server, the container, then other.
 */
export function attributeRows(input: AttributionInput): Map<string, ProcessOwner> {
  const { tree } = input;

  const pidRoots = new Map<OwnershipRow, RegisteredRoot>();
  const cgroupRoots: Array<{ readonly cgroup: string; readonly entry: RegisteredRoot }> = [];
  for (const entry of input.roots) {
    const row = boundRootRow(entry, tree.byPid);
    if (row !== undefined) pidRoots.set(row, entry);
    // A root still sharing the server's cgroup counts only its pid subtree meanwhile.
    if (entry.cgroup.type === "adopted") cgroupRoots.push({ cgroup: entry.cgroup.cgroup, entry });
  }
  // Deepest cgroup first, so a unit nested in another unit wins.
  cgroupRoots.sort((a, b) => b.cgroup.length - a.cgroup.length);
  const nearestPidRoot = nearestMarked(tree, (row) => pidRoots.get(row));
  const rootOf = (row: OwnershipRow) =>
    nearestPidRoot(row) ??
    (row.cgroup === ""
      ? undefined
      : cgroupRoots.find((root) => isCgroupWithin(row.cgroup, root.cgroup))?.entry);

  const ownerFromRoot = (row: OwnershipRow, entry: RegisteredRoot): ProcessOwner => {
    const owner = entry.root.owner;
    if (owner.type === "thread") {
      return {
        type: "thread",
        threadId: ThreadId.make(owner.threadId),
        ...(owner.terminalId === undefined ? {} : { terminalId: owner.terminalId }),
      };
    }
    if (owner.type === "t3") return { type: "t3", label: owner.label };
    const provider = owner.provider;
    if (!isProviderDriverKind(provider)) return { type: "t3", label: owner.label };
    if (entry.root.splitByEnv === true) {
      const rootRow = boundRootRow(entry, tree.byPid);
      // Stop at the root: the server above it may itself run inside a thread.
      let current: OwnershipRow | undefined = row;
      for (let step = 0; current !== undefined && step <= tree.rows.length; step++) {
        if (current === rootRow) break;
        const threadId = input.envThread(current);
        if (threadId) return { type: "thread", threadId };
        current = tree.parent(current);
      }
    }
    return {
      type: "shared",
      provider,
      label: owner.label,
      threadCount: entry.root.threads?.().length ?? 0,
    };
  };

  const processClaims = new Map<OwnershipRow, ResolvedClaim>();
  for (const resolved of input.claims) {
    const target = resolved.claim.target;
    if (target.type !== "process") continue;
    const row = tree.byPid.get(target.pid);
    if (row !== undefined && sameStartTime(row.startTimeMs, target.startTimeMs)) {
      if (!processClaims.has(row)) processClaims.set(row, resolved);
    }
  }
  const nearestProcessClaim = nearestMarked(tree, (row) => processClaims.get(row));
  const groupClaims = input.claims.filter((resolved) => resolved.claim.target.type !== "process");
  const claimOf = (row: OwnershipRow) =>
    nearestProcessClaim(row) ??
    groupClaims.find(
      (resolved) =>
        (resolved.containerId !== undefined && row.containerId === resolved.containerId) ||
        (resolved.cgroup !== undefined &&
          row.cgroup !== "" &&
          isCgroupWithin(row.cgroup, resolved.cgroup)),
    );

  const ownBucket = (row: OwnershipRow) => {
    const key = processKey(row.pid, row.startTimeMs);
    let bucketId = input.bucketMemo.get(key);
    if (bucketId === undefined) {
      const parent = tree.parent(row);
      bucketId = matchBucket(input.buckets, row, parent, input.envThread(row));
      // A miss on unread statics (empty name, here or on the parent) may match once they arrive.
      const settled = row.name !== "" && (parent === undefined || parent.name !== "");
      if (settled || bucketId !== null) input.bucketMemo.set(key, bucketId);
    }
    return bucketId ?? undefined;
  };
  const bucketOf = nearestMarked(tree, ownBucket);

  const serverRow = tree.byPid.get(input.serverPid);
  const serverChildOf = nearestMarked(tree, (row) =>
    serverRow !== undefined && tree.parent(row) === serverRow ? row : undefined,
  );

  const owners = new Map<string, ProcessOwner>();
  for (const row of tree.rows) {
    owners.set(processKey(row.pid, row.startTimeMs), ownerOf(row));
  }
  return owners;

  function ownerOf(row: OwnershipRow): ProcessOwner {
    if (row === serverRow) return { type: "t3", label: "server" };
    if (row.pid === input.monitorPid) return { type: "t3", label: "resource monitor" };
    const root = rootOf(row);
    if (root !== undefined) return ownerFromRoot(row, root);
    const claim = claimOf(row);
    if (claim !== undefined) {
      return { type: "claimed", claimId: claim.claim.id, threadId: claim.claim.threadId };
    }
    const bucketId = bucketOf(row);
    if (bucketId !== undefined) return { type: "bucket", bucketId };
    const serverChild = serverChildOf(row);
    if (serverChild !== undefined) {
      const group = childGroup(serverChild.name, serverChild.command);
      const isProvider = processProviderGroup(serverChild.name, serverChild.command) !== undefined;
      return isProvider && isProviderDriverKind(group)
        ? { type: "provider", provider: group }
        : { type: "t3", label: group };
    }
    if (row.containerId !== "") return { type: "container", id: row.containerId };
    return { type: "other" };
  }
}

/** Processes whose environment attribution needs and has not read. */
export function environmentReadsNeeded(input: {
  readonly tree: ProcessTree;
  readonly roots: ReadonlyArray<RegisteredRoot>;
  readonly buckets: ReadonlyArray<MachineBucket>;
  readonly known: (row: OwnershipRow) => boolean;
}): ReadonlyArray<OwnershipRow> {
  const { tree } = input;
  if (bucketsHaveThreadRules(input.buckets)) return tree.rows.filter((row) => !input.known(row));
  const splitRoots = new Set<OwnershipRow>();
  for (const entry of input.roots) {
    if (entry.root.owner.type !== "shared" || entry.root.splitByEnv !== true) continue;
    const row = boundRootRow(entry, tree.byPid);
    if (row !== undefined) splitRoots.add(row);
  }
  if (splitRoots.size === 0) return [];
  const splitRootOf = nearestMarked(tree, (row) => (splitRoots.has(row) ? row : undefined));
  return tree.rows.filter(
    (row) => !splitRoots.has(row) && splitRootOf(row) !== undefined && !input.known(row),
  );
}

/** Claims whose target is gone: an exited process, a removed cgroup or a recreated container. */
export function expiredClaims(input: {
  readonly claims: ReadonlyArray<ResolvedClaim>;
  /** Undefined when the process table could not be read; process checks are skipped then. */
  readonly isAlive: ((pid: number, startTimeMs: number) => boolean) | undefined;
  readonly cgroupExists: (path: string) => boolean;
}): ReadonlySet<ClaimId> {
  const expired = new Set<ClaimId>();
  for (const resolved of input.claims) {
    const target = resolved.claim.target;
    if (target.type === "process") {
      if (input.isAlive !== undefined && !input.isAlive(target.pid, target.startTimeMs)) {
        expired.add(resolved.claim.id);
      }
      continue;
    }
    if (resolved.cgroup !== undefined && !input.cgroupExists(resolved.cgroup)) {
      expired.add(resolved.claim.id);
      continue;
    }
    const init = resolved.init;
    if (
      init !== undefined &&
      input.isAlive !== undefined &&
      !input.isAlive(init.pid, init.startTimeMs)
    ) {
      expired.add(resolved.claim.id);
    }
  }
  return expired;
}

/** What the native monitor keeps out of T3's own telemetry: claimed process roots. */
export function claimedProcessRoots(
  claims: ReadonlyArray<ResolvedClaim>,
): ReadonlyArray<ResourceMonitorExternalProcess> {
  return claims.flatMap((resolved) => {
    const target = resolved.claim.target;
    return target.type === "process" ? [{ pid: target.pid, startTimeMs: target.startTimeMs }] : [];
  });
}

const tableLiveness = (table: ReadonlyArray<ResourceMonitorProcessTableEntry>) => {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  return (pid: number, startTimeMs: number) => {
    const entry = byPid.get(pid);
    return entry?.startTimeMs !== undefined && sameStartTime(entry.startTimeMs, startTimeMs);
  };
};

export interface DockerContainer {
  readonly id: string;
  readonly pid: number;
  readonly running: boolean;
}

export interface ProcessOwnershipIo {
  /** One `docker inspect`, with `DOCKER_HOST` when given; null when no such container. */
  readonly dockerInspect: (
    id: string,
    dockerHost: string | undefined,
  ) => Effect.Effect<DockerContainer | null, MachineClaimError>;
  readonly readPidCgroup: (pid: number) => string | undefined;
  readonly cgroupExists: (path: string) => boolean;
  readonly selfCgroup: string | undefined;
  /** `T3CODE_THREAD_ID` per pid; pids it could not read are left out. */
  readonly readThreadEnv: (
    pids: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyMap<number, ThreadId | null>>;
}

const readFileOrUndefined = (path: string) => {
  try {
    return NodeFS.readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

const readLivePidCgroup = (platform: NodeJS.Platform) => (pid: number) => {
  if (platform !== "linux") return undefined;
  const contents = readFileOrUndefined(`/proc/${pid}/cgroup`);
  return contents === undefined ? undefined : parseUnifiedCgroupPath(contents);
};

const readLivePidStartTicks = (platform: NodeJS.Platform) => (pid: number) => {
  if (platform !== "linux") return undefined;
  const stat = readFileOrUndefined(`/proc/${pid}/stat`);
  return stat === undefined ? undefined : parseProcStatStartTicks(stat);
};

const makeLiveIo = Effect.fn("ProcessOwnership.makeLiveIo")(function* () {
  const platform = yield* HostProcess.Platform;
  const runner = yield* ProcessRunner.ProcessRunner;
  const readPidCgroup = readLivePidCgroup(platform);

  const dockerInspect: ProcessOwnershipIo["dockerInspect"] = Effect.fn(
    "ProcessOwnership.dockerInspect",
  )(function* (id, dockerHost) {
    const result = yield* runner
      .run({
        command: "docker",
        args: [
          "inspect",
          "--type",
          "container",
          "--format",
          "{{.Id}} {{.State.Pid}} {{.State.Running}}",
          id,
        ],
        env: { ...process.env, ...(dockerHost === undefined ? {} : { DOCKER_HOST: dockerHost }) },
        timeout: DOCKER_TIMEOUT,
        maxOutputBytes: 64 * 1024,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new MachineClaimError({
              reason: "docker-unavailable",
              detail: `Could not run docker inspect: ${cause.message}`,
            }),
        ),
      );
    if (result.code !== 0) {
      if (/no such/i.test(result.stderr)) return null;
      return yield* new MachineClaimError({
        reason: "docker-unavailable",
        detail: result.stderr.trim() || "docker inspect failed.",
      });
    }
    const [fullId, pid, running] = result.stdout.trim().split(/\s+/);
    if (!fullId) return null;
    return { id: fullId, pid: Number(pid) || 0, running: running === "true" };
  });

  const readThreadEnv: ProcessOwnershipIo["readThreadEnv"] = Effect.fn(
    "ProcessOwnership.readThreadEnv",
  )(function* (pids) {
    if (pids.length === 0) return new Map();
    if (platform === "linux") {
      const threads = new Map<number, ThreadId | null>();
      for (const pid of pids) {
        const raw = readFileOrUndefined(`/proc/${pid}/environ`);
        if (raw !== undefined) threads.set(pid, parseProcEnvironThread(raw));
      }
      return threads;
    }
    if (platform === "win32") return new Map(pids.map((pid) => [pid, null] as const));
    return yield* runner
      .run({
        command: "ps",
        args: ["-E", "-ww", "-o", "pid=,command=", "-p", pids.join(",")],
        timeout: Duration.seconds(5),
        maxOutputBytes: 8 * 1024 * 1024,
      })
      .pipe(
        Effect.map((result) => parsePsEnvironmentThreads(result.stdout)),
        Effect.orElseSucceed(() => new Map<number, ThreadId | null>()),
      );
  });

  return {
    dockerInspect,
    readPidCgroup,
    cgroupExists: (path) => platform === "linux" && NodeFS.existsSync(cgroupDirectory(path)),
    selfCgroup: readPidCgroup(process.pid),
    readThreadEnv,
  } satisfies ProcessOwnershipIo;
});

export interface ClaimInput {
  readonly threadId: ThreadId;
  readonly target: ClaimTarget;
}

export interface ProcessOwnershipShape {
  readonly claim: (
    input: ClaimInput,
    actor: MachineActor,
  ) => Effect.Effect<Claim, MachineClaimError>;
  /** Succeeds when the claim is already gone. */
  readonly release: (claimId: ClaimId) => Effect.Effect<void>;
  /** `machine-claims.cleanup`: every claim of a deleted thread. Archive keeps them. */
  readonly releaseThread: (threadId: ThreadId) => Effect.Effect<void>;
  /** Current claims, oldest first; the same array until they change. */
  readonly claims: Effect.Effect<ReadonlyArray<Claim>>;
  /** Claims with their measurement cgroup, for the per-thread rollup. */
  readonly resolvedClaims: Effect.Effect<ReadonlyArray<ResolvedClaim>>;
  readonly upsertBucket: (
    input: MachineBucketInput,
    actor: MachineActor,
  ) => Effect.Effect<
    MachineBucket,
    BucketEditedError | MachineBucketLimitError | ServerSettingsError
  >;
  readonly deleteBucket: (
    bucketId: MachineBucketId,
    actor: MachineActor,
  ) => Effect.Effect<void, BucketEditedError | ServerSettingsError>;
  /**
   * Writes a settings patch through `write`, first stamping any `machineResources.buckets`
   * entries as `actor`; bucket writes are serialised so concurrent writers never lose one.
   */
  readonly writeSettingsPatch: <E, R>(
    patch: ServerSettingsPatch,
    actor: MachineActor,
    write: (patch: ServerSettingsPatch) => Effect.Effect<ServerSettings, E, R>,
  ) => Effect.Effect<
    ServerSettings,
    E | BucketEditedError | MachineBucketLimitError | ServerSettingsError,
    R
  >;
  /** Owner per process key (`pid:startTimeMs`). Also prunes expired claims and pins, at most every 30 s. */
  readonly attribute: (
    rows: ReadonlyArray<OwnershipRow>,
  ) => Effect.Effect<ReadonlyMap<string, ProcessOwner>>;
  /** Drops expired claims and pins now, if 30 s passed since the last prune. */
  readonly prune: Effect.Effect<void>;
}

const notSupported = Effect.fail(
  new MachineClaimError({
    reason: "not-supported",
    detail: "This server does not track ownership.",
  }),
);

/** No-op unless the server provides it: no claims, no owners, settings written unstamped. */
export class ProcessOwnership extends Context.Reference<ProcessOwnershipShape>(
  "t3/resourceTelemetry/ProcessOwnership",
  {
    defaultValue: () => ({
      claim: () => notSupported,
      release: () => Effect.void,
      releaseThread: () => Effect.void,
      claims: Effect.succeed([]),
      resolvedClaims: Effect.succeed([]),
      upsertBucket: () => notSupported.pipe(Effect.orDie),
      deleteBucket: () => Effect.void,
      writeSettingsPatch: (patch, _actor, write) => write(patch),
      attribute: () => Effect.succeed(new Map()),
      prune: Effect.void,
    }),
  },
) {}

export const makeWith = Effect.fn("ProcessOwnership.make")(function* (io: ProcessOwnershipIo) {
  const registry = yield* ProcessOwnershipRegistry;
  const native = yield* NativeTelemetryClient.NativeTelemetryClient;
  const settings = yield* ServerSettingsService;
  const platform = yield* HostProcess.Platform;
  const claimsRef = yield* Ref.make<ReadonlyArray<ResolvedClaim>>([]);
  const publicClaims = yield* Ref.make<ReadonlyArray<Claim>>([]);
  const claimsLock = yield* Semaphore.make(1);
  const bucketLock = yield* Semaphore.make(1);
  const lastPruneAt = yield* Ref.make<number | null>(null);
  // Host rows carry exe, cwd and user; subtree and sample rows do not, and would miss rules on
  // them, so each kind keeps its own memos. Each call evicts only its own kind's dead keys, so a
  // subtree call never makes the next host call re-read every environment.
  const detailedEnvMemo = new Map<string, ThreadId | null>();
  const liteEnvMemo = new Map<string, ThreadId | null>();
  let detailedMemo = new Map<string, MachineBucketId | null>();
  let liteMemo = new Map<string, MachineBucketId | null>();
  // Settings hand back the same record until buckets change, so its identity keys the memo.
  let memoRecord: Readonly<Record<string, MachineBucket>> | null = null;
  let memoBuckets: ReadonlyArray<MachineBucket> = [];

  const setClaims = Effect.fnUntraced(function* (next: ReadonlyArray<ResolvedClaim>) {
    yield* Ref.set(claimsRef, next);
    yield* Ref.set(
      publicClaims,
      next.map((resolved) => resolved.claim),
    );
    yield* native.setClaimedProcesses(claimedProcessRoots(next)).pipe(Effect.ignore);
  });

  const processTable = native.processTable.pipe(Effect.option);

  const refusal = (detail: string) => new MachineClaimError({ reason: "refused", detail });
  const notFound = (detail: string) => new MachineClaimError({ reason: "not-found", detail });

  const resolveTarget = Effect.fn("ProcessOwnership.resolveTarget")(function* (
    target: ClaimTarget,
  ) {
    switch (target.type) {
      case "process": {
        if (target.pid <= 1) return yield* refusal(`Process ${target.pid} cannot be claimed.`);
        const table = yield* processTable;
        if (Option.isNone(table)) {
          return yield* new MachineClaimError({
            reason: "not-supported",
            detail: "Claiming a process needs the resource monitor.",
          });
        }
        const health = yield* native.health;
        const monitorPid = Option.map(health.hello, (hello) => hello.sidecarPid);
        if (
          Option.contains(monitorPid, target.pid) ||
          serverLineage(table.value, process.pid).has(target.pid)
        ) {
          return yield* refusal(
            "The T3 server, its monitor and the processes it runs under cannot be claimed.",
          );
        }
        if (!tableLiveness(table.value)(target.pid, target.startTimeMs)) {
          return yield* notFound(`Process ${target.pid} is not running with that start time.`);
        }
        return {} satisfies Omit<ResolvedClaim, "claim">;
      }
      case "cgroup": {
        if (platform !== "linux") {
          return yield* new MachineClaimError({
            reason: "not-supported",
            detail: "Cgroup claims need Linux.",
          });
        }
        const picked = pickRootCgroup({ pidCgroup: target.path, selfCgroup: io.selfCgroup });
        if (picked.type !== "adopted") {
          return yield* refusal("A cgroup holding the T3 server cannot be claimed.");
        }
        if (!io.cgroupExists(target.path)) return yield* notFound(`No cgroup at ${target.path}.`);
        return { cgroup: target.path } satisfies Omit<ResolvedClaim, "claim">;
      }
      case "container": {
        const container = yield* io.dockerInspect(target.id, target.dockerHost);
        if (container === null) return yield* notFound(`No container ${target.id}.`);
        const local = target.dockerHost === undefined || target.dockerHost.startsWith("unix://");
        const cgroup =
          local && container.running && container.pid > 0
            ? io.readPidCgroup(container.pid)
            : undefined;
        if (
          cgroup !== undefined &&
          pickRootCgroup({ pidCgroup: cgroup, selfCgroup: io.selfCgroup }).type !== "adopted"
        ) {
          return yield* refusal("A container holding the T3 server cannot be claimed.");
        }
        const table = cgroup === undefined ? Option.none() : yield* processTable;
        const initStart = Option.flatMap(table, (rows) =>
          Option.fromNullishOr(rows.find((row) => row.pid === container.pid)?.startTimeMs),
        );
        return {
          containerId: container.id,
          ...(cgroup === undefined ? {} : { cgroup }),
          ...(Option.isSome(initStart)
            ? { init: { pid: container.pid, startTimeMs: initStart.value } }
            : {}),
        } satisfies Omit<ResolvedClaim, "claim">;
      }
    }
  });

  const claim: ProcessOwnershipShape["claim"] = Effect.fn("ProcessOwnership.claim")(
    function* (input, actor) {
      const resolved: Omit<ResolvedClaim, "claim"> = yield* resolveTarget(input.target);
      const createdAt = yield* DateTime.now;
      // Docker Desktop and remote daemons run containers where this server cannot read them.
      const measurable = input.target.type !== "container" || resolved.cgroup !== undefined;
      const claim: Claim = {
        id: ClaimId.make(`claim_${NodeCrypto.randomUUID()}`),
        threadId: input.threadId,
        target:
          input.target.type === "container" && resolved.containerId !== undefined
            ? { ...input.target, id: resolved.containerId }
            : input.target,
        createdAt,
        createdBy: actor,
        ...(measurable ? {} : { measurable: false }),
      };
      return yield* claimsLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(claimsRef);
          if (current.length >= MAX_CLAIMS) {
            return yield* new MachineClaimError({
              reason: "limit",
              detail: `A machine holds at most ${MAX_CLAIMS} claims.`,
            });
          }
          yield* setClaims([...current, { ...resolved, claim }]);
          return claim;
        }),
      );
    },
  );

  const removeClaims = (remove: (resolved: ResolvedClaim) => boolean) =>
    claimsLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(claimsRef);
        const next = current.filter((resolved) => !remove(resolved));
        if (next.length !== current.length) yield* setClaims(next);
      }),
    );

  const release: ProcessOwnershipShape["release"] = Effect.fn("ProcessOwnership.release")(
    function* (claimId) {
      yield* removeClaims((resolved) => resolved.claim.id === claimId);
    },
  );

  const releaseThread: ProcessOwnershipShape["releaseThread"] = Effect.fn(
    "ProcessOwnership.releaseThread",
  )(function* (threadId) {
    yield* removeClaims((resolved) => resolved.claim.threadId === threadId);
  });

  const currentBuckets = settings.getSettings.pipe(
    Effect.map((current) => current.machineResources.buckets),
  );

  const writeSettingsPatch: ProcessOwnershipShape["writeSettingsPatch"] = (patch, actor, write) => {
    const entries = patch.machineResources?.buckets;
    if (entries === undefined) return write(patch);
    return bucketLock.withPermits(1)(
      Effect.gen(function* () {
        const stamped = stampBucketPatch({
          current: yield* currentBuckets,
          entries,
          actor,
          now: yield* DateTime.now,
        });
        if (Result.isFailure(stamped)) return yield* stamped.failure;
        return yield* write({
          ...patch,
          machineResources: { ...patch.machineResources, buckets: stamped.success },
        });
      }),
    );
  };

  const upsertBucket: ProcessOwnershipShape["upsertBucket"] = Effect.fn(
    "ProcessOwnership.upsertBucket",
  )(function* (input, actor) {
    const next = yield* writeSettingsPatch(
      { machineResources: { buckets: { [input.id]: input } } },
      actor,
      settings.updateSettings,
    );
    return next.machineResources.buckets[input.id]!;
  });

  const deleteBucket: ProcessOwnershipShape["deleteBucket"] = Effect.fn(
    "ProcessOwnership.deleteBucket",
  )(function* (bucketId, actor) {
    yield* writeSettingsPatch(
      { machineResources: { buckets: { [bucketId]: null } } },
      actor,
      settings.updateSettings,
    ).pipe(Effect.catchTags({ MachineBucketLimitError: () => Effect.void }));
  });

  const pruneNow = Effect.fn("ProcessOwnership.prune")(function* () {
    const table = yield* processTable;
    const isAlive = Option.match(table, { onNone: () => undefined, onSome: tableLiveness });
    const claims = yield* Ref.get(claimsRef);
    const expired = expiredClaims({ claims, isAlive, cgroupExists: io.cgroupExists });
    if (expired.size > 0) yield* removeClaims((resolved) => expired.has(resolved.claim.id));
    if (isAlive === undefined) return;
    yield* bucketLock.withPermits(1)(
      Effect.gen(function* () {
        const buckets = yield* currentBuckets;
        const pruned = prunePins(Object.values(buckets), isAlive);
        if (Object.keys(pruned).length === 0) return;
        // Housekeeping, not an edit: provenance stays, so auto-buckets may still maintain them.
        yield* settings.updateSettings({ machineResources: { buckets: pruned } });
      }),
    );
  });

  const prune: ProcessOwnershipShape["prune"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const last = yield* Ref.get(lastPruneAt);
    if (last !== null && now - last < PRUNE_INTERVAL_MS) return;
    yield* Ref.set(lastPruneAt, now);
    yield* pruneNow().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not prune machine claims and pins", { cause: cause.message }),
      ),
    );
  });

  const attribute: ProcessOwnershipShape["attribute"] = Effect.fn("ProcessOwnership.attribute")(
    function* (rows) {
      yield* prune;
      const tree = buildProcessTree(rows);
      const roots = registry.roots();
      const record = yield* currentBuckets.pipe(Effect.orElseSucceed(() => memoRecord ?? {}));
      if (record !== memoRecord) {
        detailedMemo = new Map();
        liteMemo = new Map();
        memoRecord = record;
        memoBuckets = Object.values(record);
      }
      const buckets = memoBuckets;
      const live = new Set(rows.map((row) => processKey(row.pid, row.startTimeMs)));
      const detailed = rows.some((row) => row.exe !== "" || row.cwd !== "" || row.user !== "");
      const bucketMemo = detailed ? detailedMemo : liteMemo;
      const envMemo = detailed ? detailedEnvMemo : liteEnvMemo;
      for (const key of bucketMemo.keys()) if (!live.has(key)) bucketMemo.delete(key);
      for (const key of envMemo.keys()) if (!live.has(key)) envMemo.delete(key);

      const keyOf = (row: OwnershipRow) => processKey(row.pid, row.startTimeMs);
      const unread = environmentReadsNeeded({
        tree,
        roots,
        buckets,
        known: (row) => envMemo.has(keyOf(row)),
      });
      if (unread.length > 0) {
        const read = yield* io.readThreadEnv(unread.map((row) => row.pid));
        // An unreadable environment is remembered as none, so it is read once per identity.
        for (const row of unread) envMemo.set(keyOf(row), read.get(row.pid) ?? null);
      }
      const health = yield* native.health;
      return attributeRows({
        tree,
        roots,
        claims: yield* Ref.get(claimsRef),
        buckets,
        serverPid: process.pid,
        monitorPid: Option.getOrUndefined(Option.map(health.hello, (hello) => hello.sidecarPid)),
        envThread: (row) => envMemo.get(keyOf(row)),
        bucketMemo,
      });
    },
  );

  return {
    claim,
    release,
    releaseThread,
    claims: Effect.andThen(prune, Ref.get(publicClaims)),
    resolvedClaims: Ref.get(claimsRef),
    upsertBucket,
    deleteBucket,
    writeSettingsPatch,
    attribute,
    prune,
  } satisfies ProcessOwnershipShape;
});

/** The registry spawn sites write to; provide it once, at the top, so every site shares it. */
export const layerRegistry = Layer.effect(
  ProcessOwnershipRegistry,
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const readPidCgroup = readLivePidCgroup(platform);
    const clock = yield* Clock.Clock;
    return makeProcessOwnershipRegistry({
      readPidCgroup,
      readPidStartTicks: readLivePidStartTicks(platform),
      selfCgroup: readPidCgroup(process.pid),
      now: () => clock.currentTimeMillisUnsafe(),
    });
  }),
);

export const layer = Layer.effect(
  ProcessOwnership,
  Effect.flatMap(makeLiveIo(), (io) => makeWith(io)),
);
