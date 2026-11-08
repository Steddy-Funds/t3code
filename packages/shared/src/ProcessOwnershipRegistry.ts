import * as Context from "effect/Context";

import { pickRootCgroup, type RootCgroup } from "./cgroup.ts";

export type ProcessRootOwner =
  | { readonly type: "thread"; readonly threadId: string; readonly terminalId?: string }
  | { readonly type: "shared"; readonly provider: string; readonly label: string }
  | { readonly type: "t3"; readonly label: string };

/** A process a spawn site started, with everything below it. Give a pid, a cgroup or both. */
export interface ProcessRoot {
  readonly pid?: number;
  /** On the resource monitor's clock; when omitted, the first process with this pid started by registration is bound. */
  readonly startTimeMs?: number;
  /** The scope the root runs in (`AgentScope.controlGroup(unit)`), when the site launched one. */
  readonly cgroup?: string;
  readonly owner: ProcessRootOwner;
  /** Shared roots: split members by the nearest ancestor whose environment carries `T3CODE_THREAD_ID`. */
  readonly splitByEnv?: boolean;
  /** Shared roots: the threads served right now, for "shared (N threads)". */
  readonly threads?: () => ReadonlyArray<string>;
}

export interface RegisteredRoot {
  readonly id: number;
  readonly root: ProcessRoot;
  readonly registeredAtMs: number;
  readonly cgroup: RootCgroup;
}

export interface ProcessOwnershipRegistryShape {
  /** Synchronous, so a spawn site can register right after spawning. The returned function unregisters. */
  readonly registerRoot: (root: ProcessRoot) => () => void;
  /** Every live root. Roots still sharing the server's cgroup are re-read on each call until they move. */
  readonly roots: () => ReadonlyArray<RegisteredRoot>;
}

/** No-op unless the server provides one, so provider packages can register unconditionally. */
export const ProcessOwnershipRegistry = Context.Reference<ProcessOwnershipRegistryShape>(
  "@t3tools/shared/ProcessOwnershipRegistry",
  { defaultValue: () => ({ registerRoot: () => () => undefined, roots: () => [] }) },
);

export interface ProcessOwnershipRegistryIo {
  /** Parsed `/proc/<pid>/cgroup`; undefined when unreadable or outside Linux. */
  readonly readPidCgroup: (pid: number) => string | undefined;
  readonly selfCgroup: string | undefined;
  readonly now: () => number;
}

export function makeProcessOwnershipRegistry(
  io: ProcessOwnershipRegistryIo,
): ProcessOwnershipRegistryShape {
  const entries = new Map<number, RegisteredRoot>();
  let nextId = 0;

  const resolveCgroup = (root: ProcessRoot) =>
    pickRootCgroup({
      unitCgroup: root.cgroup,
      pidCgroup: root.pid === undefined ? undefined : io.readPidCgroup(root.pid),
      selfCgroup: io.selfCgroup,
    });

  return {
    registerRoot: (root) => {
      const id = nextId++;
      entries.set(id, { id, root, registeredAtMs: io.now(), cgroup: resolveCgroup(root) });
      return () => {
        entries.delete(id);
      };
    },
    roots: () => {
      for (const entry of entries.values()) {
        if (entry.cgroup.type !== "pending") continue;
        entries.set(entry.id, { ...entry, cgroup: resolveCgroup(entry.root) });
      }
      return [...entries.values()];
    },
  };
}
