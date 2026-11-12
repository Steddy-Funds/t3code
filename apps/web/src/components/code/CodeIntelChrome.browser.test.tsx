import { EnvironmentId, type CodeServerStatus } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

type Outcome = { readonly _tag: "Success" | "Failure" };

const mocks = vi.hoisted(() => ({
  canWrite: true,
  canRestart: true,
  order: [] as string[],
  updateSettings: vi.fn<(request: unknown) => Promise<Outcome>>(),
  restart: vi.fn<(request: unknown) => Promise<Outcome>>(),
  install: vi.fn<(request: unknown) => Promise<Outcome>>(),
}));

const GRANTED = Atom.make(true);
const DENIED = Atom.make(false);
let settings = Atom.make({ codeIntel: { pythonEnvironments: {} as Record<string, string> } });

// Each command hook hands back its own spy, so a test sees which of them the chip ran.
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: ((command: { spy: unknown }) => command.spy) as never,
}));
vi.mock(import("~/state/codeIntel"), () => ({
  codeIntelEnvironment: {
    restart: { spy: mocks.restart, permissionAtom: () => (mocks.canRestart ? GRANTED : DENIED) },
    installServer: { spy: mocks.install, permissionAtom: () => GRANTED },
  } as never,
}));
vi.mock(import("~/state/server"), async (original) => ({
  ...(await original()),
  serverEnvironment: {
    updateSettings: { spy: mocks.updateSettings },
    settingsValueAtom: () => settings,
  } as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => mocks.canWrite,
}));

import { CodeIntelStatusChip } from "./CodeIntelChrome";

const environmentId = EnvironmentId.make("env-chip");
const CWD = "/work/shop";
const VENV = "/work/shop/.venv";

function server(languageId: string, name: string): CodeServerStatus {
  return { languageId, name, state: "ready", libraryRoots: [] };
}

function setup(saved: Record<string, string> = {}) {
  mocks.canWrite = true;
  mocks.canRestart = true;
  mocks.order.length = 0;
  settings = Atom.make({ codeIntel: { pythonEnvironments: saved } });
  mocks.updateSettings.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.restart.mockReset().mockImplementation(async () => {
    mocks.order.push("restart");
    return { _tag: "Success" };
  });
}

type ChipOptions = { server?: CodeServerStatus; turnedOff?: boolean };

function chip(options: ChipOptions, onChanged: () => void) {
  return (
    <CodeIntelStatusChip
      environmentId={environmentId}
      cwd={CWD}
      server={options.server ?? server("python", "ty")}
      turnedOff={options.turnedOff ?? false}
      onChanged={onChanged}
    />
  );
}

async function mount(options: ChipOptions = {}) {
  const onChanged = vi.fn(() => mocks.order.push("changed"));
  const screen = await render(chip(options, onChanged));
  await page.getByRole("button", { name: new RegExp(`^${options.server?.name ?? "ty"}`) }).click();
  return { screen, onChanged };
}

const field = () => page.getByLabelText("Python environment");
const apply = () => page.getByRole("button", { name: /^Appl/ });
const patch = (environment: string) => ({
  environmentId,
  input: { patch: { codeIntel: { pythonEnvironments: { [CWD]: environment } } } },
});

describe("the Python environment field in the code-intel chip", () => {
  it("saves the trimmed value for this workspace, restarts once it is saved, then reports", async () => {
    setup();
    let finishSave: (outcome: Outcome) => void = () => {};
    mocks.updateSettings.mockImplementation(
      () => new Promise<Outcome>((resolve) => (finishSave = resolve)),
    );
    const { screen, onChanged } = await mount();
    await using _screen = screen;
    await userEvent.fill(field(), `  ${VENV}  `);

    await apply().click();

    await vi.waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledTimes(1));
    expect(mocks.updateSettings).toHaveBeenCalledWith(patch(VENV));
    // A restart before the save lands would start the server on the old environment.
    expect(mocks.restart).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: "Applying…" })).toBeDisabled();

    finishSave({ _tag: "Success" });
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mocks.restart).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { cwd: CWD, languageId: "python" },
    });
    expect(mocks.order).toEqual(["restart", "changed"]);
    await expect.element(apply()).toHaveTextContent("Apply");
  });

  it.each([
    ["the save fails", { _tag: "Failure" }, true],
    ["there is no permission to restart", { _tag: "Success" }, false],
  ] as const)("restarts nothing when %s", async (_name, outcome, canRestart) => {
    setup();
    mocks.canRestart = canRestart;
    mocks.updateSettings.mockResolvedValue(outcome);
    const { screen, onChanged } = await mount();
    await using _screen = screen;
    await userEvent.fill(field(), VENV);

    await apply().click();

    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mocks.updateSettings).toHaveBeenCalledWith(patch(VENV));
    expect(mocks.restart).not.toHaveBeenCalled();
    // The field stays usable for another try.
    await expect.element(apply()).toHaveTextContent("Apply");
  });

  it("sends an empty value to clear a saved environment, and has nothing to apply until it changes", async () => {
    setup({ [CWD]: VENV });
    const { screen } = await mount();
    await using _screen = screen;
    await expect.element(field()).toHaveValue(VENV);
    await expect.element(apply()).toBeDisabled();

    await userEvent.clear(field());
    await apply().click();

    await vi.waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(1));
    expect(mocks.updateSettings).toHaveBeenCalledExactlyOnceWith(patch(""));
  });

  it("shows a setting that loads after the popover opened, so Apply can't unset it", async () => {
    setup();
    const { screen, onChanged } = await mount();
    await using _screen = screen;
    await expect.element(field()).toHaveValue("");

    settings = Atom.make({ codeIntel: { pythonEnvironments: { [CWD]: VENV } } });
    await screen.rerender(chip({}, onChanged));

    await expect.element(field()).toHaveValue(VENV);
    await expect.element(apply()).toBeDisabled();
  });

  it.each([
    ["another language server", { server: server("typescript", "tsserver") }, true],
    ["a connection that can't write settings", {}, false],
    ["code intelligence turned off", { turnedOff: true }, true],
  ] as const)("is not offered for %s", async (_name, options, canWrite) => {
    setup();
    mocks.canWrite = canWrite;
    const { screen } = await mount(options);
    await using _screen = screen;

    // The popover is open: it states the server's state.
    await expect.element(page.getByText(/^(ready|off)$/).last()).toBeVisible();
    expect(field().elements()).toEqual([]);
  });
});
