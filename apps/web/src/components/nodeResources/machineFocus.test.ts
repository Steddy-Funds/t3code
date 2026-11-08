import type { MachineProcessRow } from "@t3tools/client-runtime/state/machineProcessFrames";
import { type ClaimId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { focusLineage, processInFocus, threadsFocusedFirst } from "./machineFocus";

const PARENT = ThreadId.make("parent");
const CHILD = ThreadId.make("child");
const OTHER = ThreadId.make("other");

const row = (owner: MachineProcessRow["owner"]): MachineProcessRow => ({
  key: 1,
  pid: 1,
  ppid: 0,
  startTimeMs: 1,
  name: "node",
  user: "",
  command: "node",
  ...(owner === undefined ? {} : { owner }),
  cpu: 0,
  rss: 0,
});

describe("focusLineage", () => {
  it("is the server's lineage, or just the thread from a server without one", () => {
    expect([...focusLineage(PARENT, { threadIds: [PARENT, CHILD] })]).toEqual([PARENT, CHILD]);
    expect([...focusLineage(PARENT, {})]).toEqual([PARENT]);
    expect([...focusLineage(PARENT, null)]).toEqual([PARENT]);
  });
});

describe("processInFocus", () => {
  const lineage = new Set([PARENT, CHILD]);

  it.each([
    {
      label: "a lineage thread's own process",
      owner: { type: "thread", threadId: CHILD },
      in: true,
    },
    {
      label: "a process a lineage thread claimed",
      owner: { type: "claimed", claimId: "claim-1" as ClaimId, threadId: PARENT },
      in: true,
    },
    { label: "another thread's process", owner: { type: "thread", threadId: OTHER }, in: false },
    {
      label: "a shared process",
      owner: { type: "shared", provider: "codex", label: "app-server", threadCount: 2 },
      in: false,
    },
    { label: "a T3 process", owner: { type: "t3", label: "server" }, in: false },
    { label: "an unattributed process", owner: undefined, in: false },
  ] as const)("counts $label: $in", ({ owner, in: expected }) => {
    expect(processInFocus(row(owner as MachineProcessRow["owner"]), lineage)).toBe(expected);
  });
});

describe("threadsFocusedFirst", () => {
  it("moves lineage threads first, keeping the order within each part", () => {
    const threads = [{ id: OTHER }, { id: CHILD }, { id: ThreadId.make("x") }, { id: PARENT }];
    expect(threadsFocusedFirst(threads, new Set([PARENT, CHILD])).map((t) => t.id)).toEqual([
      CHILD,
      PARENT,
      OTHER,
      "x",
    ]);
  });
});
