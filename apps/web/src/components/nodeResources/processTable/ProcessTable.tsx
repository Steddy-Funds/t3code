import { LegendList } from "@legendapp/list/react";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { memo, type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import {
  type ProcessGroup,
  type ProcessTableItem,
  type ProcessTableMode,
  type ProcessTableRow,
  processTableItems,
} from "./processRows";
import { ProcessTreeName } from "./ProcessTreeName";

export interface ProcessColumn<Row> {
  readonly id: string;
  readonly label: string;
  /** A CSS grid track, such as "5rem" or "minmax(8rem, 2fr)". */
  readonly width: string;
  readonly align?: "end";
  /** Omitted for columns that can't sort. */
  readonly sortValue?: (row: Row) => number | string;
  readonly render: (row: Row) => ReactNode;
  /** A group row's value for this column, such as summed CPU. */
  readonly total?: (rows: ReadonlyArray<Row>) => ReactNode;
}

export interface ProcessTableSort {
  readonly columnId: string;
  readonly descending: boolean;
}

interface ProcessTableKill<Row> {
  readonly canKill: (row: Row) => boolean;
  readonly signalingKeys: ReadonlySet<string>;
  readonly onKill: (row: Row) => void;
}

const NAME_COLUMN_ID = "name";
const NAME_TRACK = "minmax(12rem, 2fr)";
const KILL_TRACK = "2rem";
const ROW_HEIGHT = 30;

/**
 * One virtualised process table for every view: raw, tree (▸/▾) or grouped (one summary row per
 * group, opening to a flat list). Rows re-render only when their own row object changes, so a
 * frame that touches ten processes repaints ten rows.
 */
export function ProcessTable<Row extends ProcessTableRow>({
  rows,
  columns,
  mode,
  groupOf,
  defaultSort,
  kill,
  empty,
  className,
}: {
  readonly rows: ReadonlyArray<Row>;
  /** Columns after the name, which always comes first. */
  readonly columns: ReadonlyArray<ProcessColumn<Row>>;
  readonly mode: ProcessTableMode;
  readonly groupOf?: ((row: Row) => ProcessGroup) | undefined;
  readonly defaultSort: ProcessTableSort;
  readonly kill?: ProcessTableKill<Row> | undefined;
  /** Shown instead of the list when there are no rows. */
  readonly empty: ReactNode;
  /** Sets the table's height; the list scrolls inside it. */
  readonly className?: string;
}) {
  const [sort, setSort] = useState(defaultSort);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() => new Set());
  // Rows keep a stable kill handler, so a frame that only changes the caller's closures (such as
  // a child count) doesn't repaint every row.
  const killRef = useRef(kill);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- latest kill handler for memoised rows
  useLayoutEffect(() => {
    killRef.current = kill;
  });
  const killRow = (row: Row) => killRef.current?.onKill(row);
  const sortColumn = columns.find((column) => column.id === sort.columnId);
  const sortValue =
    sort.columnId === NAME_COLUMN_ID ? (row: Row) => row.name : sortColumn?.sortValue;
  const items = processTableItems({
    rows,
    mode,
    sort: sortValue ? { value: sortValue, descending: sort.descending } : null,
    toggled,
    groupOf,
  });
  const gridTemplateColumns = [
    NAME_TRACK,
    ...columns.map((column) => column.width),
    KILL_TRACK,
  ].join(" ");
  const toggle = (key: string) =>
    setToggled((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const sortBy = (columnId: string) =>
    setSort((current) => ({
      columnId,
      // Numbers start largest first, names A to Z.
      descending: current.columnId === columnId ? !current.descending : columnId !== NAME_COLUMN_ID,
    }));

  return (
    <div className={cn("flex min-h-0 flex-col overflow-x-auto text-xs", className ?? "h-96")}>
      <div className="flex min-h-0 min-w-3xl flex-1 flex-col">
        <div
          role="row"
          className="grid shrink-0 items-center gap-2 border-b px-2 py-1.5 text-muted-foreground"
          style={{ gridTemplateColumns }}
        >
          <SortHeader
            label="Process"
            active={sort.columnId === NAME_COLUMN_ID}
            descending={sort.descending}
            onSort={() => sortBy(NAME_COLUMN_ID)}
          />
          {columns.map((column) =>
            column.sortValue ? (
              <SortHeader
                key={column.id}
                label={column.label}
                align={column.align}
                active={sort.columnId === column.id}
                descending={sort.descending}
                onSort={() => sortBy(column.id)}
              />
            ) : (
              <span
                key={column.id}
                role="columnheader"
                className={cn("truncate", column.align === "end" && "text-end")}
              >
                {column.label}
              </span>
            ),
          )}
          <span role="columnheader" className="sr-only">
            Kill
          </span>
        </div>
        {items.length === 0 ? (
          <div className="px-2 py-3 text-muted-foreground">{empty}</div>
        ) : (
          <LegendList<ProcessTableItem<Row>>
            data={items}
            keyExtractor={(item) => item.key}
            getItemType={(item) => item.kind}
            estimatedItemSize={ROW_HEIGHT}
            drawDistance={ROW_HEIGHT * 10}
            // Kill state isn't in `items`, so a new signalling set or permission must redraw rows too.
            extraData={kill}
            className="min-h-0 flex-1 overscroll-y-contain"
            renderItem={({ item }) =>
              item.kind === "group" ? (
                <GroupRow
                  item={item}
                  columns={columns}
                  gridTemplateColumns={gridTemplateColumns}
                  onToggle={toggle}
                />
              ) : (
                <ProcessRow
                  item={item}
                  columns={columns}
                  gridTemplateColumns={gridTemplateColumns}
                  onToggle={toggle}
                  canKill={kill?.canKill(item.row) ?? false}
                  onKill={killRow}
                  signaling={kill?.signalingKeys.has(item.key) ?? false}
                />
              )
            }
          />
        )}
      </div>
    </div>
  );
}

function SortHeader({
  label,
  align,
  active,
  descending,
  onSort,
}: {
  readonly label: string;
  readonly align?: "end" | undefined;
  readonly active: boolean;
  readonly descending: boolean;
  readonly onSort: () => void;
}) {
  const Arrow = descending ? ArrowDownIcon : ArrowUpIcon;
  return (
    <button
      type="button"
      role="columnheader"
      aria-sort={active ? (descending ? "descending" : "ascending") : "none"}
      onClick={onSort}
      className={cn(
        "flex min-w-0 items-center gap-1 truncate hover:text-foreground",
        align === "end" && "justify-end",
        active && "text-foreground",
      )}
    >
      {label}
      {active ? <Arrow className="size-3 shrink-0" /> : null}
    </button>
  );
}

type ProcessItem<Row> = Extract<ProcessTableItem<Row>, { kind: "process" }>;
type GroupItem<Row> = Extract<ProcessTableItem<Row>, { kind: "group" }>;

function ProcessRowView<Row extends ProcessTableRow>({
  item,
  columns,
  gridTemplateColumns,
  onToggle,
  canKill,
  onKill,
  signaling,
}: {
  readonly item: ProcessItem<Row>;
  readonly columns: ReadonlyArray<ProcessColumn<Row>>;
  readonly gridTemplateColumns: string;
  readonly onToggle: (key: string) => void;
  readonly canKill: boolean;
  readonly onKill: (row: Row) => void;
  readonly signaling: boolean;
}) {
  const { row } = item;
  return (
    <div
      role="row"
      className="group/process-row grid items-center gap-2 px-2 hover:bg-accent/50"
      style={{ gridTemplateColumns, height: ROW_HEIGHT }}
    >
      <ProcessTreeName
        name={row.name}
        command={row.command}
        depth={item.depth}
        expandable={item.expandable}
        expanded={!item.collapsed}
        onToggle={() => onToggle(item.key)}
      />
      {columns.map((column) => (
        <span
          key={column.id}
          role="cell"
          className={cn("truncate tabular-nums", column.align === "end" && "text-end")}
        >
          {column.render(row)}
        </span>
      ))}
      <span
        role="cell"
        className="flex justify-end opacity-0 group-hover/process-row:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
      >
        {canKill ? (
          <Button
            size="icon-micro"
            variant="ghost-destructive"
            disabled={signaling}
            aria-label={`Kill ${row.name} (PID ${row.pid})`}
            onClick={() => onKill(row)}
          >
            <XIcon />
          </Button>
        ) : null}
      </span>
    </div>
  );
}

function GroupRowView<Row extends ProcessTableRow>({
  item,
  columns,
  gridTemplateColumns,
  onToggle,
}: {
  readonly item: GroupItem<Row>;
  readonly columns: ReadonlyArray<ProcessColumn<Row>>;
  readonly gridTemplateColumns: string;
  readonly onToggle: (key: string) => void;
}) {
  return (
    <div
      role="row"
      className="grid items-center gap-2 bg-muted/30 px-2 hover:bg-accent/50"
      style={{ gridTemplateColumns, height: ROW_HEIGHT }}
    >
      <ProcessTreeName
        name={item.group.label}
        depth={0}
        expandable
        expanded={item.open}
        onToggle={() => onToggle(item.group.id)}
      >
        <span className="shrink-0 text-muted-foreground tabular-nums">{item.rows.length}</span>
      </ProcessTreeName>
      {columns.map((column) => (
        <span
          key={column.id}
          role="cell"
          className={cn("truncate tabular-nums", column.align === "end" && "text-end")}
        >
          {column.total?.(item.rows)}
        </span>
      ))}
      <span role="cell" />
    </div>
  );
}

// Items are rebuilt every frame, but a process row's own fields only change when its row does.
const ProcessRow = memo(
  ProcessRowView,
  (previous, next) =>
    previous.item.row === next.item.row &&
    previous.item.depth === next.item.depth &&
    previous.item.expandable === next.item.expandable &&
    previous.item.collapsed === next.item.collapsed &&
    previous.columns === next.columns &&
    previous.gridTemplateColumns === next.gridTemplateColumns &&
    previous.onToggle === next.onToggle &&
    previous.canKill === next.canKill &&
    previous.onKill === next.onKill &&
    previous.signaling === next.signaling,
) as typeof ProcessRowView;

const GroupRow = memo(GroupRowView) as typeof GroupRowView;
