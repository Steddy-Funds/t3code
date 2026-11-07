import { describe, expect, it } from "vite-plus/test";

import {
  type ProcessGroup,
  type ProcessTableItem,
  type ProcessTableRow,
  processIdentityKey,
  processNameFromCommand,
  processTableItems,
} from "./processRows";

interface Row extends ProcessTableRow {
  readonly cpu: number;
  readonly group?: string;
}

const row = (pid: number, ppid: number, cpu: number, group?: string): Row => ({
  pid,
  ppid,
  startTimeMs: pid * 1_000,
  name: `p${pid}`,
  command: `/bin/p${pid}`,
  cpu,
  ...(group === undefined ? {} : { group }),
});

const byCpu = { value: (process: Row) => process.cpu, descending: true };
const groupOf = (process: Row): ProcessGroup => ({
  id: process.group ?? "other",
  label: process.group ?? "Other",
});

/** "pid@depth" for process items, "[group]" or "[group]+" (open) for group items. */
const shape = (items: ReadonlyArray<ProcessTableItem<Row>>) =>
  items.map((item) =>
    item.kind === "group"
      ? `[${item.group.id}]${item.open ? "+" : ""}`
      : `${item.row.pid}@${item.depth}`,
  );

describe("processTableItems", () => {
  describe("raw", () => {
    const rows = [row(1, 0, 5), row(2, 1, 30), row(3, 1, 10)];

    it("sorts the flat list by the sort column", () => {
      expect(
        shape(processTableItems({ rows, mode: "raw", sort: byCpu, toggled: new Set() })),
      ).toEqual(["2@0", "3@0", "1@0"]);
      const ascending = { ...byCpu, descending: false };
      expect(
        shape(processTableItems({ rows, mode: "raw", sort: ascending, toggled: new Set() })),
      ).toEqual(["1@0", "3@0", "2@0"]);
    });

    it("sorts names alphabetically", () => {
      const named = [
        { ...row(1, 0, 0), name: "zsh" },
        { ...row(2, 0, 0), name: "bun" },
        { ...row(3, 0, 0), name: "node" },
      ];
      const sort = { value: (process: Row) => process.name, descending: false };
      expect(
        shape(processTableItems({ rows: named, mode: "raw", sort, toggled: new Set() })),
      ).toEqual(["2@0", "3@0", "1@0"]);
    });

    it("keeps the given order without a sort", () => {
      expect(
        shape(processTableItems({ rows, mode: "raw", sort: null, toggled: new Set() })),
      ).toEqual(["1@0", "2@0", "3@0"]);
    });

    it("keys each item by pid and start time", () => {
      const [item] = processTableItems({ rows, mode: "raw", sort: null, toggled: new Set() });
      expect(item).toMatchObject({ kind: "process", key: "1:1000", expandable: false });
    });

    it("ignores grouped mode without a groupOf", () => {
      expect(
        shape(processTableItems({ rows, mode: "grouped", sort: byCpu, toggled: new Set() })),
      ).toEqual(["2@0", "3@0", "1@0"]);
    });
  });

  describe("tree", () => {
    // 1 ─┬─ 2 ── 4
    //    └─ 3
    // 9 (parent 50 not in the table)
    const rows = [row(4, 2, 1), row(3, 1, 50), row(1, 0, 5), row(9, 50, 20), row(2, 1, 10)];

    it("nests children under their parent and sorts each set of siblings", () => {
      const items = processTableItems({ rows, mode: "tree", sort: byCpu, toggled: new Set() });
      expect(shape(items)).toEqual(["9@0", "1@0", "3@1", "2@1", "4@2"]);
      expect(items.filter((item) => item.kind === "process" && item.expandable)).toHaveLength(2);
    });

    it("hides every descendant of a collapsed row, not just its children", () => {
      const toggled = new Set([processIdentityKey(row(1, 0, 5))]);
      const items = processTableItems({ rows, mode: "tree", sort: byCpu, toggled });
      expect(shape(items)).toEqual(["9@0", "1@0"]);
      expect(items[1]).toMatchObject({ expandable: true, collapsed: true });
    });

    it("hides only the collapsed branch", () => {
      const toggled = new Set([processIdentityKey(row(2, 1, 10))]);
      expect(shape(processTableItems({ rows, mode: "tree", sort: byCpu, toggled }))).toEqual([
        "9@0",
        "1@0",
        "3@1",
        "2@1",
      ]);
    });

    it("lists a self-parented row once, as a root", () => {
      const self = [row(1, 1, 5), row(2, 1, 3)];
      expect(
        shape(processTableItems({ rows: self, mode: "tree", sort: byCpu, toggled: new Set() })),
      ).toEqual(["1@0", "2@1"]);
    });

    it("lists every row of a ppid loop exactly once", () => {
      // 5 → 6 → 7 → 5, plus a child of the loop.
      const loop = [row(5, 7, 1), row(6, 5, 2), row(7, 6, 3), row(8, 6, 4)];
      const items = processTableItems({
        rows: loop,
        mode: "tree",
        sort: byCpu,
        toggled: new Set(),
      });
      const pids = shape(items).map((entry) => entry.split("@")[0]);
      expect(pids.toSorted()).toEqual(["5", "6", "7", "8"]);
      expect(items[0]).toMatchObject({ depth: 0 });
    });

    it("keeps a collapsed loop's descendants hidden", () => {
      const loop = [row(5, 7, 1), row(6, 5, 2), row(7, 6, 3)];
      // The loop has no root, so the highest-CPU row (7) is placed first; collapse it.
      const toggled = new Set([processIdentityKey(row(7, 6, 3))]);
      expect(shape(processTableItems({ rows: loop, mode: "tree", sort: byCpu, toggled }))).toEqual([
        "7@0",
      ]);
    });
  });

  describe("grouped", () => {
    const rows = [
      row(1, 0, 5, "claude"),
      row(2, 0, 40, "codex"),
      row(3, 0, 30, "claude"),
      row(4, 0, 1),
      row(5, 0, 2, "claude"),
    ];

    it("orders groups by their rows' summed value", () => {
      const items = processTableItems({
        rows,
        mode: "grouped",
        sort: byCpu,
        toggled: new Set(),
        groupOf,
      });
      // claude 37, codex 40, other 1.
      expect(shape(items)).toEqual(["[codex]", "[claude]", "[other]"]);
      expect(items[1]).toMatchObject({ key: "group:claude", rows: [rows[0], rows[2], rows[4]] });

      const ascending = processTableItems({
        rows,
        mode: "grouped",
        sort: { ...byCpu, descending: false },
        toggled: new Set(),
        groupOf,
      });
      expect(shape(ascending)).toEqual(["[other]", "[claude]", "[codex]"]);
    });

    it("orders groups by size without a numeric sort", () => {
      const items = processTableItems({
        rows,
        mode: "grouped",
        sort: null,
        toggled: new Set(),
        groupOf,
      });
      expect(shape(items)).toEqual(["[claude]", "[codex]", "[other]"]);
    });

    it("opens a group to its rows, sorted, at depth 1", () => {
      const items = processTableItems({
        rows,
        mode: "grouped",
        sort: byCpu,
        toggled: new Set(["claude"]),
        groupOf,
      });
      expect(shape(items)).toEqual(["[codex]", "[claude]+", "3@1", "1@1", "5@1", "[other]"]);
    });
  });
});

describe("processNameFromCommand", () => {
  it.each([
    ["/usr/bin/node server.js", "node"],
    ['"C:\\Git\\git.exe" status', "git.exe"],
    ['"C:\\Program Files\\App\\x.exe" --a b', "x.exe"],
    ["'/opt/my app/run' -x", "run"],
    ["C:\\Windows\\cmd.exe /c dir", "cmd.exe"],
    ["  zsh -l", "zsh"],
    ["/opt/app/", "app"],
  ])("%s → %s", (command, name) => {
    expect(processNameFromCommand(command)).toBe(name);
  });
});
