import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";

const mocks = vi.hoisted(() => ({ statusRuns: 0 }));

// Like the real status atom on a server without code intel: it fails, then asks again every
// 2 s for as long as something reads it.
vi.mock(import("~/state/codeIntel"), async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { CodeIntelUnsupportedError } = await import("@t3tools/client-runtime/state/code-intel");
  const status = Atom.make((get) => {
    mocks.statusRuns += 1;
    const retry = setTimeout(() => get.refreshSelf(), 2_000);
    get.addFinalizer(() => clearTimeout(retry));
    return AsyncResult.failure(Cause.fail(new CodeIntelUnsupportedError()));
  });
  return { codeIntelEnvironment: { status: () => status } as never };
});

import { useCodeIntelFile } from "./useCodeIntelFile";

function Probe() {
  const intel = useCodeIntelFile(EnvironmentId.make("env-old"), "/repo", "notes.txt", true);
  return <p>{intel.supported ? "supported" : "unsupported"}</p>;
}

function setup() {
  mocks.statusRuns = 0;
}

describe("useCodeIntelFile", () => {
  it("asks a server without code intel for status once, not every two seconds", async () => {
    setup();
    // The status atom arms its retry when the first render reads it.
    using _timers = fakeTimers();
    await using _screen = await render(<Probe />);

    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(mocks.statusRuns).toBe(1);
  });
});
