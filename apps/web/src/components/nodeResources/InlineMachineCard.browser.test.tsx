import "~/index.css";

import { EnvironmentId } from "@t3tools/contracts";
import type { MachineCardSnapshot } from "@t3tools/shared/toolOutput";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  environment: null as { label: string; serverConfig: null } | null,
  /** Intersection callbacks of the cards currently observed. */
  observers: new Set<(entry: { isIntersecting: boolean }) => void>(),
}));

function setup(environment: typeof state.environment) {
  state.environment = environment;
  state.observers.clear();
}

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => state.environment) as never,
}));
vi.mock(import("~/lib/observeIntersection"), () => ({
  observeIntersection: ((
    _element: Element,
    callback: (entry: IntersectionObserverEntry) => void,
  ) => {
    const observer = callback as never;
    state.observers.add(observer);
    return () => state.observers.delete(observer);
  }) as never,
}));
vi.mock(import("./MachineHoverCard"), () => ({
  MachineHoverCard: (() => <div>Live machine</div>) as never,
}));

import { InlineMachineCard, type InlineMachineCardProps } from "./InlineMachineCard";

const snapshot: MachineCardSnapshot = {
  verdict: "stressed",
  reason: { rule: "cpu", value: 97, threshold: 90, heldForMs: 60_000 },
  totals: null,
};

const props = (overrides: Partial<InlineMachineCardProps> = {}): InlineMachineCardProps => ({
  environmentId: EnvironmentId.make("environment:mac"),
  snapshot,
  capturedAt: "2026-11-08T00:00:00.000Z",
  timestampFormat: "locale",
  current: true,
  guest: false,
  ...overrides,
});

const scroll = (isIntersecting: boolean) =>
  act(() => {
    for (const observer of state.observers) observer({ isIntersecting });
  });

describe("InlineMachineCard", () => {
  it("goes live only while the current turn's card is on screen", async () => {
    setup({ label: "Studio", serverConfig: null });
    await using screen = await render(<InlineMachineCard {...props()} />);
    await expect.element(screen.getByText("Studio")).toBeVisible();
    expect(screen.getByText("Live machine").query()).toBeNull();
    expect(state.observers.size).toBe(1);

    await scroll(true);
    await expect.element(screen.getByText("Live machine")).toBeVisible();
    await expect.element(screen.getByText("Live", { exact: true })).toBeVisible();

    await scroll(false);
    await expect.element(screen.getByText("Studio")).toBeVisible();
    expect(screen.getByText("Live machine").query()).toBeNull();
    await expect.element(screen.getByRole("link", { name: /Task manager/ })).toBeVisible();
  });

  it("stays a snapshot in history without watching the viewport", async () => {
    setup({ label: "Studio", serverConfig: null });
    await using screen = await render(<InlineMachineCard {...props({ current: false })} />);
    await expect.element(screen.getByText("Studio")).toBeVisible();
    expect(state.observers.size).toBe(0);
    expect(screen.getByText("Live machine").query()).toBeNull();
    await expect.element(screen.getByRole("link", { name: /Task manager/ })).toBeVisible();
  });

  it("shows a guest the snapshot, with no live view or task manager link", async () => {
    setup({ label: "Studio", serverConfig: null });
    await using screen = await render(<InlineMachineCard {...props({ guest: true })} />);
    await expect.element(screen.getByText("Machine", { exact: true })).toBeVisible();
    await scroll(true);
    expect(state.observers.size).toBe(0);
    expect(screen.getByText("Live machine").query()).toBeNull();
    expect(screen.getByText("Studio").query()).toBeNull();
    expect(screen.getByText("Machine not connected").query()).toBeNull();
    expect(screen.getByRole("link").query()).toBeNull();
  });

  it("says the machine is not connected when the client does not know it", async () => {
    setup(null);
    await using screen = await render(<InlineMachineCard {...props()} />);
    await expect.element(screen.getByText("Machine not connected")).toBeVisible();
    await scroll(true);
    expect(screen.getByText("Live machine").query()).toBeNull();
    expect(screen.getByRole("link").query()).toBeNull();
  });

  it("keeps a card whose snapshot was pruned, without a body", async () => {
    setup({ label: "Studio", serverConfig: null });
    await using screen = await render(
      <InlineMachineCard {...props({ current: false, snapshot: undefined })} />,
    );
    await expect.element(screen.getByText("Studio")).toBeVisible();
    await expect.element(screen.getByText(/as of/)).toBeVisible();
  });
});
