import type { MachineProcessRow } from "@t3tools/client-runtime/state/machineProcessFrames";
import { describe, expect, it } from "vite-plus/test";

import { machineProcessGroupOf } from "./machineProcessGroups";

const row = (
  pid: number,
  ppid: number,
  name: string,
  extra: { command?: string; containerId?: string } = {},
): MachineProcessRow => ({
  key: pid,
  pid,
  ppid,
  startTimeMs: 0,
  name,
  user: "",
  command: extra.command ?? name,
  cpu: 0,
  rss: 0,
  ...(extra.containerId === undefined ? {} : { containerId: extra.containerId }),
});

const CLAUDE = { id: "provider:claude", label: "Claude" };
const OTHER = { id: "other", label: "Other" };

describe("machineProcessGroupOf", () => {
  it("puts a provider's descendants in the provider's group", () => {
    const rows = [
      row(1, 0, "launchd"),
      row(10, 1, "claude"),
      row(11, 10, "zsh"),
      row(12, 11, "git", { command: "git status" }),
      row(20, 1, "node", { command: "node /lib/@anthropic-ai/claude-code/cli.js" }),
      row(21, 20, "rg"),
    ];
    const groupOf = machineProcessGroupOf(rows);
    expect(rows.map((process) => groupOf(process).id)).toEqual([
      "other",
      "provider:claude",
      "provider:claude",
      "provider:claude",
      "provider:claude",
      "provider:claude",
    ]);
    expect(groupOf(rows[3]!)).toEqual(CLAUDE);
  });

  it("names a provider that runs inside a container by the provider", () => {
    const rows = [
      row(1, 0, "containerd-shim", { containerId: "abcdef0123456789" }),
      row(2, 1, "codex", { containerId: "abcdef0123456789" }),
      row(3, 1, "postgres", { containerId: "abcdef0123456789" }),
    ];
    const groupOf = machineProcessGroupOf(rows);
    expect(groupOf(rows[1]!)).toEqual({ id: "provider:codex", label: "Codex" });
    expect(groupOf(rows[2]!)).toEqual({
      id: "container:abcdef0123456789",
      label: "container abcdef012345",
    });
  });

  it("groups a container's children with it", () => {
    const rows = [row(1, 0, "sh", { containerId: "c1" }), row(2, 1, "python")];
    const groupOf = machineProcessGroupOf(rows);
    expect(groupOf(rows[1]!)).toEqual({ id: "container:c1", label: "container c1" });
  });

  it("falls back to Other when no ancestor names a group", () => {
    const rows = [row(1, 0, "init"), row(2, 1, "sshd"), row(3, 99, "orphan")];
    const groupOf = machineProcessGroupOf(rows);
    expect(rows.map(groupOf)).toEqual([OTHER, OTHER, OTHER]);
  });

  it("gives the same answer whichever row is asked first", () => {
    const rows = [row(10, 1, "claude"), row(11, 10, "zsh"), row(12, 11, "vim")];
    const leafFirst = machineProcessGroupOf(rows);
    expect(leafFirst(rows[2]!)).toEqual(CLAUDE);
    expect(leafFirst(rows[1]!)).toEqual(CLAUDE);
    const rootFirst = machineProcessGroupOf(rows);
    expect(rootFirst(rows[0]!)).toEqual(CLAUDE);
    expect(rootFirst(rows[2]!)).toEqual(CLAUDE);
  });

  it("ends on a ppid cycle", () => {
    const rows = [row(5, 7, "a"), row(6, 5, "b"), row(7, 6, "c"), row(8, 8, "self")];
    const groupOf = machineProcessGroupOf(rows);
    expect(rows.map(groupOf)).toEqual([OTHER, OTHER, OTHER, OTHER]);
  });

  it("finds a provider inside a ppid cycle", () => {
    // Every row in a cycle is an ancestor of the others.
    const rows = [row(5, 7, "zsh"), row(6, 5, "claude"), row(7, 6, "vim")];
    const groupOf = machineProcessGroupOf(rows);
    expect(rows.map(groupOf)).toEqual([CLAUDE, CLAUDE, CLAUDE]);
  });
});
