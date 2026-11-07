import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useTaskManagerPreferences } from "./taskManagerPreferences";

const KEY = "t3code:task-manager-preferences:v1";

function Preferences() {
  const { tick, viewMode, rangeMs, setTick, setViewMode, setRange } = useTaskManagerPreferences();
  return (
    <>
      <output>{`${tick} ${viewMode} ${rangeMs}`}</output>
      <button type="button" onClick={() => setTick(5000)}>
        Tick 5 s
      </button>
      <button type="button" onClick={() => setViewMode("tree")}>
        Tree
      </button>
      <button type="button" onClick={() => setRange(3_600_000)}>
        1 h
      </button>
    </>
  );
}

/** Seeds the saved value for one test and removes it afterwards. */
function saved(value: string | null): Disposable {
  if (value === null) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, value);
  return { [Symbol.dispose]: () => localStorage.removeItem(KEY) };
}

const readSaved = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as unknown;

describe("useTaskManagerPreferences", () => {
  it.each([
    { label: "nothing saved", value: null },
    { label: "a corrupt value", value: "{not json" },
    { label: "a tick outside the picker", value: JSON.stringify({ tick: 750, viewMode: "tree" }) },
    { label: "an unknown view mode", value: JSON.stringify({ tick: 2000, viewMode: "flat" }) },
    { label: "a missing field", value: JSON.stringify({ tick: 2000 }) },
    {
      label: "a range outside the picker",
      value: JSON.stringify({ tick: 2000, viewMode: "tree", rangeMs: 1_800_000 }),
    },
  ])("falls back to 1 s, raw and 15 min with $label", async ({ value }) => {
    using _saved = saved(value);
    using _errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await using screen = await render(<Preferences />, { router: false }); // no links
    await expect.element(screen.getByRole("status")).toHaveTextContent("1000 raw 900000");
  });

  it.each([500, 1000, 2000, 5000])("restores a saved %i ms tick", async (tick) => {
    using _saved = saved(JSON.stringify({ tick, viewMode: "grouped" }));
    await using screen = await render(<Preferences />, { router: false }); // no links
    await expect.element(screen.getByRole("status")).toHaveTextContent(`${tick} grouped 900000`);
  });

  it("restores a saved 1 h range", async () => {
    using _saved = saved(JSON.stringify({ tick: 500, viewMode: "tree", rangeMs: 3_600_000 }));
    await using screen = await render(<Preferences />, { router: false }); // no links
    await expect.element(screen.getByRole("status")).toHaveTextContent("500 tree 3600000");
  });

  it("saves each setting without touching the other", async () => {
    using _saved = saved(JSON.stringify({ tick: 2000, viewMode: "grouped" }));
    await using screen = await render(<Preferences />, { router: false }); // no links
    const output = screen.getByRole("status");

    await screen.getByRole("button", { name: "Tick 5 s" }).click();
    await expect.element(output).toHaveTextContent("5000 grouped 900000");
    expect(readSaved()).toEqual({ tick: 5000, viewMode: "grouped", rangeMs: 900_000 });

    await screen.getByRole("button", { name: "Tree" }).click();
    await expect.element(output).toHaveTextContent("5000 tree 900000");
    expect(readSaved()).toEqual({ tick: 5000, viewMode: "tree", rangeMs: 900_000 });

    await screen.getByRole("button", { name: "1 h" }).click();
    await expect.element(output).toHaveTextContent("5000 tree 3600000");
    expect(readSaved()).toEqual({ tick: 5000, viewMode: "tree", rangeMs: 3_600_000 });
  });
});
