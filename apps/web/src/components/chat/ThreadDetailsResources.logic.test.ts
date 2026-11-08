import type { MachineProcessRow } from "@t3tools/client-runtime/state/machineProcessFrames";
import { type ClaimId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { idleSummary, threadProcessTree } from "./ThreadDetailsResources.logic";

const THREAD = ThreadId.make("thread-1");

function row(
  pid: number,
  ppid: number,
  startTimeMs: number,
  extra: Partial<MachineProcessRow> = {},
): MachineProcessRow {
  return {
    key: pid * 10,
    pid,
    ppid,
    startTimeMs,
    name: `p${pid}`,
    user: "",
    command: `p${pid}`,
    owner: { type: "thread", threadId: THREAD },
    cpu: pid,
    rss: 1_000,
    ...extra,
  };
}

const terminal = { type: "thread", threadId: THREAD, terminalId: "term-1" } as const;
const claimed = { type: "claimed", claimId: "claim-1" as ClaimId, threadId: THREAD } as const;

const shape = (rows: ReadonlyArray<MachineProcessRow>) => {
  const tree = threadProcessTree(rows);
  return { lines: tree.lines.map((line) => [line.key / 10, line.depth]), hidden: tree.hidden };
};

describe("threadProcessTree", () => {
  it("nests a child under a parent in the set, and makes a child of an outside parent a root", () => {
    expect(shape([row(1, 0, 100), row(2, 1, 200), row(3, 99, 50)])).toEqual({
      lines: [
        [3, 0],
        [1, 0],
        [2, 1],
      ],
      hidden: 0,
    });
  });

  it("orders roots CLI, then terminals, then claims, each by start time", () => {
    const tree = threadProcessTree([
      row(1, 0, 1, { owner: claimed }),
      row(2, 0, 2, { owner: terminal }),
      row(3, 0, 5),
      row(4, 0, 3),
      row(5, 0, 0, { owner: terminal }),
    ]);
    expect(tree.lines.map((line) => line.key / 10)).toEqual([4, 3, 5, 2, 1]);
    expect(tree.lines.map((line) => line.claimed)).toEqual([false, false, false, false, true]);
  });

  it("sorts siblings by start time, then pid", () => {
    expect(shape([row(1, 0, 0), row(4, 1, 20), row(3, 1, 10), row(2, 1, 20)]).lines).toEqual([
      [1, 0],
      [3, 1],
      [2, 1],
      [4, 1],
    ]);
  });

  it("gives a shared root no CPU and labels it with its thread count", () => {
    const [line] = threadProcessTree([
      row(1, 0, 0, {
        name: "codex",
        command: "codex app-server",
        cpu: 40,
        owner: {
          type: "shared",
          provider: ProviderDriverKind.make("codex"),
          label: "app-server",
          threadCount: 3,
        },
      }),
    ]).lines;
    expect(line).toMatchObject({ cpu: null, shared: true, text: "codex · shared (3 threads)" });
  });

  it.each<[string, Partial<MachineProcessRow>, string]>([
    [
      "name and args",
      { name: "node", command: "  node  server.js --port 3000 " },
      "node · server.js --port 3000",
    ],
    ["no args", { name: "bash", command: "bash" }, "bash"],
    ["a terminal", { name: "bash", command: "bash -l", owner: terminal }, "terminal · bash · -l"],
  ])("labels %s", (_name, extra, text) => {
    expect(threadProcessTree([row(1, 0, 0, extra)]).lines[0]).toMatchObject({
      text,
      cpu: 1,
      shared: false,
    });
  });

  it("counts rows deeper than two levels as hidden", () => {
    expect(shape([row(1, 0, 0), row(2, 1, 0), row(3, 2, 0), row(4, 3, 0)])).toEqual({
      lines: [
        [1, 0],
        [2, 1],
        [3, 2],
      ],
      hidden: 1,
    });
  });

  it("shows at most eight rows and counts the rest", () => {
    const tree = threadProcessTree(Array.from({ length: 11 }, (_, i) => row(i + 1, 0, i)));
    expect(tree.lines.map((line) => line.key / 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tree.hidden).toBe(3);
  });

  it("counts a pid-reuse loop with no root as hidden, and keeps a self-parented row", () => {
    expect(shape([row(1, 2, 0), row(2, 1, 0), row(3, 3, 0)])).toEqual({
      lines: [[3, 0]],
      hidden: 2,
    });
  });

  it("is empty for no rows", () => {
    expect(threadProcessTree([])).toEqual({ lines: [], hidden: 0 });
  });
});

describe("idleSummary", () => {
  it("is all null with no history", () => {
    expect(idleSummary([])).toEqual({
      lastActiveMs: null,
      peakCpuPercent: null,
      peakMemoryBytes: null,
    });
  });

  it("takes the newest age and the peak CPU and memory", () => {
    expect(
      idleSummary([
        { ageMs: 90_000, cpuPercent: 12, memoryBytes: 500, gpuUtilPercent: null },
        { ageMs: 30_000, cpuPercent: 80, memoryBytes: 200, gpuUtilPercent: 5 },
        { ageMs: 60_000, cpuPercent: 3, memoryBytes: 900, gpuUtilPercent: null },
      ]),
    ).toEqual({ lastActiveMs: 30_000, peakCpuPercent: 80, peakMemoryBytes: 900 });
  });
});
