import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  REVIEW_NOTE_TOOL_NAME,
  RunId,
  ThreadId,
  TurnItemId,
  type ClientSettings,
  type ReviewBranchCommitsResult,
  type ReviewDiffPreviewResult,
  type ReviewDiffPreviewSource,
  type ScopedThreadRef,
  type VcsListRefsResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";
import { makeThreadFixture } from "~/test-fixtures";

type ResultAtom<A> = Atom.Atom<AsyncResult.AsyncResult<A, Error>>;

const state = vi.hoisted(() => ({
  thread: null as ReturnType<typeof makeThreadFixture> | null,
  threadRef: null as ScopedThreadRef | null,
  previews: new Map<string | null, ResultAtom<ReviewDiffPreviewResult>>(),
  patch: null as unknown as ResultAtom<ReviewDiffPreviewSource>,
  diffFilesCollapsed: false,
  config: null as unknown as Atom.Atom<null>,
  status: null as unknown as ResultAtom<VcsStatusResult>,
  localRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  remoteRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  commits: null as unknown as ResultAtom<ReviewBranchCommitsResult>,
  settings: {} as Partial<ClientSettings>,
  turnItems: [] as ReadonlyArray<{ readonly item: unknown }>,
  contentsCommand: {},
  contents: null as { readonly oldContents: string; readonly newContents: string } | null,
  contentsUnreadable: false,
}));

vi.mock("~/state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: { configValueAtom: () => state.config },
    primaryServerKeybindingsAtom: Atom.make([]),
  };
});
vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffPreview: ({ input }: { input: { baseRef?: string } }) =>
      state.previews.get(input.baseRef ?? null)!,
    branchCommits: () => state.commits,
    diffFilePatch: () => state.patch,
    diffFileContents: state.contentsCommand,
  },
}));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    status: () => state.status,
    listRefs: ({ input }: { input: { refKind: "local" | "remote" } }) =>
      input.refKind === "local" ? state.localRefs : state.remoteRefs,
  },
}));
vi.mock("~/state/entities", () => ({
  useQuietThreadShell: () => state.thread,
  useProject: () => ({ workspaceRoot: "/project", repositoryIdentity: null }),
  useThreadCheckpointSummaries: () => [],
  useQuietThreadVisibleTurnItems: () => state.turnItems,
}));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("~/hooks/useThreadRouteTarget", () => ({ useThreadRouteRef: () => state.threadRef }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: ClientSettings) => unknown) =>
    select({
      ...DEFAULT_CLIENT_SETTINGS,
      diffFilesCollapsed: state.diffFilesCollapsed,
      ...state.settings,
    }),
  updateClientSettings: async () => {},
}));
vi.mock("~/hooks/useTheme", () => ({
  useRenderedAppearance: () => "dark",
  getRenderedAppearance: () => "dark",
  subscribeRenderedAppearance: () => () => {},
}));
vi.mock("~/state/queries", () => ({
  useCheckpointDiff: () => ({ data: null, error: null, isPending: false }),
  useTurnItemDetail: () => ({ data: null, error: null, isPending: false }),
  useDebouncedValue: <A,>(value: A) => value,
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === state.contentsCommand
      ? async () => {
          if (state.contentsUnreadable) throw new Error("The file could not be read.");
          return { _tag: "Success", value: state.contents };
        }
      : async () => {},
}));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => async () => {} }));
vi.mock("~/fileContextMenu", () => ({ useFileContextMenuHandler: () => () => {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => async () => {} }));
vi.mock("./diffs/DiffCommentAnnotation", () => ({ DiffCommentAnnotation: () => null }));
vi.mock("./diffs/DiffFileTree", () => ({ DiffFileTree: () => null }));
vi.mock("./DiffFilePathCopyButton", () => ({ DiffFilePathCopyButton: () => null }));
// Go to Declaration reaches the router and server state this file mocks only in part.
vi.mock("./diffs/sbs/useSbsCodeNavigation", () => ({
  useSbsCodeNavigation: () => ({ onTokenActivate: undefined, popup: null }),
}));

import DiffPanel from "./DiffPanel";
import { useDiffPanelSessionStore, useDiffPanelStore } from "~/diffPanelStore";
import { useReviewNoteRevealStore } from "~/reviewNotes";

const cwd = "/project-worktree";
const errorMessage = "Could not find a common commit between 'origin/orphan' and HEAD.";

function preview(): ReviewDiffPreviewResult {
  return {
    cwd,
    generatedAt: DateTime.makeUnsafe("2026-10-30T00:00:00Z"),
    sources: [
      {
        id: "branch",
        kind: "branch-range",
        title: "Changes",
        baseRef: "main",
        headRef: "dev",
        diff: "",
        diffHash: "empty",
        truncated: false,
        patchesDeferred: true,
        files: [],
      },
    ],
  };
}

function setup(failedBaseRef: string | null) {
  const reset = () => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      keepSelectionOnOpenThreadKey: null,
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  };
  reset();
  state.diffFilesCollapsed = false;
  state.settings = {};
  state.turnItems = [];
  state.contents = null;
  state.contentsUnreadable = false;
  const patch = Atom.make<AsyncResult.AsyncResult<ReviewDiffPreviewSource, Error>>(
    AsyncResult.initial(),
  );
  state.patch = patch;
  state.threadRef = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  };
  state.thread = makeThreadFixture({
    ...state.threadRef,
    id: state.threadRef.threadId,
    projectId: ProjectId.make("project"),
    branch: "dev",
    worktreePath: cwd,
  });
  state.previews.clear();
  state.previews.set(null, Atom.make(AsyncResult.success(preview())));
  state.previews.set("main", Atom.make(AsyncResult.success(preview())));
  state.previews.set(failedBaseRef, Atom.make(AsyncResult.fail(new Error(errorMessage))));
  state.config = Atom.make(null);
  state.status = Atom.make(
    AsyncResult.success({
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "dev",
      hasWorkingTreeChanges: false,
      workingTree: { rootPath: cwd, files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    }),
  );
  const refs = (names: string[], isRemote: boolean): VcsListRefsResult => ({
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: names.length,
    refs: names.map((name) => ({
      name,
      isRemote,
      ...(isRemote ? { remoteName: "origin" } : {}),
      current: name === "dev",
      isDefault: name === "main",
      worktreePath: null,
    })),
  });
  state.localRefs = Atom.make(AsyncResult.success(refs(["dev", "main"], false)));
  state.remoteRefs = Atom.make(AsyncResult.success(refs(["origin/orphan"], true)));
  state.commits = Atom.make(AsyncResult.success({ commits: [], truncated: false }));
  useDiffPanelStore.getState().selectBranchBaseRef(state.threadRef, failedBaseRef);
  const registry = AtomRegistry.make();
  return {
    registry,
    patch,
    threadRef: state.threadRef,
    [Symbol.dispose]() {
      registry.dispose();
      reset();
    },
  };
}

