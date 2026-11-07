import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../../test/render";
import { type ProcessColumn, ProcessTable } from "./ProcessTable";
import type { ProcessTableRow } from "./processRows";

interface Row extends ProcessTableRow {
  readonly cpu: number;
}

const row = (pid: number, cpu: number): Row => ({
  pid,
  ppid: 0,
  startTimeMs: pid * 1_000,
  name: `p${pid}`,
  command: `/bin/p${pid}`,
  cpu,
});

const renderedPids: number[] = [];
const COLUMNS: ReadonlyArray<ProcessColumn<Row>> = [
  {
    id: "cpu",
    label: "CPU",
    width: "4rem",
    align: "end",
    sortValue: (process) => process.cpu,
    render: (process) => {
      renderedPids.push(process.pid);
      return `${process.cpu}%`;
    },
  },
];
const SORT = { columnId: "cpu", descending: true };

interface Kill {
  readonly canKill: (row: Row) => boolean;
  readonly signalingKeys: ReadonlySet<string>;
  readonly onKill: (row: Row) => void;
}

const table = (rows: ReadonlyArray<Row>, kill?: Kill) => (
  <ProcessTable
    rows={rows}
    columns={COLUMNS}
    mode="raw"
    defaultSort={SORT}
    kill={kill}
    empty="No processes"
  />
);

describe("ProcessTable", () => {
  it("repaints only the row a frame changed", async () => {
    renderedPids.length = 0;
    const onKill = vi.fn();
    // Callers rebuild the kill object on every frame.
    const kill = (): Kill => ({ canKill: () => true, signalingKeys: new Set(), onKill });
    const first = [row(1, 30), row(2, 20), row(3, 10)];
    await using screen = await render(table(first, kill()), { router: false }); // no links
    await expect.element(screen.getByText("10%")).toBeVisible();
    renderedPids.length = 0;

    const next = [first[0]!, row(2, 25), first[2]!];
    await screen.rerender(table(next, kill()));
    await expect.element(screen.getByText("25%")).toBeVisible();

    expect(new Set(renderedPids)).toEqual(new Set([2]));
  });

  it("offers Kill only on rows it may signal and disables it while signalling", async () => {
    const onKill = vi.fn();
    const rows = [row(1, 30), row(2, 20)];
    const canKill = (process: Row) => process.pid !== 1;
    await using screen = await render(table(rows, { canKill, signalingKeys: new Set(), onKill }), {
      router: false, // no links
    });
    const killTwo = screen.getByRole("button", { name: "Kill p2 (PID 2)" });
    await expect.element(killTwo).toBeEnabled();
    expect(screen.getByRole("button", { name: "Kill p1 (PID 1)" }).query()).toBeNull();

    await killTwo.click();
    expect(onKill).toHaveBeenCalledExactlyOnceWith(rows[1]);

    await screen.rerender(table(rows, { canKill, signalingKeys: new Set(["2:2000"]), onKill }));
    await expect.element(killTwo).toBeDisabled();
  });

  it("shows no Kill without a kill handler", async () => {
    await using screen = await render(table([row(1, 30)]), { router: false }); // no links
    await expect.element(screen.getByText("30%")).toBeVisible();
    expect(screen.getByRole("button", { name: /^Kill / }).query()).toBeNull();
  });
});
