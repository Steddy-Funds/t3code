import { type FileDiffMetadata, parseDiffFromFile } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { CodeIntelUnsupportedError } from "@t3tools/client-runtime/state/code-intel";
import {
  CodeIntelError,
  type CodeIntelErrorReason,
  type CodeLocation,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { fileContentRevision } from "@t3tools/shared/fileContentRevision";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";

// Each query waits until the test settles it, so a lookup can be superseded or dropped while it runs.
const mocks = vi.hoisted(() => ({
  queries: [] as Array<{
    request: unknown;
    signal: AbortSignal | undefined;
    settle: (result: unknown) => void;
  }>,
  navigateToCodeLocation: vi.fn(),
  thread: null as { worktreePath: string | null } | null,
  project: null as {
    workspaceRoot: string;
    repositoryIdentity: { rootPath: string } | null;
  } | null,
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
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((ref: unknown) =>
    ref === null || mocks.thread === null
      ? null
      : { environmentId: "env-sbs", projectId: "project-1", ...mocks.thread }) as never,
  useProject: ((ref: unknown) => (ref === null ? null : mocks.project)) as never,
}));
vi.mock(import("~/components/code/navigation"), () => ({
  codeNavigationThreadKey: () => "thread",
  navigateToCodeLocation: mocks.navigateToCodeLocation,
  registerCodeViewer: () => () => {},
}));

import {
  type DiffCodeNavigationContext,
  type DiffTokenActivation,
  diffSideRevision,
  NOT_CURRENT_VERSION,
  OUTSIDE_PROJECT,
  useDiffCodeNavigation,
  useThreadCodeNavigationContext,
} from "./useDiffCodeNavigation";

const REVISION = "rev-current";
const threadRef = scopeThreadRef(EnvironmentId.make("env-sbs"), ThreadId.make("thread-sbs"));
const context: DiffCodeNavigationContext = {
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

type ActivationOverrides = Partial<Omit<DiffTokenActivation, "anchor">>;

function setup() {
  mocks.queries.length = 0;
  mocks.navigateToCodeLocation.mockReset();
  mocks.thread = null;
  mocks.project = null;
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
  readonly context: DiffCodeNavigationContext | null;
  readonly shownFile?: string | null;
  readonly onOpenFile?: (filePath: string, line?: number) => void;
  readonly filePath?: string;
  readonly activation?: ActivationOverrides;
  readonly second?: ActivationOverrides;
  /** A stacked or split view's word in this diff. */
  readonly codeViewDiff?: FileDiffMetadata;
}) {
  const navigation = useDiffCodeNavigation(
    props.context,
    props.shownFile === undefined ? "src/main.ts" : props.shownFile,
    props.onOpenFile ?? (() => {}),
  );
  const activate = (overrides: ActivationOverrides | undefined, anchorId: string) => {
    const anchor = tokenElement(anchorId);
    navigation.onTokenActivate?.(
      {
        side: "additions",
        line: 3,
        character: 4,
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
      {props.codeViewDiff ? (
        <button
          type="button"
          onClick={() =>
            navigation.onCodeViewTokenActivate?.(
              { side: "additions", line: 2, character: 6, anchor: tokenElement("first") },
              props.codeViewDiff!,
            )
          }
        >
          activate in code view
        </button>
      ) : null}
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

function ThreadContext() {
  return <output>{JSON.stringify(useThreadCodeNavigationContext(threadRef))}</output>;
}

describe("useThreadCodeNavigationContext", () => {
  it.each([
    {
      name: "a worktree thread asks in its worktree, whatever the project's folder",
      thread: { worktreePath: "/worktrees/feature" },
      expected: { cwd: "/worktrees/feature", repositoryRoot: undefined },
    },
    {
      name: "a local thread asks in its project's folder, under the repository's root",
      thread: { worktreePath: null },
      expected: { cwd: "/repo/app", repositoryRoot: "/repo" },
    },
  ])("$name", async ({ thread, expected }) => {
    setup();
    mocks.thread = thread;
    mocks.project = { workspaceRoot: "/repo/app", repositoryIdentity: { rootPath: "/repo" } };
    await using screen = await render(<ThreadContext />);

    const shown = JSON.parse(screen.container.querySelector("output")!.textContent!);
    expect(shown).toEqual({ environmentId: threadRef.environmentId, ...expected, threadRef });
  });

  it("is null until the thread loads", async () => {
    setup();
    await using screen = await render(<ThreadContext />);
    expect(screen.container.querySelector("output")!.textContent).toBe("null");
  });
});

describe("useDiffCodeNavigation", () => {
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

  describe("a whole file still being read for its revision", () => {
    function pending() {
      let resolve: (revision: string | null) => void = () => {};
      const revision = new Promise<string | null>((settle) => (resolve = settle));
      return { revision, resolve };
    }
    const resolveRevision = (resolve: (revision: string | null) => void, value: string | null) =>
      act(async () => {
        resolve(value);
        await vi.advanceTimersByTimeAsync(0);
      });

    it("asks once the revision is known, for that revision", async () => {
      setup();
      const read = pending();
      await using _screen = await render(
        <Harness context={context} activation={{ revision: read.revision }} />,
      );
      using _timers = fakeTimers();

      await click("activate");
      expect(mocks.queries).toHaveLength(0);
      await resolveRevision(read.resolve, REVISION);

      expect(mocks.queries).toHaveLength(1);
      expect(mocks.queries[0]!.request).toMatchObject({
        input: { document: { ifRevision: REVISION } },
      });
    });

    it("offers the file without asking when the whole file cannot be read", async () => {
      setup();
      const read = pending();
      await using _screen = await render(
        <Harness context={context} activation={{ revision: read.revision }} />,
      );
      using _timers = fakeTimers();

      await click("activate");
      await resolveRevision(read.resolve, null);

      await expect.element(status()).toHaveTextContent(NOT_CURRENT_VERSION);
      expect(mocks.queries).toHaveLength(0);
    });

    it("never asks for a lookup a newer one replaced while its file was read", async () => {
      setup();
      const read = pending();
      await using _screen = await render(
        <Harness context={context} activation={{ revision: read.revision }} />,
      );
      using _timers = fakeTimers();

      await click("activate");
      await click("activate again");
      await resolveRevision(read.resolve, REVISION);
      expect(mocks.queries).toHaveLength(1);
      await settle(0, answer([other]));

      expect(mocks.navigateToCodeLocation).toHaveBeenCalledExactlyOnceWith(threadRef, other);
    });

    it("never asks once the view shows something else", async () => {
      setup();
      const read = pending();
      await using screen = await render(
        <Harness context={context} activation={{ revision: read.revision }} />,
      );
      using _timers = fakeTimers();

      await click("activate");
      await screen.rerender(
        <Harness context={context} activation={{ revision: read.revision }} shownFile={null} />,
      );
      await resolveRevision(read.resolve, REVISION);

      expect(mocks.queries).toHaveLength(0);
      expect(page.getByRole("status").query()).toBeNull();
    });
  });

  it("asks about a stacked view's word with its file's path and its side's revision", async () => {
    setup();
    const codeViewDiff = parseDiffFromFile(
      { name: "src/main.ts", contents: "a\nb\n" },
      { name: "src/main.ts", contents: "a\nconst c = 1;\n" },
    );
    await using _screen = await render(<Harness context={context} codeViewDiff={codeViewDiff} />);

    await click("activate in code view");

    expect(mocks.queries[0]!.request).toMatchObject({
      input: {
        document: {
          cwd: "/repo",
          path: "src/main.ts",
          ifRevision: fileContentRevision("a\nconst c = 1;\n"),
        },
        position: { line: 1, character: 6 },
      },
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

    it.each([
      ["another file is shown", "src/other.ts"],
      ["side by side goes", null],
    ])("drops a lookup and its popup when %s", async (_case, shownFile) => {
      setup();
      await using screen = await render(<Harness context={context} />);
      using _timers = fakeTimers();
      await click("activate");
      await act(() => vi.advanceTimersByTimeAsync(500));
      await expect.element(status()).toHaveTextContent("Waiting for the language server…");

      await screen.rerender(<Harness context={context} shownFile={shownFile} />);
      expect(mocks.queries[0]!.signal?.aborted).toBe(true);
      await vi.waitFor(() => expect(page.getByRole("status").query()).toBeNull());
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

describe("diffSideRevision", () => {
  const OLD = "one\ntwo\nthree\n";
  const NEW = "one\n2\nthree\n";
  const patch = () =>
    parsePatchFiles("diff --git a/f.ts b/f.ts\n--- a/f.ts\n+++ b/f.ts\n@@ -2 +2 @@\n-two\n+2\n", {
      cacheKeyPrefix: "patch",
    })[0]!.files[0]!;
  const wholeFiles = {
    oldFile: { name: "f.ts", contents: OLD },
    newFile: { name: "f.ts", contents: NEW },
  };

  it("gives each side of a whole-file diff its own text's revision", () => {
    const whole = parseDiffFromFile(wholeFiles.oldFile, wholeFiles.newFile);

    expect(diffSideRevision(whole, "deletions", undefined)).toBe(fileContentRevision(OLD));
    expect(diffSideRevision(whole, "additions", undefined)).toBe(fileContentRevision(NEW));
  });

  it("has none for a patch's hunks when the whole files cannot be read", () => {
    const hunks = patch();

    expect(hunks.isPartial).toBe(true);
    expect(diffSideRevision(hunks, "additions", undefined)).toBeNull();
  });

  it("reads a patch's whole files once, for both sides", async () => {
    const hunks = patch();
    const load = vi.fn(async () => wholeFiles);

    const revisions = await Promise.all([
      diffSideRevision(hunks, "additions", load),
      diffSideRevision(hunks, "deletions", load),
      diffSideRevision(hunks, "additions", load),
    ]);

    expect(revisions).toEqual([
      fileContentRevision(NEW),
      fileContentRevision(OLD),
      fileContentRevision(NEW),
    ]);
    expect(load).toHaveBeenCalledOnce();
  });

  it("has none when reading the whole files fails, and reads them again on the next ask", async () => {
    const hunks = patch();
    const load = vi
      .fn<() => Promise<typeof wholeFiles>>()
      .mockRejectedValueOnce(new Error("gone"))
      .mockResolvedValueOnce(wholeFiles);

    await expect(diffSideRevision(hunks, "additions", load)).resolves.toBeNull();
    await expect(diffSideRevision(hunks, "additions", load)).resolves.toBe(
      fileContentRevision(NEW),
    );
  });

  it("has no old side for an added file", async () => {
    const load = vi.fn(async () => ({ newFile: wholeFiles.newFile }));

    await expect(diffSideRevision(patch(), "deletions", load)).resolves.toBeNull();
  });
});
