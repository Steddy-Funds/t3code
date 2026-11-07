/** The fields every process table needs; views add their own columns on top. */
export interface ProcessTableRow {
  readonly pid: number;
  readonly ppid: number;
  readonly startTimeMs: number;
  readonly name: string;
  readonly command: string;
}

export type ProcessTableMode = "raw" | "tree" | "grouped";

interface ProcessSort<Row> {
  readonly value: (row: Row) => number | string;
  readonly descending: boolean;
}

export interface ProcessGroup {
  readonly id: string;
  readonly label: string;
}

export type ProcessTableItem<Row> =
  | {
      readonly kind: "process";
      readonly key: string;
      readonly row: Row;
      readonly depth: number;
      readonly expandable: boolean;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: "group";
      readonly key: string;
      readonly group: ProcessGroup;
      readonly rows: ReadonlyArray<Row>;
      readonly open: boolean;
    };

/** A pid is reused once its process exits, so a process is its pid plus its start time. */
export function processIdentityKey(process: Pick<ProcessTableRow, "pid" | "startTimeMs">): string {
  return `${process.pid}:${process.startTimeMs}`;
}

/** The executable's file name, for rows the host reports without a name. */
export function processNameFromCommand(command: string): string {
  const firstToken = command.trim().split(/\s+/)[0] ?? command;
  const normalized = firstToken.replace(/^['"]|['"]$/g, "");
  return normalized.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? normalized;
}

function compareBy<Row>(sort: ProcessSort<Row> | null) {
  if (sort === null) return null;
  return (left: Row, right: Row) => {
    const a = sort.value(left);
    const b = sort.value(right);
    const order =
      typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
    return sort.descending ? -order : order;
  };
}

function sorted<Row>(rows: ReadonlyArray<Row>, sort: ProcessSort<Row> | null): ReadonlyArray<Row> {
  const compare = compareBy(sort);
  return compare === null ? rows : rows.toSorted(compare);
}

/**
 * The rows a table shows, in order. Raw is a flat sorted list. Tree nests children under their
 * parent (a row whose parent isn't in the table is a root) and sorts siblings; a collapsed key hides
 * its descendants. Grouped is one summary per group, sorted by its rows' total, opening to a flat
 * sorted list.
 */
export function processTableItems<Row extends ProcessTableRow>(input: {
  readonly rows: ReadonlyArray<Row>;
  readonly mode: ProcessTableMode;
  readonly sort: ProcessSort<Row> | null;
  /** Collapsed process keys in tree mode; open group ids in grouped mode. */
  readonly toggled: ReadonlySet<string>;
  readonly groupOf?: ((row: Row) => ProcessGroup) | undefined;
}): ReadonlyArray<ProcessTableItem<Row>> {
  const { rows, sort, toggled } = input;
  const flat = (row: Row, depth = 0): ProcessTableItem<Row> => ({
    kind: "process",
    key: processIdentityKey(row),
    row,
    depth,
    expandable: false,
    collapsed: false,
  });

  if (input.mode === "grouped" && input.groupOf) {
    const groups = new Map<string, { group: ProcessGroup; rows: Row[] }>();
    for (const row of rows) {
      const group = input.groupOf(row);
      const entry = groups.get(group.id) ?? { group, rows: [] };
      entry.rows.push(row);
      groups.set(group.id, entry);
    }
    const total = (members: ReadonlyArray<Row>) => {
      if (sort === null) return members.length;
      return members.reduce((sum, row) => {
        const value = sort.value(row);
        return sum + (typeof value === "number" ? value : 0);
      }, 0);
    };
    const ordered = [...groups.values()].toSorted((left, right) =>
      sort?.descending === false
        ? total(left.rows) - total(right.rows)
        : total(right.rows) - total(left.rows),
    );
    return ordered.flatMap(({ group, rows: members }) => {
      const open = toggled.has(group.id);
      const header: ProcessTableItem<Row> = {
        kind: "group",
        key: `group:${group.id}`,
        group,
        rows: members,
        open,
      };
      return open ? [header, ...sorted(members, sort).map((row) => flat(row, 1))] : [header];
    });
  }

  if (input.mode !== "tree") return sorted(rows, sort).map((row) => flat(row));

  const pids = new Set(rows.map((row) => row.pid));
  const children = new Map<number, Row[]>();
  const roots: Row[] = [];
  for (const row of rows) {
    if (row.ppid === row.pid || !pids.has(row.ppid)) {
      roots.push(row);
      continue;
    }
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  const items: ProcessTableItem<Row>[] = [];
  const visited = new Set<number>();
  // Hidden descendants are still visited, so the loop fallback below never shows them.
  const visit = (row: Row, depth: number, hidden: boolean) => {
    // A reused pid can make the parent chain loop; each pid is placed once.
    if (visited.has(row.pid)) return;
    visited.add(row.pid);
    const key = processIdentityKey(row);
    const below = children.get(row.pid) ?? [];
    const collapsed = toggled.has(key);
    if (!hidden) {
      items.push({ kind: "process", key, row, depth, expandable: below.length > 0, collapsed });
    }
    const hideBelow = hidden || collapsed;
    for (const child of hideBelow ? below : sorted(below, sort)) visit(child, depth + 1, hideBelow);
  };
  for (const root of sorted(roots, sort)) visit(root, 0, false);
  // Rows whose parent chain loops back on itself have no root; show them at the top level.
  for (const row of sorted(rows, sort)) visit(row, 0, false);
  return items;
}
