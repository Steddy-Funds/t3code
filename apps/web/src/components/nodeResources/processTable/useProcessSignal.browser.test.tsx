import "~/index.css";

import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import type { ProcessSignalTarget } from "./ProcessKillDialog";

interface Config {
  readonly environment: {
    readonly platform: { readonly os: "linux" | "darwin" | "windows" };
    readonly capabilities: { readonly processSigterm: boolean };
  };
}

const state = vi.hoisted(() => ({
  permission: null as unknown as Atom.Writable<boolean>,
  config: null as unknown as Atom.Writable<Config | null>,
  send: (() => Promise.resolve()) as (input: unknown) => Promise<unknown>,
  toast: (_toast: unknown): string => "toast-1",
}));

vi.mock(import("~/state/server"), () => ({
  serverEnvironment: {
    signalProcess: { permissionAtom: () => state.permission },
    configValueAtom: () => state.config,
  } as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => (input: unknown) => state.send(input)) as never,
}));
vi.mock(import("~/components/ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: ((toast: unknown) => state.toast(toast)) as never,
    },
  };
});

import { useProcessSignal } from "./useProcessSignal";

const environmentId = EnvironmentId.make("machine-a");
const TARGET: ProcessSignalTarget = {
  pid: 42,
  startTimeMs: 7_000,
  name: "vite",
  command: "node vite",
};
const TARGET_KEY = "42:7000";

type Reply =
  | { readonly signaled: boolean; readonly message: string | null }
  | AsyncResult.AsyncResult<unknown, unknown>;

const reply = (signaled: boolean, message: string | null = null) =>
  AsyncResult.success({ signaled, message: Option.fromNullishOr(message) });

function setup({
  permission = true,
  config = { environment: { platform: { os: "linux" }, capabilities: { processSigterm: true } } },
}: { permission?: boolean; config?: Config | null } = {}) {
  state.permission = Atom.make(permission);
  state.config = Atom.make<Config | null>(config);
  const send = vi.fn<(input: unknown) => Promise<unknown>>();
  const pending: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  send.mockImplementation(
    () => new Promise((resolve, reject) => void pending.push({ resolve, reject })),
  );
  state.send = send;
  const toast = vi.fn((_toast: unknown) => "toast-1");
  state.toast = toast;
  const respond = async (value: Reply | Error) => {
    const deferred = pending.shift();
    if (!deferred) throw new Error("no signal in flight");
    if (value instanceof Error) deferred.reject(value);
    else deferred.resolve("_tag" in value ? value : reply(value.signaled, value.message));
    await vi.waitFor(() => expect(signalingText()).toBe(""));
  };
  return { send, toast, respond, onSignaled: vi.fn(), registry: AtomRegistry.make() };
}

function Harness({ onSignaled }: { readonly onSignaled: () => void }) {
  const signal = useProcessSignal(environmentId, { onSignaled });
  return (
    <>
      <output>{signal.canSignal ? "can signal" : "cannot signal"}</output>
      <span data-signaling>{[...signal.signalingKeys].join(",")}</span>
      <button type="button" onClick={() => signal.requestKill(TARGET)}>
        Request kill
      </button>
      {signal.dialog}
    </>
  );
}

// The open dialog is modal and hides the page from role queries, so read the harness directly.
const signalingText = () => document.querySelector("[data-signaling]")?.textContent;
const requestAgain = () =>
  [...document.querySelectorAll("button")]
    .find((button) => button.textContent === "Request kill")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

function renderHarness({
  registry,
  onSignaled,
}: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly onSignaled: () => void;
}) {
  return render(
    <RegistryContext value={registry}>
      <Harness onSignaled={onSignaled} />
    </RegistryContext>,
    { router: false }, // no links
  );
}

const dialog = () => page.getByRole("alertdialog");
const killButton = () => dialog().getByRole("button", { name: "Kill", exact: true });
const forceKillButton = () => dialog().getByRole("button", { name: "Force kill" });

async function openDialog(screen: Awaited<ReturnType<typeof renderHarness>>) {
  await screen.getByRole("button", { name: "Request kill" }).click();
  await expect.element(killButton()).toBeEnabled();
}

