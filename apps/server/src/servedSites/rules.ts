import type {
  ResourceMonitorProcessTableEntry,
  ServedSite,
  ServedSiteProcess,
} from "@t3tools/contracts";

import { tableLiveness } from "../resourceTelemetry/ProcessOwnership.ts";

import type { HookRun } from "./ServedSitesHost.ts";

const MAX_NAME_LENGTH = 40;
export const FIRST_FALLBACK_SERVE_PORT = 10_000;
const MAX_SERVE_PORT = 65_535;
const STDERR_LIMIT = 500;

export const isActive = (site: Pick<ServedSite, "status">) =>
  site.status === "publishing" || site.status === "live" || site.status === "stopping";

/** A DNS label from free text: lowercase letters, digits and inner hyphens, at most 40 long. */
export const slugSiteName = (raw: string): string => {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "site" : slug;
};

/** `name`, or `name-2`, `name-3`… trimmed so the suffix still fits the label. */
export const dedupeSiteName = (name: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const base = name.slice(0, MAX_NAME_LENGTH - suffix.length).replace(/-+$/, "");
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/** The local port when no Serve route uses it, else the first free port from 10000. */
export const chooseServePort = (localPort: number, used: ReadonlySet<number>): number | null => {
  if (!used.has(localPort)) return localPort;
  for (let port = FIRST_FALLBACK_SERVE_PORT; port <= MAX_SERVE_PORT; port += 1) {
    if (!used.has(port)) return port;
  }
  return null;
};

/** Whether `pid` is a listener on the port or one of its descendants. Never an ancestor: Stop
 * signals the pid's group, and an ancestor may be a shell, tmux or systemd. */
export const servesPort = (
  table: ReadonlyArray<ResourceMonitorProcessTableEntry>,
  pid: number,
  listeners: ReadonlyArray<number>,
): boolean => {
  const parents = new Map(table.map((entry) => [entry.pid, entry.ppid]));
  const seen = new Set<number>();
  for (let at: number | undefined = pid; at !== undefined && at > 1; at = parents.get(at)) {
    if (listeners.includes(at)) return true;
    if (seen.has(at)) return false;
    seen.add(at);
  }
  return false;
};

/**
 * What stopping a site signals: its pinned pids still running, and their descendants. Never their
 * process group, which an agent's shell shares with every other server it started. Null when the
 * tree holds the T3 server, one of its ancestors, or an agent CLI (a direct child of the server).
 */
export const stoppableProcessTree = (
  table: ReadonlyArray<ResourceMonitorProcessTableEntry>,
  pinned: ReadonlyArray<ServedSiteProcess>,
  serverPid: number,
): ReadonlyArray<ResourceMonitorProcessTableEntry> | null => {
  const isAlive = tableLiveness(table);
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const children = new Map<number, Array<ResourceMonitorProcessTableEntry>>();
  for (const entry of table) {
    const siblings = children.get(entry.ppid) ?? [];
    siblings.push(entry);
    children.set(entry.ppid, siblings);
  }
  const tree = new Map<number, ResourceMonitorProcessTableEntry>();
  const queue = pinned.flatMap((each) =>
    isAlive(each.pid, each.startTimeMs) ? [byPid.get(each.pid)!] : [],
  );
  for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
    if (tree.has(entry.pid)) continue;
    tree.set(entry.pid, entry);
    queue.push(...(children.get(entry.pid) ?? []));
  }
  const guarded = new Set<number>();
  for (
    let at: number | undefined = serverPid;
    at !== undefined && at > 1;
    at = byPid.get(at)?.ppid
  ) {
    if (guarded.has(at)) break;
    guarded.add(at);
  }
  for (const entry of tree.values()) {
    if (guarded.has(entry.pid) || entry.ppid === serverPid) return null;
  }
  return [...tree.values()];
};

export type ExposeOutcome =
  | { readonly _tag: "exposed"; readonly url: string }
  | { readonly _tag: "refused"; readonly error: string }
  | { readonly _tag: "failed"; readonly error: string };

const stderrTail = (stderr: string) => stderr.trim().slice(0, STDERR_LIMIT);

const EXPOSE_FAILED = "Expose hook failed.";

/** `detail: stderr`, or just `detail` when stderr is empty. */
const withStderr = (detail: string, stderr: string) => {
  const tail = stderrTail(stderr);
  return tail === "" ? detail : `${detail}: ${tail}`;
};

/**
 * The public hook contract: exit 0 with exactly one https:// line, 3 refuses, anything else fails.
 * Errors are a one-line headline, then the detail on the lines after it.
 */
export const interpretExpose = (run: HookRun): ExposeOutcome => {
  switch (run._tag) {
    case "timed-out":
      return { _tag: "failed", error: "Expose hook timed out." };
    case "spawn-failed":
      return { _tag: "failed", error: `${EXPOSE_FAILED}\nCould not run it: ${run.detail}` };
    case "exited": {
      if (run.code === 3) {
        const tail = stderrTail(run.stderr);
        const headline = "Public URL refused by the expose hook.";
        return { _tag: "refused", error: tail === "" ? headline : `${headline}\n${tail}` };
      }
      if (run.code !== 0) {
        return {
          _tag: "failed",
          error: `${EXPOSE_FAILED}\n${withStderr(`It exited ${run.code}`, run.stderr)}`,
        };
      }
      const lines = run.stdout.split("\n").filter((line) => line.trim() !== "");
      const url = lines.length === 1 ? lines[0]!.trim() : undefined;
      return url !== undefined && url.startsWith("https://") && URL.canParse(url)
        ? { _tag: "exposed", url }
        : {
            _tag: "failed",
            error: `${EXPOSE_FAILED}\n${withStderr("It did not print exactly one https:// URL", run.stderr)}`,
          };
    }
  }
};
