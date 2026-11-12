import { EnvironmentId, ThreadId, type ProjectReadFileResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_THEMES, preloadHighlighter } from "@pierre/diffs";
import { page } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  file: null as ProjectReadFileResult | null,
  optimistic: null as ProjectReadFileResult | null,
  writeFile: vi.fn(),
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((_registry: unknown, _command: unknown, request: unknown) =>
    state.writeFile(request)) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.writeFile) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("~/remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenState: () => ({ mode: "local-exec" }) as never,
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ resolvedTheme: "dark" }) as never,
}));
vi.mock(import("~/hooks/useWorkspaceMutationRefresh"), () => ({
  useWorkspaceMutationRefresh: vi.fn(),
}));
vi.mock(import("./FileBreadcrumbs"), () => ({ FileBreadcrumbs: () => <></> }));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFileQuery: () => ({
    data: state.file,
    error: null,
    isPending: false,
    readError: null,
    isNotFile: false,
    isFile: true,
    refresh: vi.fn(),
  }),
  getOptimisticProjectFileQueryData: () => state.optimistic,
  getUnsavedProjectFileQueryData: () => null,
  setProjectFileQueryData: (
    _environmentId: EnvironmentId,
    _cwd: string,
    relativePath: string,
    contents: string,
  ) => {
    state.optimistic = { relativePath, contents, truncated: false, byteLength: contents.length };
  },
  confirmProjectFileQueryData: () => true,
}));

import FilePreviewPanel from "./FilePreviewPanel";

const environmentId = EnvironmentId.make("markdown-preview-test");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
function setup() {
  const keys = ["t3code.fileExplorerOpen", "t3code.renderMarkdown", "t3code:theme"];
  const previous = keys.map((key) => localStorage.getItem(key));
  localStorage.setItem(keys[0]!, "false");
  localStorage.setItem(keys[1]!, "true");
  localStorage.setItem(keys[2]!, "dark");
  state.optimistic = null;
  state.writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  return {
    [Symbol.dispose]() {
      for (const [index, key] of keys.entries()) {
        const value = previous[index];
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    },
  };
}

function sourcePreview(contents: string) {
  state.file = {
    relativePath: "server.ts",
    contents,
    byteLength: contents.length,
    truncated: false,
  };
  return (
    <>
      <input aria-label="Composer" />
      <FilePreviewPanel
        environmentId={environmentId}
        cwd="/workspace"
        projectName="Project"
        relativePath="server.ts"
        threadRef={threadRef}
        composerDraftTarget={threadRef}
        keybindings={[]}
        availableEditors={[]}
        openInShortcutEnabled={false}
        revealLine={null}
        revealRequestId={0}
        onOpenFile={vi.fn()}
        onNavigateFolder={vi.fn()}
        folderTrail={undefined}
        onPendingChange={vi.fn()}
        selectedFilePending={false}
        workspaceMutationId={null}
      />
    </>
  );
}

function markdownPreview(truncated: boolean) {
  state.file = {
    relativePath: "tasks.md",
    contents: "- [ ] Keep the rest of this file\n",
    byteLength: truncated ? 1_200_000 : 32,
    truncated,
  };
  return (
    <FilePreviewPanel
      environmentId={environmentId}
      cwd="/workspace"
      projectName="Project"
      relativePath="tasks.md"
      threadRef={threadRef}
      composerDraftTarget={threadRef}
      keybindings={[]}
      availableEditors={[]}
      openInShortcutEnabled={false}
      revealLine={null}
      revealRequestId={0}
      onOpenFile={vi.fn()}
      onNavigateFolder={vi.fn()}
      folderTrail={undefined}
      onPendingChange={vi.fn()}
      selectedFilePending={false}
      workspaceMutationId={null}
    />
  );
}

describe("rendered Markdown task saves", () => {
  it("keeps a truncated read read-only without queuing a replacement", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(true));
    using _timers = fakeTimers();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.readOnly).toBe(true);
    await act(async () => checkbox.click());
    await vi.advanceTimersByTimeAsync(500);
    expect(checkbox.checked).toBe(false);
    expect(state.optimistic).toBeNull();
    expect(state.writeFile).not.toHaveBeenCalled();
  });

  it("still toggles and saves tasks from a complete read", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(false));
    using _timers = fakeTimers();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(false);
    await act(async () => checkbox.click());
    await vi.advanceTimersByTimeAsync(500);
    expect(state.writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: "tasks.md",
        contents: "- [x] Keep the rest of this file\n",
      },
    });
  });
});

describe("an open file that reloads from disk", () => {
  // Editing starts once a real worker has highlighted the file, which takes a while on a busy host.
  const highlighted = { timeout: 20_000 };
  const editor = () => {
    const content = document
      .querySelector("diffs-container")
      ?.shadowRoot?.querySelector<HTMLElement>("[data-content]");
    return content?.isContentEditable ? content : null;
  };
  const editorHasFocus = () => {
    const content = editor();
    return content !== null && (content.getRootNode() as ShadowRoot).activeElement === content;
  };
  const mountEditor = async () => {
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    const screen = await render(sourcePreview("const a = 1;\n"));
    await vi.waitFor(() => expect(editor()).not.toBeNull(), highlighted);
    return screen;
  };
  const reload = async (screen: Awaited<ReturnType<typeof mountEditor>>) => {
    await screen.rerender(sourcePreview("const a = 2;\n"));
  };
  const editorShows = (text: string) => editor()?.textContent?.startsWith(text) === true;

  it("gives focus back to the editor that had it", async () => {
    using _settings = setup();
    await using screen = await mountEditor();
    editor()!.focus();
    expect(editorHasFocus()).toBe(true);

    await reload(screen);
    await vi.waitFor(() => expect(editorShows("const a = 2;")).toBe(true), highlighted);

    await vi.waitFor(() => expect(editorHasFocus()).toBe(true));
  });

  it("leaves focus where it went in the meantime", async () => {
    using _settings = setup();
    await using screen = await mountEditor();
    editor()!.focus();

    await reload(screen);
    const composer = page.getByLabelText("Composer").element() as HTMLInputElement;
    composer.focus();
    await vi.waitFor(() => expect(editorShows("const a = 2;")).toBe(true), highlighted);

    expect(document.activeElement).toBe(composer);
  });

  it("does not take focus if the editor never had it", async () => {
    using _settings = setup();
    await using screen = await mountEditor();

    await reload(screen);
    await vi.waitFor(() => expect(editorShows("const a = 2;")).toBe(true), highlighted);

    expect(document.activeElement).toBe(document.body);
  });
});