describe("useProcessSignal", () => {
  it("does nothing without permission", async () => {
    const harness = setup({ permission: false });
    const { send } = harness;
    await using screen = await renderHarness(harness);
    await expect.element(screen.getByRole("status")).toHaveTextContent("cannot signal");

    await screen.getByRole("button", { name: "Request kill" }).click();

    expect(dialog().query()).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { label: "SIGTERM-capable servers", config: undefined, signal: "SIGTERM", force: true },
    {
      label: "older servers",
      config: {
        environment: { platform: { os: "linux" }, capabilities: { processSigterm: false } },
      },
      signal: "SIGINT",
      force: true,
    },
    {
      label: "Windows",
      config: {
        environment: { platform: { os: "windows" }, capabilities: { processSigterm: true } },
      },
      signal: "SIGKILL",
      force: false,
    },
    { label: "an unknown platform", config: null, signal: "SIGINT", force: true },
  ] as const)("Kill sends the first choice on $label", async ({ config, signal, force }) => {
    const harness = setup(config === undefined ? {} : { config });
    const { send, respond } = harness;
    await using screen = await renderHarness(harness);
    await openDialog(screen);
    if (force) await expect.element(forceKillButton()).toBeEnabled();
    else expect(forceKillButton().query()).toBeNull();

    await killButton().click();

    expect(send).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { pid: 42, startTimeMs: 7_000, signal },
    });
    await respond({ signaled: true, message: null });
  });

  it("Force kill sends SIGKILL", async () => {
    const harness = setup();
    const { send, respond } = harness;
    await using screen = await renderHarness(harness);
    await openDialog(screen);

    await forceKillButton().click();

    expect(send).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { pid: 42, startTimeMs: 7_000, signal: "SIGKILL" },
    });
    await respond({ signaled: true, message: null });
  });

  it("closes and reports a signalled process", async () => {
    const harness = setup();
    const { toast, respond } = harness;
    await using screen = await renderHarness(harness);
    await openDialog(screen);

    await killButton().click();
    await expect.element(killButton()).toBeDisabled();
    expect(signalingText()).toBe(TARGET_KEY);
    await respond({ signaled: true, message: null });

    await expect.element(dialog()).not.toBeInTheDocument();
    expect(harness.onSignaled).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();
  });

  it("sends nothing when permission is lost between confirm and send", async () => {
    const harness = setup();
    const { send } = harness;
    await using screen = await renderHarness(harness);
    await openDialog(screen);

    harness.registry.set(state.permission, false);
    await killButton().click();

    await expect.element(dialog()).not.toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores a second request for a process already being signalled", async () => {
    const harness = setup();
    const { send, respond } = harness;
    await using screen = await renderHarness(harness);
    await openDialog(screen);
    await killButton().click();
    await expect.element(killButton()).toBeDisabled();

    requestAgain();

    // A new request would reset the dialog to confirm and enable Kill again.
    await expect.element(killButton()).toBeDisabled();
    expect(send).toHaveBeenCalledOnce();
    await respond({ signaled: true, message: null });
  });

  it("says the process changed and sends nothing more", async () => {
    const harness = setup();
    const { send, toast, respond } = harness;
    await using screen = await renderHarness(harness);
    await openDialog(screen);
    await killButton().click();

    await respond({ signaled: false, message: "Process 42 no longer matches its start time" });

    await expect.element(dialog().getByText("Process changed")).toBeVisible();
    await expect.element(dialog().getByText(/Nothing was sent/)).toBeVisible();
    expect(killButton().query()).toBeNull();
    expect(harness.onSignaled).toHaveBeenCalledOnce();
    expect(toast).not.toHaveBeenCalled();

    await dialog().getByRole("button", { name: "Close" }).click();
    await expect.element(dialog()).not.toBeInTheDocument();
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "a refusal",
      value: { signaled: false, message: "Operation not permitted" },
      description: "Operation not permitted",
      signaled: true,
    },
    {
      label: "a stale-identity refusal",
      value: { signaled: false, message: "Refusing to signal a stale identity" },
      description: "Refusing to signal a stale identity",
      signaled: true,
    },
    {
      label: "a refusal without a message",
      value: { signaled: false, message: null },
      description: "Failed to send SIGTERM to process 42.",
      signaled: true,
    },
    {
      label: "a failed command",
      value: AsyncResult.failure(Cause.fail(new Error("socket closed"))),
      description: "socket closed",
      signaled: false,
    },
    {
      label: "a rejected send",
      value: new Error("transport gone"),
      description: "transport gone",
      signaled: false,
    },
  ])("turns $label into a toast", async ({ value, description, signaled }) => {
    const harness = setup();
    const { toast, respond } = harness;
    await using screen = await renderHarness(harness);
    await openDialog(screen);
    await killButton().click();

    await respond(value);

    await expect.element(dialog()).not.toBeInTheDocument();
    expect(toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not send SIGTERM",
      description,
    });
    expect(harness.onSignaled).toHaveBeenCalledTimes(signaled ? 1 : 0);
  });

  it("closes quietly when the send is interrupted", async () => {
    const harness = setup();
    const { toast, respond } = harness;
    await using screen = await renderHarness(harness);
    await openDialog(screen);
    await killButton().click();

    await respond(AsyncResult.failure(Cause.interrupt()));

    await expect.element(dialog()).not.toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });
});
