import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import type { MachineIndicator } from "@t3tools/client-runtime/state/machineIndicator";
import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../../test/render";
import type { TaskManagerRange, TaskManagerTick } from "../taskManagerPreferences";

const state = vi.hoisted(() => ({ indicator: null as unknown as MachineIndicator }));

vi.mock(import("~/state/machineResources"), async () => {
  const { Atom } = await import("effect/reactivity");
  const indicator = Atom.make(() => state.indicator);
  return {
    machineIndicator: { machineIndicatorAtom: () => indicator } as never,
    machineResources: {} as never,
  };
});
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentMachines: (() => new Map()) as never,
}));

import { TaskManagerHeader } from "./TaskManagerHeader";

const environmentId = EnvironmentId.make("machine-a");

function setup(indicator: Partial<MachineIndicator> = {}) {
  state.indicator = {
    show: true,
    verdict: "ok",
    unreachable: false,
    lastSeen: null,
    reason: null,
    ...indicator,
  };
}

function renderHeader({
  tick = 1000,
  onTickChange = vi.fn(),
  onRangeChange = vi.fn(),
  onOpenTerminal,
}: {
  tick?: TaskManagerTick;
  onTickChange?: (tick: TaskManagerTick) => void;
  onRangeChange?: (range: TaskManagerRange) => void;
  onOpenTerminal?: () => void;
} = {}) {
  return render(
    <RegistryContext value={AtomRegistry.make()}>
      <TaskManagerHeader
        environmentId={environmentId}
        label="Studio"
        tick={tick}
        onTickChange={onTickChange}
        range={900_000}
        onRangeChange={onRangeChange}
        {...(onOpenTerminal ? { onOpenTerminal } : {})}
      />
    </RegistryContext>,
  );
}

const VERDICT_TEXT = /Stressed|No sample yet|Unreachable/;

describe("TaskManagerHeader", () => {
  it("shows no verdict text while the machine is ok", async () => {
    setup();
    await using screen = await renderHeader();
    await expect.element(screen.getByRole("heading", { name: "Studio" })).toBeVisible();
    expect(screen.getByText(VERDICT_TEXT).query()).toBeNull();
  });

  it.each([
    {
      label: "stressed",
      indicator: {
        verdict: "stressed",
        reason: { rule: "load", value: 20, threshold: 12.5, heldForMs: 60_000 },
      },
      text: "Stressed: load 20.0 / 12.5 per core, 1 m",
    },
    { label: "unknown", indicator: { verdict: "unknown" }, text: "No sample yet" },
    {
      label: "unreachable",
      indicator: {
        verdict: "unknown",
        unreachable: true,
        lastSeen: { verdict: "stressed", ageMs: 120_000 },
      },
      text: "Unreachable, last seen stressed 2 m ago",
    },
  ] as const)("says why when the machine is $label", async ({ indicator, text }) => {
    setup(indicator);
    await using screen = await renderHeader();
    await expect.element(screen.getByText(text, { exact: true })).toBeVisible();
  });

  it("picks 1 s by default and reports a new tick", async () => {
    setup();
    const onTickChange = vi.fn();
    await using screen = await renderHeader({ onTickChange });
    const oneSecond = screen.getByRole("button", { name: "1 s" });
    await expect.element(oneSecond).toHaveAttribute("aria-pressed", "true");

    // Pressing the selected tick would empty the group; nothing is reported.
    await oneSecond.click();
    expect(onTickChange).not.toHaveBeenCalled();

    await screen.getByRole("button", { name: "2 s" }).click();
    expect(onTickChange).toHaveBeenCalledExactlyOnceWith(2000);
  });

  it("picks 15 min by default and reports a new range", async () => {
    setup();
    const onRangeChange = vi.fn();
    await using screen = await renderHeader({ onRangeChange });
    const fifteen = screen.getByRole("button", { name: "15 min" });
    await expect.element(fifteen).toHaveAttribute("aria-pressed", "true");
    await expect
      .element(screen.getByRole("button", { name: "1 h" }))
      .toHaveAttribute("aria-pressed", "false");

    await fifteen.click();
    expect(onRangeChange).not.toHaveBeenCalled();

    await screen.getByRole("button", { name: "1 h" }).click();
    expect(onRangeChange).toHaveBeenCalledExactlyOnceWith(3_600_000);
  });

  it("offers Open terminal only when the terminal can open", async () => {
    setup();
    await using screen = await renderHeader();
    await expect.element(screen.getByRole("button", { name: "1 s" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open terminal" }).query()).toBeNull();

    const onOpenTerminal = vi.fn();
    await screen.rerender(
      <RegistryContext value={AtomRegistry.make()}>
        <TaskManagerHeader
          environmentId={environmentId}
          label="Studio"
          tick={1000}
          onTickChange={vi.fn()}
          range={900_000}
          onRangeChange={vi.fn()}
          onOpenTerminal={onOpenTerminal}
        />
      </RegistryContext>,
    );
    await screen.getByRole("button", { name: "Open terminal" }).click();
    expect(onOpenTerminal).toHaveBeenCalledOnce();
  });
});
