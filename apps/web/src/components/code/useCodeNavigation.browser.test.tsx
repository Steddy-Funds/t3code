import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  CodeIntelError,
  type CodeLocation,
  type CodeServerStatus,
  EnvironmentId,
  type KeybindingCommand,
  ThreadId,
} from "@t3tools/contracts";
import { fileContentRevision } from "@t3tools/shared/fileContentRevision";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";

// Each query waits until the test settles it, so a lookup can be dismissed while it runs.
const mocks = vi.hoisted(() => ({
  queries: [] as Array<{ request: unknown; settle: (result: unknown) => void }>,
  navigateToCodeLocation: vi.fn(),
  scopes: [] as Array<{
    commands: Partial<Record<KeybindingCommand, (event: KeyboardEvent) => boolean | void>>;
    options: { onKeyDown?: (event: KeyboardEvent) => boolean };
  }>,
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  executeAtomQuery: ((_registry: unknown, request: unknown) =>
    new Promise((resolve) => {
      mocks.queries.push({ request, settle: resolve });
    })) as never,
}));
vi.mock(import("~/state/codeIntel"), () => ({
  codeIntelEnvironment: {
    definition: (request: unknown) => request,
    references: (request: unknown) => request,
    documentHighlights: (request: unknown) => request,
    hover: (request: unknown) => request,
  } as never,
}));
vi.mock(import("~/state/projects"), () => ({
  projectContentSearch: ((request: unknown) => request) as never,
}));
vi.mock(import("../files/projectFilesQueryState"), () => ({
  getProjectFileContents: () => undefined,
  getProjectFileQueryAtom: (() => "file") as never,
  getUnsavedProjectFileQueryData: () => null,
}));
vi.mock(import("~/components/ChatMarkdown"), () => ({
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));
vi.mock(import("~/shortcuts/dispatcher"), () => ({
  registerCommands: ((
    commands: (typeof mocks.scopes)[number]["commands"],
    options: (typeof mocks.scopes)[number]["options"],
  ) => {
    mocks.scopes.push({ commands, options });
    return () => {};
  }) as never,
}));
vi.mock(import("./navigation"), () => ({
  codeNavigationThreadKey: () => "thread",
  navigateToCodeLocation: mocks.navigateToCodeLocation,
  registerCodeViewer: () => () => {},
}));

import { useCodeNavigationStore } from "../../codeNavigationStore";
import { type CodeEditorHandle, useCodeNavigation } from "./useCodeNavigation";

const TEXT = "import { greet } from './greet';\ngreet('world');\n";
const threadRef = scopeThreadRef(EnvironmentId.make("env-nav"), ThreadId.make("thread-nav"));
const server: CodeServerStatus = {
  languageId: "typescript",
  name: "tsc",
  state: "ready",
  libraryRoots: [],
};
const declaration: CodeLocation = {
  path: "src/greet.ts",
  external: false,
  range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } },
};
// The caret on `greet` in the second line.
const editor: CodeEditorHandle = {
  getViewState: () => ({
    selections: [
      { start: { line: 1, character: 2 }, end: { line: 1, character: 2 }, direction: 0 },
    ],
  }),
  focus: () => {},
};
// Pierre's editor can stop tracking clicks after focus leaves it, and then reports no caret.
const editorWithoutCaret: CodeEditorHandle = { getViewState: () => ({}), focus: () => {} };

function Viewer(props: { readonly path: string; readonly editor?: CodeEditorHandle }) {
  const navigation = useCodeNavigation({
    environmentId: threadRef.environmentId,
    cwd: "/repo",
    threadRef,
    path: props.path,
    text: TEXT,
    shown: true,
    editable: true,
    intel: {
      supported: true,
      servers: [server],
      server,
      libraryRoot: null,
      libraryCode: false,
      refreshStatus: () => {},
    },
  });
  return (
    <div {...navigation.surfaceProps}>
      <textarea
        aria-label="editor"
        ref={(node) => {
          navigation.setEditor(node === null ? null : (props.editor ?? editor));
        }}
      />
      <div
        ref={(node) => {
          if (node !== null) navigation.onPostRender(node, "mount");
        }}
      >
        <div data-line="2">
          <span data-char="0">greet</span>
          <span data-char="5">(&apos;world&apos;);</span>
        </div>
      </div>
      {navigation.popup}
    </div>
  );
}

