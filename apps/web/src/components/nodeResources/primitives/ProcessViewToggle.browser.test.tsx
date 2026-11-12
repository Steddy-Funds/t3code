import "~/index.css";

import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../../test/render";
import { type ProcessViewMode, ProcessViewToggle } from "./ProcessViewToggle";

function StatefulToggle({
  initial,
  onValueChange,
}: {
  readonly initial: ProcessViewMode;
  readonly onValueChange: (mode: ProcessViewMode) => void;
}) {
  const [mode, setMode] = useState(initial);
  return (
    <ProcessViewToggle
      value={mode}
      onValueChange={(next) => {
        onValueChange(next);
        setMode(next);
      }}
    />
  );
}

describe("ProcessViewToggle", () => {
  it("switches modes and always keeps one selected", async () => {
    const onValueChange = vi.fn();
    await using screen = await render(
      <StatefulToggle initial="raw" onValueChange={onValueChange} />,
      { router: false }, // no links
    );
    const raw = screen.getByRole("button", { name: "Raw" });
    const tree = screen.getByRole("button", { name: "Tree" });
    const grouped = screen.getByRole("button", { name: "Grouped" });
    await expect.element(raw).toHaveAttribute("aria-pressed", "true");

    await tree.click();
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith("tree");
    await expect.element(tree).toHaveAttribute("aria-pressed", "true");
    await expect.element(raw).toHaveAttribute("aria-pressed", "false");

    // Pressing the selected mode would empty the group; nothing is emitted and it stays selected.
    await tree.click();
    expect(onValueChange).toHaveBeenCalledOnce();
    await expect.element(tree).toHaveAttribute("aria-pressed", "true");

    await grouped.click();
    expect(onValueChange).toHaveBeenLastCalledWith("grouped");
    await expect.element(grouped).toHaveAttribute("aria-pressed", "true");
    await expect.element(tree).toHaveAttribute("aria-pressed", "false");
  });

  it("follows the controlled value", async () => {
    const onValueChange = vi.fn();
    await using screen = await render(
      <ProcessViewToggle value="raw" onValueChange={onValueChange} />,
      { router: false }, // no links
    );
    await screen.rerender(<ProcessViewToggle value="grouped" onValueChange={onValueChange} />);
    await expect
      .element(screen.getByRole("button", { name: "Grouped" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(onValueChange).not.toHaveBeenCalled();
  });
});
