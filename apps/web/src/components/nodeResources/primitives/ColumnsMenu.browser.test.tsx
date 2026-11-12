import "~/index.css";

import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { type ColumnOption, ColumnsMenu } from "./ColumnsMenu";

type ColumnId = "cpu" | "memory" | "pid";

const COLUMNS: ReadonlyArray<ColumnOption<ColumnId>> = [
  { id: "cpu", label: "CPU" },
  { id: "memory", label: "Memory" },
  { id: "pid", label: "PID" },
];

function StatefulMenu({
  columns = COLUMNS,
  initial,
  onHiddenChange,
}: {
  readonly columns?: ReadonlyArray<ColumnOption<ColumnId>>;
  readonly initial: ReadonlySet<ColumnId>;
  readonly onHiddenChange: (hidden: ReadonlySet<ColumnId>) => void;
}) {
  const [hidden, setHidden] = useState(initial);
  return (
    <ColumnsMenu
      columns={columns}
      hidden={hidden}
      onHiddenChange={(next) => {
        onHiddenChange(next);
        setHidden(next);
      }}
    />
  );
}

const item = (name: string) => page.getByRole("menuitemcheckbox", { name });

describe("ColumnsMenu", () => {
  it("hides an unchecked column and keeps the menu open", async () => {
    const onHiddenChange = vi.fn();
    await using screen = await render(
      <ColumnsMenu columns={COLUMNS} hidden={new Set(["pid"])} onHiddenChange={onHiddenChange} />,
    );
    await screen.getByRole("button", { name: "Columns" }).click();
    await expect.element(item("CPU")).toBeChecked();
    await expect.element(item("PID")).not.toBeChecked();

    await item("Memory").click();

    expect(onHiddenChange).toHaveBeenCalledExactlyOnceWith(new Set(["pid", "memory"]));
    await expect.element(item("Memory")).toBeVisible();
  });

  it("shows a hidden column when it is checked", async () => {
    const onHiddenChange = vi.fn();
    const hidden = new Set<ColumnId>(["pid", "memory"]);
    await using screen = await render(
      <ColumnsMenu columns={COLUMNS} hidden={hidden} onHiddenChange={onHiddenChange} />,
    );
    await screen.getByRole("button", { name: "Columns" }).click();

    await item("PID").click();

    expect(onHiddenChange).toHaveBeenCalledExactlyOnceWith(new Set(["memory"]));
    // The callback gets a new set; the caller's set is untouched.
    expect(hidden).toEqual(new Set(["pid", "memory"]));
  });

  it("won't hide the last visible column", async () => {
    const onHiddenChange = vi.fn();
    await using screen = await render(
      <StatefulMenu initial={new Set(["pid"])} onHiddenChange={onHiddenChange} />,
    );
    await screen.getByRole("button", { name: "Columns" }).click();
    await expect.element(item("CPU")).toBeEnabled();

    await item("Memory").click();
    await expect.element(item("CPU")).toBeDisabled();
    // Hidden columns stay checkable, so the user can always get back.
    await expect.element(item("Memory")).toBeEnabled();
    await expect.element(item("PID")).toBeEnabled();
    onHiddenChange.mockClear();

    item("CPU")
      .element()
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await expect.element(item("CPU")).toBeChecked();
    expect(onHiddenChange).not.toHaveBeenCalled();

    await item("PID").click();
    await expect.element(item("CPU")).toBeEnabled();
    expect(onHiddenChange).toHaveBeenCalledExactlyOnceWith(new Set(["memory"]));
  });

  it("disables the only column when there is just one", async () => {
    const onHiddenChange = vi.fn();
    await using screen = await render(
      <ColumnsMenu
        columns={[{ id: "cpu", label: "CPU" }]}
        hidden={new Set<string>()}
        onHiddenChange={onHiddenChange}
      />,
    );
    await screen.getByRole("button", { name: "Columns" }).click();
    await expect.element(item("CPU")).toBeDisabled();
  });
});
