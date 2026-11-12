import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";

interface CodeIntelSetting {
  readonly codeIntel: { readonly enabled: boolean };
}

const mocks = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    statusRuns: 0,
    /** What the server's status says; null is a server without code intel. */
    serverEnabled: null as boolean | null,
    settings: Atom.make<CodeIntelSetting>({ codeIntel: { enabled: true } }),
  };
});

// Like the real status atom: settled, or on a server without code intel it fails, then asks
// again every 2 s for as long as something reads it.
vi.mock(import("~/state/codeIntel"), async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { CodeIntelUnsupportedError } = await import("@t3tools/client-runtime/state/code-intel");
  const status = Atom.make((get) => {
    mocks.statusRuns += 1;
    if (mocks.serverEnabled !== null) {
      return AsyncResult.success({ enabled: mocks.serverEnabled, servers: [] });
    }
    const retry = setTimeout(() => get.refreshSelf(), 2_000);
    get.addFinalizer(() => clearTimeout(retry));
    return AsyncResult.failure(Cause.fail(new CodeIntelUnsupportedError()));
  });
  return { codeIntelEnvironment: { status: () => status } as never };
});

vi.mock(import("~/state/server"), () => ({
  serverEnvironment: { settingsValueAtom: () => mocks.settings } as never,
}));

import { useCodeIntelFile } from "./useCodeIntelFile";

function Probe() {
  const intel = useCodeIntelFile(EnvironmentId.make("env-old"), "/repo", "notes.txt", true);
  return (
    <>
      <p>{intel.supported ? "supported" : "unsupported"}</p>
      <p>{intel.turnedOff ? "off" : "on"}</p>
    </>
  );
}

function setup(serverEnabled: boolean | null) {
  mocks.statusRuns = 0;
  mocks.serverEnabled = serverEnabled;
}

describe("useCodeIntelFile", () => {
  it("asks a server without code intel for status once, not every two seconds", async () => {
    setup(null);
    // The status atom arms its retry when the first render reads it.
    using _timers = fakeTimers();
    await using _screen = await render(<Probe />);

    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(mocks.statusRuns).toBe(1);
  });

  it("asks for status again when the switch moves elsewhere, after status settled", async () => {
    setup(true);
    const registry = AtomRegistry.make();
    const { settings } = mocks;
    await using screen = await render(
      <RegistryContext value={registry}>
        <Probe />
      </RegistryContext>,
    );
    await expect.element(screen.getByText("on")).toBeVisible();

    mocks.serverEnabled = false;
    await act(() => registry.set(settings, { codeIntel: { enabled: false } }));
    await expect.element(screen.getByText("off")).toBeVisible();

    mocks.serverEnabled = true;
    await act(() => registry.set(settings, { codeIntel: { enabled: true } }));
    await expect.element(screen.getByText("on")).toBeVisible();
    expect(mocks.statusRuns).toBe(3);
  });
});