function setup() {
  mocks.queries.length = 0;
  mocks.scopes.length = 0;
  mocks.navigateToCodeLocation.mockReset();
}

function press(command: KeybindingCommand) {
  const handler = mocks.scopes.at(-1)!.commands[command]!;
  return act(() => handler(new KeyboardEvent("keydown", { cancelable: true })));
}

function pressEscape() {
  const onKeyDown = mocks.scopes.at(-1)!.options.onKeyDown!;
  return act(() => onKeyDown(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
}

const answer = (locations: ReadonlyArray<CodeLocation>) =>
  AsyncResult.success({ revision: fileContentRevision(TEXT), locations });

// Settles a query, then lets the lookup's continuation run to its end: an async timer tick
// yields to the event loop, which drains every promise callback queued before it.
async function settle(index: number, result: unknown) {
  await act(async () => {
    mocks.queries[index]!.settle(result);
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe("useCodeNavigation lookups", () => {
  it("goes to the one declaration the server answers", async () => {
    setup();
    await using _screen = await render(<Viewer path="src/main.ts" />);
    using _timers = fakeTimers();

    await press("code.goToDeclaration");
    await settle(0, answer([declaration]));

    expect(mocks.navigateToCodeLocation).toHaveBeenCalledWith(threadRef, declaration);
  });

  it("looks where the user clicked, not where an earlier jump landed, when the editor reports no caret", async () => {
    setup();
    await using _screen = await render(<Viewer path="src/main.ts" editor={editorWithoutCaret} />);
    const landed = { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } };
    await act(() =>
      useCodeNavigationStore.getState().reveal("thread", threadRef, "src/main.ts", landed),
    );
    await vi.waitFor(() =>
      expect(useCodeNavigationStore.getState().revealByThreadKey.thread).toBeUndefined(),
    );
    await userEvent.click(page.getByText("greet", { exact: true }), { position: { x: 2, y: 4 } });
    using _timers = fakeTimers();

    await press("code.goToDeclaration");

    expect(mocks.queries[0]?.request).toMatchObject({
      input: { position: { line: 1, character: 0 } },
    });
  });

  it("drops a lookup dismissed with Escape while it waits", async () => {
    setup();
    await using _screen = await render(<Viewer path="src/main.ts" />);
    using _timers = fakeTimers();

    await press("code.goToDeclaration");
    await act(() => vi.advanceTimersByTimeAsync(500));
    await vi.waitFor(() =>
      expect(page.getByRole("status").element()).toHaveTextContent("Waiting for tsc…"),
    );
    await pressEscape();
    await settle(0, answer([declaration, { ...declaration, path: "src/other.ts" }]));

    expect(mocks.navigateToCodeLocation).not.toHaveBeenCalled();
    expect(page.getByText("Choose a target").query()).toBeNull();
  });

  it("drops a lookup when Go to Line opens over it", async () => {
    setup();
    await using _screen = await render(<Viewer path="src/main.ts" />);
    using _timers = fakeTimers();

    await press("code.goToDeclaration");
    await press("code.goToLine");
    await settle(0, answer([declaration]));

    expect(mocks.navigateToCodeLocation).not.toHaveBeenCalled();
    expect(page.getByPlaceholder("Line[:column]").query()).not.toBeNull();
  });

  it("drops a lookup when the viewer switches to another file", async () => {
    setup();
    await using screen = await render(<Viewer path="src/main.ts" />);
    using _timers = fakeTimers();

    await press("code.goToDeclaration");
    await screen.rerender(<Viewer path="src/other.ts" />);
    await settle(0, answer([declaration]));

    expect(mocks.navigateToCodeLocation).not.toHaveBeenCalled();
  });

  it("asks nothing more after a stale reload once the viewer is gone", async () => {
    setup();
    await using screen = await render(<Viewer path="src/main.ts" />);
    using _timers = fakeTimers();

    await press("code.goToDeclaration");
    const stale = new CodeIntelError({ reason: "stale_document", message: "changed" });
    await settle(0, AsyncResult.failure(Cause.fail(stale)));
    // The clean file is reloaded before asking again.
    expect(mocks.queries).toHaveLength(2);
    await screen.unmount();
    await settle(1, AsyncResult.success({ contents: TEXT }));

    expect(mocks.queries).toHaveLength(2);
    expect(mocks.navigateToCodeLocation).not.toHaveBeenCalled();
  });
});
