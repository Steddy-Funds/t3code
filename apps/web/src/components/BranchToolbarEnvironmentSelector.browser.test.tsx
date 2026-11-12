import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import type { MachineIndicator } from "@t3tools/client-runtime/state/machineIndicator";
import { EnvironmentId } from "@t3tools/contracts";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import type { EnvironmentOption } from "./BranchToolbar.logic";

const state = vi.hoisted(() => ({ stressed: new Set<string>() }));

vi.mock(import("~/state/machineResources"), async () => {
  const { Atom } = await import("effect/reactivity");
  const atoms = new Map<string, Atom.Atom<MachineIndicator>>();
  return {
    machineIndicator: {
      machineIndicatorAtom: (environmentId: string) => {
        let atom = atoms.get(environmentId);
        if (!atom) {
          atom = Atom.make((): MachineIndicator => ({
            show: true,
            verdict: state.stressed.has(environmentId) ? "stressed" : "ok",
            unreachable: false,
            lastSeen: null,
            reason: null,
          }));
          atoms.set(environmentId, atom);
        }
        return atom;
      },
    } as never,
    machineResources: {} as never,
  };
});
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make([]) as never };
});

import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";

const option = (id: string, label: string): EnvironmentOption => ({
  environmentId: EnvironmentId.make(id),
  projectId: null,
  label,
  isPrimary: id === "alpha",
  machine: "server",
});
const ENVIRONMENTS = [option("alpha", "Alpha"), option("beta", "Beta"), option("gamma", "Gamma")];

describe("BranchToolbarEnvironmentSelector", () => {
  it("keeps machines in name order with one stressed, and the stressed one stays selectable", async () => {
    state.stressed = new Set(["beta"]);
    const onEnvironmentChange = vi.fn();
    await using screen = await render(
      <RegistryContext value={AtomRegistry.make()}>
        <BranchToolbarEnvironmentSelector
          envLocked={false}
          environmentId={EnvironmentId.make("alpha")}
          availableEnvironments={ENVIRONMENTS}
          onEnvironmentChange={onEnvironmentChange}
        />
      </RegistryContext>,
    );

    await userEvent.click(screen.getByRole("combobox", { name: "Run on" }));
    const options = page.getByRole("option");
    await expect.element(options.first()).toBeVisible();
    expect(options.all().map((item) => item.element().textContent)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    const beta = page.getByRole("option", { name: "Beta" });
    expect(beta.element().querySelector('svg[data-machine-icon="stressed"]')).not.toBeNull();
    await expect.element(beta).not.toHaveAttribute("aria-disabled", "true");

    await userEvent.click(beta);

    expect(onEnvironmentChange).toHaveBeenCalledExactlyOnceWith("beta");
  });
});