it.each([
  {
    name: "a saved unrelated branch",
    failedBaseRef: "origin/orphan",
    recovery: "Automatic",
    baseRef: null,
  },
  {
    name: "an automatic base with unrelated history",
    failedBaseRef: null,
    recovery: "main",
    baseRef: "main",
  },
])(
  "recovers from $name without leaving the diff panel",
  async ({ failedBaseRef, recovery, baseRef }) => {
    using context = setup(failedBaseRef);
    await using screen = await render(
      <RegistryContext.Provider value={context.registry}>
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByText(errorMessage, { exact: true })).toBeVisible();
    const selector = screen.getByRole("combobox", { name: /Change comparison target/ });
    await vi.waitFor(() => expect(selector.query()).not.toBeNull());
    await userEvent.click(selector);
    await expect.element(page.getByRole("option", { name: "main", exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("option", { name: recovery, exact: true }));
    await expect.element(screen.getByText("No net changes in this selection.")).toBeVisible();
    await expect.element(screen.getByText(errorMessage, { exact: true })).not.toBeInTheDocument();
    const key = scopedThreadKey(context.threadRef);
    await vi.waitFor(() => {
      expect(useDiffPanelStore.getState().byThreadKey[key]).toEqual({ kind: "branch", baseRef });
      expect(useDiffPanelStore.getState().branchBaseRefByThreadKey[key]).toBe(baseRef);
    });
  },
);

it.each([false, true])(
  "expands an unloaded file on the first click with default collapse %s",
  async (collapsed) => {
    using context = setup("origin/orphan");
    state.diffFilesCollapsed = collapsed;
    const path = `pending-${collapsed}.txt`;
    const metadata = preview();
    const source = {
      ...metadata.sources[0]!,
      files: [{ path, previousPath: null, additions: 1, deletions: 1 }],
    };
    state.previews.set("main", Atom.make(AsyncResult.success({ ...metadata, sources: [source] })));
    useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
    await using screen = await render(
      <RegistryContext.Provider value={context.registry}>
        <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
          <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
        </div>
      </RegistryContext.Provider>,
    );
    const toggle = screen.getByRole("button", { name: `Expand ${path}`, exact: true });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    await act(() =>
      context.registry.set(
        context.patch,
        AsyncResult.success({
          ...source,
          diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`,
        }),
      ),
    );
    const loadedToggle = screen.getByRole("button", { name: `Collapse ${path}`, exact: true });
    await expect.element(loadedToggle).toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByText("after", { exact: true })).toBeVisible();
    await userEvent.click(loadedToggle);
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  },
);

it.each([
  { name: "while side by side showed, then the panel narrowed", narrowFirst: false },
  { name: "while the panel was narrow", narrowFirst: true },
])("opens a note asked for $name, once side by side shows again", async ({ narrowFirst }) => {
  using context = setup("origin/orphan");
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  // The panel fills the page, so the page's width decides between side by side and stacked.
  const narrow = () => page.viewport(480, 900);
  const wide = () => page.viewport(1600, 900);
  state.settings = { diffSideBySide: true };
  // Each row its own file: the diff's caches outlive a test.
  const path = narrowFirst ? "narrow.ts" : "wide.ts";
  const lines = Array.from({ length: 40 }, (_, index) => `const value${index + 1} = ${index + 1};`);
  const after = lines.with(9, "const alpha = 1;");
  state.contents = { oldContents: `${lines.join("\n")}\n`, newContents: `${after.join("\n")}\n` };
  const noteId = TurnItemId.make("turn-item:review-note:thread:0123456789abcdef0123456789abcdef");
  state.turnItems = [
    {
      item: {
        id: noteId,
        type: "dynamic_tool",
        toolName: REVIEW_NOTE_TOOL_NAME,
        input: {
          kind: "review_note",
          path,
          startLine: 10,
          endLine: 10,
          note: "Alpha replaced value ten.",
          excerpt: "const alpha = 1;",
          excerptTruncated: false,
          contentRevision: "a".repeat(40),
          runId: RunId.make("run-1"),
        },
      },
    },
  ];
  const metadata = preview();
  const source = {
    ...metadata.sources[0]!,
    files: [{ path, previousPath: null, additions: 1, deletions: 1 }],
  };
  state.previews.set("main", Atom.make(AsyncResult.success({ ...metadata, sources: [source] })));
  useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
  const askForNote = () =>
    act(() => useReviewNoteRevealStore.getState().request(context.threadRef, noteId));

  await (narrowFirst ? narrow() : wide());
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </div>
    </RegistryContext.Provider>,
  );
  const stacked = screen.getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${path}$`) });
  const sideBySide = screen.getByText("Loading file...");
  if (narrowFirst) {
    await expect.element(stacked).toBeVisible();
    await askForNote();
  } else {
    await expect.element(sideBySide).toBeVisible();
    await askForNote();
    await narrow();
    await expect.element(stacked).toBeVisible();
  }
  await wide();
  await expect.element(sideBySide).toBeVisible();
  await act(() =>
    context.registry.set(
      context.patch,
      AsyncResult.success({
        ...source,
        diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -7,7 +7,7 @@\n${[
          " const value7 = 7;",
          " const value8 = 8;",
          " const value9 = 9;",
          "-const value10 = 10;",
          "+const alpha = 1;",
          " const value11 = 11;",
          " const value12 = 12;",
          " const value13 = 13;",
        ].join("\n")}\n`,
      }),
    ),
  );

  await expect.element(screen.getByText("Alpha replaced value ten.")).toBeVisible();
});

it("lists a note side by side cannot show when its whole file could not be loaded", async () => {
  using context = setup("origin/orphan");
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  await page.viewport(1600, 900);
  state.settings = { diffSideBySide: true };
  state.contentsUnreadable = true;
  const path = "unreadable.ts";
  const noteId = TurnItemId.make("turn-item:review-note:thread:fedcba9876543210fedcba9876543210");
  state.turnItems = [
    {
      item: {
        id: noteId,
        type: "dynamic_tool",
        toolName: REVIEW_NOTE_TOOL_NAME,
        input: {
          kind: "review_note",
          path,
          startLine: 30,
          endLine: 30,
          note: "Thirty is far from the change.",
          excerpt: "const value30 = 30;",
          excerptTruncated: false,
          contentRevision: "a".repeat(40),
          runId: RunId.make("run-1"),
        },
      },
    },
  ];
  const metadata = preview();
  const source = {
    ...metadata.sources[0]!,
    files: [{ path, previousPath: null, additions: 1, deletions: 1 }],
  };
  state.previews.set("main", Atom.make(AsyncResult.success({ ...metadata, sources: [source] })));
  useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </div>
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByText("Loading file...")).toBeVisible();
  // The new side is the blob the note was pinned on, so the note anchors as the whole file shows.
  await act(() =>
    context.registry.set(
      context.patch,
      AsyncResult.success({
        ...source,
        diff: `diff --git a/${path} b/${path}\nindex 1111111..aaaaaaa 100644\n--- a/${path}\n+++ b/${path}\n@@ -7,7 +7,7 @@\n${[
          " const value7 = 7;",
          " const value8 = 8;",
          " const value9 = 9;",
          "-const value10 = 10;",
          "+const alpha = 1;",
          " const value11 = 11;",
          " const value12 = 12;",
          " const value13 = 13;",
        ].join("\n")}\n`,
      }),
    ),
  );
  await expect.element(screen.getByText(/^The whole file could not be loaded\./)).toBeVisible();

  await act(() => useReviewNoteRevealStore.getState().request(context.threadRef, noteId));

  await expect.element(page.getByText("Not placed in this diff")).toBeVisible();
  await expect.element(page.getByText("Thirty is far from the change.")).toBeVisible();
});
