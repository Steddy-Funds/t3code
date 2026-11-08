import { ChevronDownIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";

export interface ColumnOption<Id extends string> {
  readonly id: Id;
  readonly label: string;
}

/**
 * Shows or hides optional table columns. The last visible column can't be hidden, so the table never
 * ends up empty.
 */
export function ColumnsMenu<Id extends string>({
  columns,
  hidden,
  onHiddenChange,
}: {
  /** The columns the user may hide; fixed columns are left out. */
  readonly columns: ReadonlyArray<ColumnOption<Id>>;
  readonly hidden: ReadonlySet<Id>;
  readonly onHiddenChange: (hidden: ReadonlySet<Id>) => void;
}) {
  const visibleCount = columns.filter((column) => !hidden.has(column.id)).length;
  const setVisible = (id: Id, visible: boolean) => {
    const next = new Set(hidden);
    if (visible) next.delete(id);
    else next.add(id);
    onHiddenChange(next);
  };
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="xs" />}>
        Columns
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        {columns.map((column) => {
          const visible = !hidden.has(column.id);
          return (
            <MenuCheckboxItem
              key={column.id}
              checked={visible}
              disabled={visible && visibleCount === 1}
              closeOnClick={false}
              onCheckedChange={(checked) => setVisible(column.id, checked)}
            >
              {column.label}
            </MenuCheckboxItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}
