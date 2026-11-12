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
      /** The row belongs to the focused thread's lineage. */
      readonly pinned: boolean;
    }
  | {
      readonly kind: "group";
      readonly key: string;
      readonly group: ProcessGroup;
      readonly rows: ReadonlyArray<Row>;
      readonly open: boolean;
      /** Some row of the group is pinned. */
      readonly pinned: boolean;
    };

/** A pid is reused once its process exits, so a process is its pid plus its start time. */
export function processIdentityKey(process: Pick<ProcessTableRow, "pid" | "startTimeMs">): string {
  return `${process.pid}:${process.startTimeMs}`;
}

/** The executable's file name, for rows the host reports without a name. */
export function processNameFromCommand(command: string): string {
  const trimmed = command.trim();
  // A quoted executable may contain spaces: "C:\Program Files\App\app.exe" --flag.
  const quoted = /^(["'])(.*?)\1/.exec(trimmed);
  const executable = quoted
    ? quoted[2]!
    : (trimmed.split(/\s+/)[0] ?? trimmed).replace(/^['"]|['"]$/g, "");
  return executable.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? executable;
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

/** Stable: the sort order holds inside the pinned and the unpinned part. */
function pinnedFirst<Item>(items: ReadonlyArray<Item>, pinned: (item: Item) => boolean) {
  return [...items.filter(pinned), ...items.filter((item) => !pinned(item))];
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
  /** Pinned rows (and in a tree, the branches holding them) come first, keeping the sort inside. */
  readonly pinned?: ((row: Row) => boolean) | undefined;
}): ReadonlyArray<ProcessTableItem<Row>> {
  const { rows, sort, toggled } = input;
  const isPinned = input.pinned ?? (() => false);
  const flat = (row: Row, depth = 0): ProcessTableItem<Row> => ({
    kind: "process",
    key: processIdentityKey(row),
    row,
    depth,
    expandable: false,
    collapsed: false,
    pinned: isPinned(row),
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
    const groupPinned = (members: ReadonlyArray<Row>) => members.some(isPinned);
    return pinnedFirst(ordered, (entry) => groupPinned(entry.rows)).flatMap(
      ({ group, rows: members }) => {
        const open = toggled.has(group.id);
        const header: ProcessTableItem<Row> = {
          kind: "group",
          key: `group:${group.id}`,
          group,
          rows: members,
          open,
          pinned: groupPinned(members),
        };
        return open
          ? [header, ...pinnedFirst(sorted(members, sort), isPinned).map((row) => flat(row, 1))]
          : [header];
      },
    );
  }

  if (input.mode !== "tree") {
    return pinnedFirst(sorted(rows, sort), isPinned).map((row) => flat(row));
  }

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
  // A branch holding a pinned row rises with it, so the pinned rows show near the top of the tree.
  const holdsPinned = new Map<number, boolean>();
  const branchPinned = (row: Row, seen: Set<number> = new Set()): boolean => {
    const known = holdsPinned.get(row.pid);
    if (known !== undefined) return known;
    if (seen.has(row.pid)) return false;
    seen.add(row.pid);
    const result =
      isPinned(row) || (children.get(row.pid) ?? []).some((child) => branchPinned(child, seen));
    holdsPinned.set(row.pid, result);
    return result;
  };
  const ordered = (members: ReadonlyArray<Row>) =>
    pinnedFirst(sorted(members, sort), (row) => branchPinned(row));
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
      items.push({
        kind: "process",
        key,
        row,
        depth,
        expandable: below.length > 0,
        collapsed,
        pinned: isPinned(row),
      });
    }
    const hideBelow = hidden || collapsed;
    for (const child of hideBelow ? below : ordered(below)) visit(child, depth + 1, hideBelow);
  };
  for (const root of ordered(roots)) visit(root, 0, false);
  // Rows whose parent chain loops back on itself have no root; show them at the top level.
  for (const row of sorted(rows, sort)) visit(row, 0, false);
  return items;
}
