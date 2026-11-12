import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { CodeIntelUnsupportedError } from "@t3tools/client-runtime/state/code-intel";
import {
  CodeIntelError,
  type CodeIntelErrorReason,
  type CodeLocation,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../../test/render";

// Each query waits until the test settles it, so a lookup can be superseded or dropped while it runs.
const mocks = vi.hoisted(() => ({
  queries: [] as Array<{
    request: unknown;
    signal: AbortSignal | undefined;
    settle: (result: unknown) => void;
  }>,
  navigateToCodeLocation: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  executeAtomQuery: ((_registry: unknown, request: unknown, options?: { signal?: AbortSignal }) =>
    new Promise((resolve) => {
      mocks.queries.push({ request, signal: options?.signal, settle: resolve });
    })) as never,
}));
vi.mock(import("~/state/codeIntel"), () => ({
  codeIntelEnvironment: { definition: (request: unknown) => request } as never,
}));
vi.mock(import("~/components/code/navigation"), () => ({
  codeNavigationThreadKey: () => "thread",
  navigateToCodeLocation: mocks.navigateToCodeLocation,
  registerCodeViewer: () => () => {},
}));

import {
  NOT_CURRENT_VERSION,
  OUTSIDE_PROJECT,
  type SbsCodeNavigationContext,
  useSbsCodeNavigation,
} from "./useSbsCodeNavigation";
import type { SbsTokenActivation } from "./SideBySideDiffView";

const REVISION = "rev-current";
const threadRef = scopeThreadRef(EnvironmentId.make("env-sbs"), ThreadId.make("thread-sbs"));
const context: SbsCodeNavigationContext = {
  environmentId: threadRef.environmentId,
  cwd: "/repo",
  repositoryRoot: undefined,
  threadRef,
};
const declaration: CodeLocation = {
  path: "src/greet.ts",
  external: false,
  range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
};
const other: CodeLocation = { ...declaration, path: "src/other.ts" };

type ActivationOverrides = Partial<Omit<SbsTokenActivation, "anchor">>;

function setup() {
  mocks.queries.length = 0;
  mocks.navigateToCodeLocation.mockReset();
  for (const token of document.querySelectorAll("[data-test-token]")) token.remove();
}

// A token the test owns outside React, so a test can take it out of the DOM as a scrolled pane does.
function tokenElement(id: string): HTMLElement {
  const existing = document.querySelector<HTMLElement>(`[data-test-token="${id}"]`);
  if (existing) return existing;
  const token = document.createElement("span");
  token.dataset.testToken = id;
  token.textContent = "token";
  Object.assign(token.style, {
    position: "fixed",
    top: id === "first" ? "300px" : "100px",
    left: id === "first" ? "200px" : "20px",
  });
  document.body.append(token);
  return token;
}

function Harness(props: {
  readonly context: SbsCodeNavigationContext | null;
  readonly onOpenFile?: (filePath: string, line?: number) => void;
  readonly filePath?: string;
  readonly activation?: ActivationOverrides;
  readonly second?: ActivationOverrides;
}) {
  const navigation = useSbsCodeNavigation(props.context, props.onOpenFile ?? (() => {}));
  const activate = (overrides: ActivationOverrides | undefined, anchorId: string) => {
    const anchor = tokenElement(anchorId);
    navigation.onTokenActivate?.(
      {
        side: "additions",
        line: 3,
        character: 4,
        modifiers: { meta: true, ctrl: false, alt: false, shift: false },
        revision: REVISION,
        anchor,
        ...overrides,
      },
      props.filePath ?? "src/main.ts",
    );
  };
  return (
    <div>
      <p>{navigation.onTokenActivate === undefined ? "no handler" : "has handler"}</p>
      <button type="button" onClick={() => activate(props.activation, "first")}>
        activate
      </button>
      <button type="button" onClick={() => activate(props.second, "second")}>
        activate again
      </button>
      {navigation.popup}
    </div>
  );
}

const answer = (locations: ReadonlyArray<CodeLocation>, revision = REVISION) =>
  AsyncResult.success({ revision, locations });
const failure = (reason: CodeIntelErrorReason, message = "") =>
  AsyncResult.failure(Cause.fail(new CodeIntelError({ reason, message })));

// Settles a query, then lets the lookup's continuation run to its end: an async timer tick
// yields to the event loop, which drains every promise callback queued before it.
async function settle(index: number, result: unknown) {
  await act(async () => {
    mocks.queries[index]!.settle(result);
    await vi.advanceTimersByTimeAsync(0);
  });
}

const click = (name: string) =>
  act(() => (page.getByRole("button", { name }).element() as HTMLElement).click());
const status = () => page.getByRole("status");

describe("useSbsCodeNavigation", () => {
  it("has no handler and renders nothing without a context", async () => {
    setup();
    await using screen = await render(<Harness context={null} />);

    await expect.element(screen.getByText("no handler")).toBeInTheDocument();
    expect(page.getByRole("status").query()).toBeNull();
    expect(document.querySelector("[data-code-nav-popup]")).toBeNull();
    expect(mocks.queries).toHaveLength(0);
  });

  it("asks for the definition at the zero-based position of the token, for the revision shown", async () => {
    setup();
    await using _screen = await render(
      <Harness context={context} filePath="src/main.ts" activation={{ line: 3, character: 4 }} />,
    );

    await click("activate");

    expect(mocks.queries).toHaveLength(1);
    expect(mocks.queries[0]!.request).toEqual({
      environmentId: threadRef.environmentId,
      input: {
        document: { cwd: "/repo", path: "src/main.ts", ifRevision: REVISION },
        position: { line: 2, character: 4 },
        kind: "definition",
      },
    });
    expect(mocks.queries[0]!.signal?.aborted).toBe(false);
  });

  it.each([
    {
      name: "drops a worktree subfolder's prefix from a repository-relative path",
      context: { ...context, cwd: "/repo/packages/app", repositoryRoot: "/repo" },
      filePath: "packages/app/src/main.ts",
      path: "src/main.ts",
    },
    {
      name: "makes an absolute path under the project relative",
      context,
      filePath: "/repo/src/main.ts",
      path: "src/main.ts",
    },
    {
      name: "keeps a repository-relative path when the project is the repository",
      context: { ...context, repositoryRoot: "/repo" },
      filePath: "src/main.ts",
      path: "src/main.ts",
    },
  ])("$name", async ({ context: given, filePath, path }) => {
    setup();
    await using _screen = await render(<Harness context={given} filePath={filePath} />);

    await click("activate");

    expect(mocks.queries[0]!.request).toMatchObject({
      input: { document: { cwd: given.cwd, path } },
    });
  });

  it("goes straight to the one declaration, with no popup", async () => {
    setup();
    await using _screen = await render(<Harness context={context} />);
    using _timers = fakeTimers();

    await click("activate");
    await settle(0, answer([declaration]));

    expect(mocks.navigateToCodeLocation).toHaveBeenCalledExactlyOnceWith(threadRef, declaration);
    expect(document.querySelector("[data-code-nav-popup]")).toBeNull();
  });

  it("lists several declarations, and opening one navigates and closes the list", async () => {
    setup();
    await using _screen = await render(<Harness context={context} />);
    using _timers = fakeTimers();

    await click("activate");
    await settle(0, answer([declaration, other]));

    await expect.element(page.getByText("Choose a target")).toBeVisible();
    expect(mocks.navigateToCodeLocation).not.toHaveBeenCalled();
    await act(() => (page.getByRole("option").nth(1).element() as HTMLElement).click());

    expect(mocks.navigateToCodeLocation).toHaveBeenCalledExactlyOnceWith(threadRef, other);
    await vi.waitFor(() => expect(page.getByText("Choose a target").query()).toBeNull());
  });

  it("says when there is no declaration", async () => {
    setup();
    await using _screen = await render(<Harness context={context} />);
    using _timers = fakeTimers();

    await click("activate");
    await settle(0, answer([]));

    await expect.element(status()).toHaveTextContent("No declaration found");
    expect(mocks.navigateToCodeLocation).not.toHaveBeenCalled();
  });

  describe("a pane that is not the file on disk", () => {
    it("offers the file at the line when a patch's hunks are shown, without asking the server", async () => {
      setup();
      const onOpenFile = vi.fn();
      await using _screen = await render(
        <Harness
          context={context}
          onOpenFile={onOpenFile}
          filePath="src/main.ts"
          activation={{ revision: null, side: "additions", line: 7 }}
        />,
      );

      await click("activate");

      await expect.element(status()).toHaveTextContent(NOT_CURRENT_VERSION);
      expect(mocks.queries).toHaveLength(0);
      expect(onOpenFile).not.toHaveBeenCalled();
      await click("Open file");

      expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("src/main.ts", 7);
      await vi.waitFor(() => expect(page.getByText(NOT_CURRENT_VERSION).query()).toBeNull());
    });

    it("offers the file with no line for the old side, whose lines are not the file's", async () => {
      setup();
      const onOpenFile = vi.fn();
      await using _screen = await render(
        <Harness
          context={context}
          onOpenFile={onOpenFile}
          filePath="src/main.ts"
          activation={{ revision: null, side: "deletions", line: 7 }}
        />,
      );

      await click("activate");
      await click("Open file");

      expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("src/main.ts", undefined);
      await vi.waitFor(() => expect(page.getByText(NOT_CURRENT_VERSION).query()).toBeNull());
    });

    it("offers the file when the server says the document is stale", async () => {
      setup();
      const onOpenFile = vi.fn();
      await using _screen = await render(
        <Harness context={context} onOpenFile={onOpenFile} activation={{ line: 5 }} />,
      );
      using _timers = fakeTimers();

      await click("activate");
      await settle(0, failure("stale_document", "changed"));

      await expect.element(status()).toHaveTextContent(NOT_CURRENT_VERSION);
      await click("Open file");
      expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("src/main.ts", 5);
      expect(mocks.navigateToCodeLocation).not.toHaveBeenCalled();
    });

    it("offers the file when the server answers for another revision, and does not navigate", async () => {
      setup();
      await using _screen = await render(<Harness context={context} />);
      using _timers = fakeTimers();

      await click("activate");
      await settle(0, answer([declaration], "rev-newer"));

      await expect.element(status()).toHaveTextContent(NOT_CURRENT_VERSION);
      expect(mocks.navigateToCodeLocation).not.toHaveBeenCalled();
    });
  });

  it.each([
    { name: "a relative path that leaves the project", filePath: "../elsewhere/x.ts" },
    { name: "an absolute path outside the project", filePath: "/other/x.ts" },
  ])("sends no request for $name", async ({ filePath }) => {
    setup();
    await using _screen = await render(<Harness context={context} filePath={filePath} />);

    await click("activate");

    await expect.element(status()).toHaveTextContent(OUTSIDE_PROJECT);
    expect(mocks.queries).toHaveLength(0);
  });

  describe("failures", () => {
    it("shows the code viewer's message for the failure", async () => {
      setup();
      await using _screen = await render(<Harness context={context} filePath="src/main.ts" />);
      using _timers = fakeTimers();

      await click("activate");
      await settle(0, failure("unsupported_language"));

      await expect.element(status()).toHaveTextContent("No language server for .ts");
      expect(mocks.navigateToCodeLocation).not.toHaveBeenCalled();
    });

    it("shows a defect's own message", async () => {
      setup();
      await using _screen = await render(<Harness context={context} />);
      using _timers = fakeTimers();

      await click("activate");
      await settle(0, AsyncResult.failure(Cause.die(new Error("the socket closed"))));

      await expect.element(status()).toHaveTextContent("the socket closed");
    });

    it("shows nothing for a server too old for code intelligence, and clears an earlier hint", async () => {
      setup();
      await using _screen = await render(<Harness context={context} />);
      using _timers = fakeTimers();
      await click("activate");
      await settle(0, answer([]));
      await expect.element(status()).toHaveTextContent("No declaration found");

      await click("activate again");
      await settle(1, AsyncResult.failure(Cause.fail(new CodeIntelUnsupportedError())));

      await vi.waitFor(() => expect(page.getByRole("status").query()).toBeNull());
      expect(mocks.navigateToCodeLocation).not.toHaveBeenCalled();
    });
  });

  describe("requests in flight", () => {
    it("lets a second activation supersede the first: its answer never shows or navigates", async () => {
      setup();
      await using _screen = await render(<Harness context={context} />);
      using _timers = fakeTimers();

      await click("activate");
      await click("activate again");
      expect(mocks.queries).toHaveLength(2);
      expect(mocks.queries[0]!.signal?.aborted).toBe(true);
      expect(mocks.queries[1]!.signal?.aborted).toBe(false);

      await settle(0, answer([declaration]));
      expect(mocks.navigateToCodeLocation).not.toHaveBeenCalled();
      expect(page.getByRole("status").query()).toBeNull();

      await settle(1, answer([other]));
      expect(mocks.navigateToCodeLocation).toHaveBeenCalledExactlyOnceWith(threadRef, other);
    });

    it("drops a superseded answer that would list targets, even when it arrives last", async () => {
      setup();
      await using _screen = await render(<Harness context={context} />);
      using _timers = fakeTimers();

      await click("activate");
      await click("activate again");
      await settle(1, answer([]));
      await settle(0, answer([declaration, other]));

      await expect.element(status()).toHaveTextContent("No declaration found");
      expect(page.getByText("Choose a target").query()).toBeNull();
    });

    it("shows the waiting hint after 500 ms, and not before", async () => {
      setup();
      await using _screen = await render(<Harness context={context} />);
      using _timers = fakeTimers();

      await click("activate");
      await act(() => vi.advanceTimersByTimeAsync(499));
      expect(page.getByRole("status").query()).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(1));

      await expect.element(status()).toHaveTextContent("Waiting for the language server…");
      await settle(0, answer([declaration]));
      expect(mocks.navigateToCodeLocation).toHaveBeenCalledExactlyOnceWith(threadRef, declaration);
      await vi.waitFor(() => expect(page.getByRole("status").query()).toBeNull());
    });

    it("shows no waiting hint for an answer that comes in time", async () => {
      setup();
      await using _screen = await render(<Harness context={context} />);
      using _timers = fakeTimers();

      await click("activate");
      await settle(0, answer([declaration, other]));
      await act(() => vi.advanceTimersByTimeAsync(1_000));

      expect(page.getByText("Waiting for the language server…").query()).toBeNull();
      await expect.element(page.getByText("Choose a target")).toBeVisible();
    });

    it("shows no waiting hint for a request that a newer one replaced", async () => {
      setup();
      await using _screen = await render(<Harness context={context} />);
      using _timers = fakeTimers();

      await click("activate");
      await act(() => vi.advanceTimersByTimeAsync(300));
      await click("activate again");
      await act(() => vi.advanceTimersByTimeAsync(300));
      // 600 ms after the first request, 300 after the second.
      expect(page.getByRole("status").query()).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(200));

      await expect.element(status()).toHaveTextContent("Waiting for the language server…");
    });

    it("aborts the request in flight when it unmounts", async () => {
      setup();
      await using screen = await render(<Harness context={context} />);
      using _timers = fakeTimers();
      await click("activate");
      expect(mocks.queries[0]!.signal?.aborted).toBe(false);

      await screen.unmount();
      expect(mocks.queries[0]!.signal?.aborted).toBe(true);
      await settle(0, answer([declaration]));

      expect(mocks.navigateToCodeLocation).not.toHaveBeenCalled();
    });

    it("drops a lookup whose popup was dismissed", async () => {
      setup();
      await using _screen = await render(<Harness context={context} />);
      using _timers = fakeTimers();
      await click("activate");
      await act(() => vi.advanceTimersByTimeAsync(500));
      await expect.element(status()).toHaveTextContent("Waiting for the language server…");

      await act(() =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      await vi.waitFor(() => expect(page.getByRole("status").query()).toBeNull());
      expect(mocks.queries[0]!.signal?.aborted).toBe(true);
      await settle(0, answer([declaration]));

      expect(mocks.navigateToCodeLocation).not.toHaveBeenCalled();
    });
  });

  describe("the popup's anchor", () => {
    it("opens at the activated token", async () => {
      setup();
      await using _screen = await render(<Harness context={context} />);
      using _timers = fakeTimers();

      await click("activate");
      await settle(0, answer([]));

      await expect.element(status()).toBeVisible();
      const anchor = tokenElement("first").getBoundingClientRect();
      const popup = document.querySelector("[data-code-nav-popup]")!.getBoundingClientRect();
      expect(popup.top).toBeGreaterThanOrEqual(anchor.bottom - 1);
      expect(Math.abs(popup.left - anchor.left)).toBeLessThan(2);
    });

    it("stays where it was when the token leaves the DOM", async () => {
      setup();
      await using _screen = await render(<Harness context={context} />);
      using _timers = fakeTimers();
      await click("activate");
      await settle(0, answer([]));
      await expect.element(status()).toBeVisible();
      const before = document.querySelector("[data-code-nav-popup]")!.getBoundingClientRect();

      tokenElement("first").remove();
      await act(async () => {
        window.dispatchEvent(new Event("resize"));
        await vi.advanceTimersByTimeAsync(100);
      });

      await expect.element(status()).toBeVisible();
      const after = document.querySelector("[data-code-nav-popup]")!.getBoundingClientRect();
      expect([after.left, after.top]).toEqual([before.left, before.top]);
    });
  });
});
