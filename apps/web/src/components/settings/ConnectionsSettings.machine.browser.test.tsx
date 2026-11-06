import { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render, stubGlobal } from "../../../test/render";

interface FakeEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl: string;
  readonly entry: { readonly enabled: boolean; readonly target: unknown };
  readonly connection: { readonly phase: string };
  readonly serverConfig: unknown;
}

const state = vi.hoisted(() => ({
  environments: [] as FakeEnvironment[],
  primaryId: null as string | null,
  scopes: new Set<string>(),
}));

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: state.environments })) as never,
  useEnvironment: ((id: string | null) =>
    state.environments.find((environment) => environment.environmentId === id) ?? null) as never,
  usePrimaryEnvironment: (() =>
    state.environments.find((environment) => environment.environmentId === state.primaryId) ??
    null) as never,
  usePrimaryEnvironmentId: (() => state.primaryId) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((_id: unknown, scope: string) => state.scopes.has(scope)) as never,
  readEnvironmentScope: ((_id: unknown, scope: string) => state.scopes.has(scope)) as never,
  useEnvironmentSessionState: (() => ({ data: null, error: null, isPending: false })) as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    error: null,
    isPending: false,
    refresh: () => {},
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const idle = { status: "idle" };
  const updateStates = Atom.make(Array.from({ length: 16 }, () => idle));
  const updateState = Atom.make(idle);
  return {
    ...actual,
    environmentUpdateStatesAtom: (() => updateStates) as never,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateStateAtom: (() => updateState) as never,
    } as never,
  };
});
vi.mock(import("~/state/desktopUpdate"), async (original) => ({
  ...(await original()),
  useDesktopUpdateState: (() => null) as never,
}));
vi.mock(import("~/state/peerLinks"), async (original) => ({
  ...(await original()),
  usePeerLinkHosts: (() => []) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => <div>{children}</div>) as never,
  SettingsSection: (({
    title,
    headerAction,
    children,
  }: {
    title: string;
    headerAction?: ReactNode;
    children: ReactNode;
  }) => (
    <section aria-label={title}>
      <header data-testid="section-header">{headerAction}</header>
      {children}
    </section>
  )) as never,
  SettingsRow: (({
    title,
    control,
    children,
  }: {
    title: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div data-testid="row">
      <h4>{title}</h4>
      {control}
      {children}
    </div>
  )) as never,
}));
vi.mock(import("./MachineResourcesSection"), async (original) => ({
  ...(await original()),
  MachineResourcesSection: (({ environmentId }: { environmentId: string }) => (
    <div data-testid="machine-editor" data-environment-id={environmentId} />
  )) as never,
}));
vi.mock(import("../EnvironmentMachineIcon"), () => ({
  EnvironmentMachineIcon: () => <svg />,
}));
vi.mock(import("./EnvironmentIconPicker"), () => ({ EnvironmentIconMenu: (() => null) as never }));
vi.mock(import("./SessionPermissions"), () => ({ SessionPermissions: (() => null) as never }));
vi.mock(import("./SavedEnvironmentRows"), async (original) => ({
  ...(await original()),
  CloudLinkRow: (() => null) as never,
  CloudRemoteEnvironmentRows: (() => null) as never,
  SavedBackendListRow: (() => null) as never,
}));

import { ConnectionsSettings } from "./ConnectionsSettings";

const PRIMARY = EnvironmentId.make("primary");
const REMOTE = EnvironmentId.make("remote");
const WSL = EnvironmentId.make("wsl");

function environment(
  environmentId: EnvironmentId,
  label: string,
  target: unknown,
  capable: boolean,
): FakeEnvironment {
  return {
    environmentId,
    label,
    displayUrl: `http://${environmentId}.test`,
    entry: { enabled: true, target },
    connection: { phase: "connected" },
    serverConfig: {
      environment: {
        capabilities: { machineResources: capable },
        platform: { os: "linux", machine: "server" },
      },
    },
  };
}

