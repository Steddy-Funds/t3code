/** Where the unified (v2) hierarchy is mounted on the host. */
const CGROUP_MOUNT = "/sys/fs/cgroup";

/** The unified cgroup path in `/proc/<pid>/cgroup`, or undefined outside cgroup v2. */
export function parseUnifiedCgroupPath(contents: string): string | undefined {
  const matches = [...contents.matchAll(/^0::(\/.*)$/gm)];
  return matches.length === 1 ? matches[0]![1] : undefined;
}

export function cgroupDirectory(path: string): string {
  return path === "/" ? CGROUP_MOUNT : `${CGROUP_MOUNT}${path}`;
}

/** Whether `path` is `parent` or lies below it. */
export function isCgroupWithin(path: string, parent: string): boolean {
  if (parent === "/") return true;
  return path === parent || path.startsWith(`${parent}/`);
}

export type RootCgroup =
  | { readonly type: "adopted"; readonly cgroup: string }
  /** The pid still shares the server's cgroup (systemd may not have moved it yet); read again later. */
  | { readonly type: "pending" }
  | { readonly type: "none" };

/**
 * The cgroup a registered root is measured through: the unit's when the spawn site knows it,
 * else the pid's own. A cgroup equal to or above the server's is never adopted, because it would
 * count the server and everything beside it toward the root.
 */
export function pickRootCgroup(input: {
  /** The scope the spawn site launched into (`AgentScope.controlGroup`). */
  readonly unitCgroup?: string | undefined;
  /** `/proc/<pid>/cgroup`, parsed; undefined when unreadable or outside Linux. */
  readonly pidCgroup?: string | undefined;
  readonly selfCgroup: string | undefined;
}): RootCgroup {
  const adoptable = (cgroup: string) =>
    cgroup !== "/" && (input.selfCgroup === undefined || !isCgroupWithin(input.selfCgroup, cgroup));
  if (input.unitCgroup !== undefined && adoptable(input.unitCgroup)) {
    return { type: "adopted", cgroup: input.unitCgroup };
  }
  if (input.pidCgroup === undefined) return { type: "none" };
  return adoptable(input.pidCgroup)
    ? { type: "adopted", cgroup: input.pidCgroup }
    : { type: "pending" };
}