const primaryTarget = { _tag: "PrimaryConnectionTarget" };
const remoteTarget = { _tag: "BearerConnectionTarget", connectionId: "saved:remote" };
const localTarget = (backendId: string) => ({
  _tag: "BearerConnectionTarget",
  connectionId: `local:${backendId}`,
});

function setup({
  environments,
  scopes = [],
}: {
  environments: FakeEnvironment[];
  scopes?: string[];
}) {
  state.environments = environments;
  state.primaryId = PRIMARY;
  state.scopes = new Set(scopes);
}

const gear = (label: string) => page.getByRole("button", { name: `Machine settings for ${label}` });
const editors = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-testid="machine-editor"]')].map((element) =>
    element.getAttribute("data-environment-id"),
  );

describe("ConnectionsSettings machine thresholds on the access view", () => {
  it("opens one editor from the gear of a capable primary", async () => {
    setup({ environments: [environment(PRIMARY, "Desk", primaryTarget, true)] });
    await using screen = await render(<ConnectionsSettings view="access" />);

    await expect.element(gear("Desk")).toHaveAttribute("aria-expanded", "false");
    expect(editors(screen.container)).toEqual([]);
    await userEvent.click(gear("Desk"));

    await expect.element(gear("Desk")).toHaveAttribute("aria-expanded", "true");
    expect(editors(screen.container)).toEqual([PRIMARY]);
  });

  it("shows no gear for a primary without the capability", async () => {
    setup({ environments: [environment(PRIMARY, "Desk", primaryTarget, false)] });
    await using screen = await render(<ConnectionsSettings view="access" />);

    await expect
      .element(screen.getByRole("button", { name: "More actions for this machine" }))
      .toBeVisible();
    expect(screen.getByRole("button", { name: /^Machine settings for/ }).query()).toBeNull();
  });

  it("shows no header gear after picking a remote saved machine", async () => {
    setup({
      environments: [
        environment(PRIMARY, "Desk", primaryTarget, true),
        environment(REMOTE, "Box", remoteTarget, true),
      ],
    });
    await using screen = await render(<ConnectionsSettings view="access" />);
    await expect.element(gear("Desk")).toBeVisible();

    await userEvent.click(screen.getByRole("combobox", { name: "Environment" }));
    await userEvent.click(page.getByRole("option", { name: "Box" }));

    await expect.element(screen.getByRole("region", { name: "Box" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^Machine settings for/ }).query()).toBeNull();
  });

  it("gives a desktop-local backend with its own id one row and its own gear", async () => {
    using _bridge = stubGlobal("desktopBridge", { getLocalEnvironmentEnabled: () => true });
    setup({
      environments: [
        environment(PRIMARY, "Desk", primaryTarget, true),
        environment(WSL, "Ubuntu (WSL)", localTarget("wsl"), true),
      ],
      scopes: ["environment:maintain"],
    });
    await using screen = await render(<ConnectionsSettings view="access" />);

    await expect.element(gear("Ubuntu (WSL)")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Ubuntu (WSL)" }).all()).toHaveLength(1);
    await userEvent.click(gear("Ubuntu (WSL)"));

    expect(editors(screen.container)).toEqual([WSL]);
    await expect.element(gear("Desk")).toHaveAttribute("aria-expanded", "false");
  });

  it("adds no extra row for a desktop-local backend sharing the primary id", async () => {
    using _bridge = stubGlobal("desktopBridge", { getLocalEnvironmentEnabled: () => true });
    setup({
      environments: [
        environment(PRIMARY, "Desk", primaryTarget, true),
        environment(PRIMARY, "Desk (local)", localTarget("default"), true),
      ],
      scopes: ["environment:maintain"],
    });
    await using screen = await render(<ConnectionsSettings view="access" />);

    await expect.element(gear("Desk")).toBeVisible();
    expect(screen.getByRole("button", { name: /^Machine settings for/ }).all()).toHaveLength(1);
  });
});
