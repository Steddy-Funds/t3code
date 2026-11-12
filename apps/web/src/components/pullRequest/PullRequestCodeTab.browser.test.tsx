import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type ClientSettings,
  type PullRequestDetailView,
  type PullRequestDiffResult,
  type PullRequestReviewThread,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { ComponentProps } from "react";

import "~/index.css";

const { diffAtom, pagedDiffAtom } = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const filePatch = (path: string) =>
    [
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,6 +1,6 @@",
      "-before()",
      "+after()",
      " one()",
      " two()",
      " three()",
      " four()",
      " five()",
      "",
    ].join("\n");
  const firstPage: PullRequestDiffResult = {
    patch: filePatch("a.ts"),
    truncated: false,
    nextCursor: null,
  };
  const pages: Record<string, PullRequestDiffResult> = {
    first: {
      patch: Array.from({ length: 40 }, (_, index) => filePatch(`early-${index}.ts`)).join(""),
      truncated: true,
      nextCursor: "page-2",
    },
    "page-2": { patch: filePatch("late.ts"), truncated: false, nextCursor: null },
  };
  return {
    // An environment query whose refetch returns equal content hands back the previous value
    // itself, so a refresh publishes a new result around the very same page.
    diffAtom: Atom.make(() => AsyncResult.success(firstPage)),
    pagedDiffAtom: Atom.family((cursor: string) =>
      Atom.make(() => AsyncResult.success(pages[cursor]!)),
    ),
  };
});

const mocks = vi.hoisted(() => ({
  paged: false,
  diffCommits: [] as Array<string | undefined>,
  diffCursors: [] as Array<string | undefined>,
  fileContents: vi.fn(),
  updateClientSettings: vi.fn(),
}));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) =>
    command === "diffFileContents" ? mocks.fileContents : vi.fn()) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      diffFileContents: "diffFileContents" as never,
      diff: (({ input }: { input: { cursor?: string; commit?: string } }) => {
        mocks.diffCommits.push(input.commit);
        mocks.diffCursors.push(input.cursor);
        return mocks.paged ? pagedDiffAtom(input.cursor ?? "first") : diffAtom;
      }) as never,
    },
  };
});
// A real write would reach the settings file and not reach this test's snapshot.
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  updateClientSettings: mocks.updateClientSettings as never,
}));
// The real tree lives in a shadow root; a stub keeps what the tab hands it reachable.
vi.mock(import("../diffs/DiffFileTree"), () => ({
  DiffFileTree: (({ entries, onSelectFile, footer }: ComponentProps<typeof DiffFileTree>) => (
    <div>
      {entries.map((entry) => (
        <button key={entry.path} type="button" onClick={() => onSelectFile(entry.path)}>
          {`tree:${entry.path}`}
        </button>
      ))}
      {footer}
    </div>
  )) as never,
}));

import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import type { DiffFileTree } from "../diffs/DiffFileTree";
import { render, type Screen } from "../../../test/render";
import PullRequestCodeTab from "./PullRequestCodeTab";
import { pullRequestReviewKey, usePullRequestReviewStore } from "./pullRequestReviewStore";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: false, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

// The whole file behind a.ts's hunk (old lines 1-6, new lines 1-6), plus lines it leaves out.
const OLD_CONTENTS = [
  "before()",
  "one()",
  "two()",
  "three()",
  "four()",
  "five()",
  "six()",
  "seven()",
  "eight()",
  "nine()",
].join("\n");
const NEW_CONTENTS = OLD_CONTENTS.replace("before()", "after()");

function setup({ paged }: { paged: boolean }) {
  mocks.paged = paged;
  mocks.diffCommits = [];
  mocks.diffCursors = [];
  mocks.updateClientSettings.mockReset();
  mocks.fileContents.mockReset();
  mocks.fileContents.mockResolvedValue({
    _tag: "Success",
    value: { oldContents: OLD_CONTENTS, newContents: NEW_CONTENTS },
  });
}

const tab = (
  refreshToken: number,
  revealRequest: { readonly path: string; readonly nonce: number } | null = null,
) => (
  <PullRequestCodeTab
    scrollerRef={() => {}}
    environmentId={EnvironmentId.make("environment")}
    reference={detail}
    detail={detail}
    selectedCommitOid={null}
    onSelectedCommitChange={() => {}}
    onRefresh={() => {}}
    refreshToken={refreshToken}
    revealRequest={revealRequest}
  />
);

it("keeps the diff after a refresh that brings back the same page", async () => {
  setup({ paged: false });
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(tab(0), { container });
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();

  await screen.rerender(tab(1));

  await expect
    .element(screen.getByText("This pull request has no file changes."))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
});

function pagedContainer() {
  const container = document.createElement("div");
  container.className = "flex h-[500px] w-[900px]";
  return container;
}

async function expectFileHeaderShown(
  screen: Awaited<ReturnType<typeof render>>,
  container: HTMLElement,
  path: string,
) {
  const header = screen.getByText(path, { exact: true }).first();
  await expect.element(header).toBeInTheDocument();
  await vi.waitFor(() => {
    const bounds = container.querySelector(".diff-render-surface")!.getBoundingClientRect();
    const { top, bottom } = header.element().getBoundingClientRect();
    expect(top).toBeGreaterThanOrEqual(bounds.top);
    expect(bottom).toBeLessThanOrEqual(bounds.bottom);
  });
}

it("scrolls to a file asked for as the tab opens", async () => {
  setup({ paged: true });
  const container = pagedContainer();
  await using screen = await render(tab(0, { path: "early-39.ts", nonce: 1 }), { container });

  await expectFileHeaderShown(screen, container, "early-39.ts");
});

it("pages forward to a file asked for that is not loaded yet, then scrolls to it", async () => {
  setup({ paged: true });
  const container = pagedContainer();
  await using screen = await render(tab(0), { container });
  await expect.element(screen.getByText("early-0.ts", { exact: true }).first()).toBeVisible();

  await screen.rerender(tab(0, { path: "late.ts", nonce: 1 }));

  await expectFileHeaderShown(screen, container, "late.ts");
});

it("never requests the diff of a selected commit the pull request no longer has", async () => {
  setup({ paged: false });
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  // The timeline can open a commit that a force-push removed from the pull request.
  await using screen = await render(
    <PullRequestCodeTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      reference={detail}
      detail={{
        ...detail,
        commits: [
          {
            oid: "kept",
            messageHeadline: "Kept commit",
            committedDate: "2026-09-01T00:00:00Z",
          },
        ],
      }}
      selectedCommitOid="gone"
      onSelectedCommitChange={() => {}}
      onRefresh={() => {}}
    />,
    { container },
  );

  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Diff scope: All commits" }))
    .toBeVisible();
  expect(mocks.diffCommits).not.toContain("gone");
});

// Side by side

const COLLAPSE_UNCHANGED_KEY = "t3code.sbsDiff.collapseUnchanged";
const FILE_TREE_KEY = "t3code.pullRequestFileTreeOpen";

function withSettings(overrides: Partial<ClientSettings>): Disposable {
  const previous = getClientSettings();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, ...overrides });
  return { [Symbol.dispose]: () => __setClientSettingsForTests(previous) };
}

function withStorage(items: Readonly<Record<string, string>>): Disposable {
  for (const [key, value] of Object.entries(items)) localStorage.setItem(key, value);
  return {
    [Symbol.dispose]: () => {
      for (const key of Object.keys(items)) localStorage.removeItem(key);
    },
  };
}

function withPendingComments(comments: ReadonlyArray<{ position: unknown; body: string }>) {
  const key = pullRequestReviewKey(detail);
  usePullRequestReviewStore.setState({
    drafts: {
      [key]: comments.map((comment, index) => ({
        id: `pending-${index}`,
        path: "a.ts",
        ...comment,
      })) as never,
    },
  });
  return { [Symbol.dispose]: () => usePullRequestReviewStore.getState().clear(key) };
}

function areaOf(width: number) {
  const container = document.createElement("div");
  container.style.cssText = `display:flex;flex-direction:column;height:700px;width:${width}px`;
  return container;
}

const sbsTab = ({
  shown = detail,
  selectedCommitOid = null,
  revealRequest = null,
}: {
  readonly shown?: PullRequestDetailView;
  readonly selectedCommitOid?: string | null;
  readonly revealRequest?: { readonly path: string; readonly nonce: number } | null;
} = {}) => (
  <PullRequestCodeTab
    scrollerRef={() => {}}
    environmentId={EnvironmentId.make("environment")}
    reference={shown}
    detail={shown}
    selectedCommitOid={selectedCommitOid}
    onSelectedCommitChange={() => {}}
    onRefresh={() => {}}
    revealRequest={revealRequest}
  />
);

const query = (screen: Screen, selector: string) =>
  screen.container.querySelector<HTMLElement>(selector);
const titleOf = (screen: Screen) => query(screen, "[data-sbs-file-title]")?.textContent;
const sbsRow = (screen: Screen, side: "additions" | "deletions", line: number) =>
  Array.from(
    screen.container.querySelectorAll<HTMLElement>(
      `[data-sbs-scroller="${side}"] .sbs-row[data-sbs-index]`,
    ),
  ).find((row) => row.querySelector(".sbs-gutter")?.textContent === String(line));
const gutterOf = (screen: Screen, side: "additions" | "deletions", line: number) =>
  sbsRow(screen, side, line)!.querySelector<HTMLElement>(".sbs-gutter")!;
const markers = (screen: Screen) =>
  Array.from(screen.container.querySelectorAll("button[data-sbs-annotation]")).map((marker) =>
    marker.getAttribute("data-sbs-annotation"),
  );
const markerOf = (screen: Screen, id: string) =>
  query(screen, `button[data-sbs-annotation="${id}"]`);

const threadOf = (
  id: string,
  side: PullRequestReviewThread["side"],
  line: number,
  body: string,
): PullRequestReviewThread => ({
  id,
  path: "a.ts",
  line,
  side,
  isResolved: false,
  isOutdated: false,
  comments: [
    {
      id: `${id}-comment`,
      author: { login: "reviewer", name: null, avatarUrl: null },
      body,
      createdAt: "2026-09-01T00:00:00Z",
      url: null,
    },
  ],
});

const commentingDetail: PullRequestDetailView = {
  ...detail,
  capabilities: {
    ...detail.capabilities,
    review: { ...detail.capabilities.review, inlineComment: true },
  },
  viewerPermissions: { ...detail.viewerPermissions, comment: true },
  reviewThreads: [
    threadOf("thread-new", "right", 3, "Thread on the new side"),
    threadOf("thread-old", "left", 1, "Thread on the old side"),
  ],
};

it("shows the first file side by side when the setting is on and the area is wide", async () => {
  setup({ paged: true });
  using _settings = withSettings({ diffSideBySide: true });
  await using screen = await render(sbsTab(), { container: areaOf(1000) });

  await vi.waitFor(() => expect(titleOf(screen)).toBe("early-0.ts"));
  await vi.waitFor(() => expect(sbsRow(screen, "additions", 1)?.textContent).toContain("after()"));
  expect(sbsRow(screen, "deletions", 1)?.textContent).toContain("before()");
  expect(query(screen, ".diff-render-surface")).toBeNull();
  await expect
    .element(screen.getByText("Side by side needs a wider panel."))
    .not.toBeInTheDocument();
});

it("keeps the stacked view when the setting is off", async () => {
  setup({ paged: false });
  using _settings = withSettings({ diffSideBySide: false });
  await using screen = await render(sbsTab(), { container: areaOf(1000) });

  await vi.waitFor(() => expect(query(screen, ".diff-render-surface")).not.toBeNull());
  expect(query(screen, "[data-sbs-view]")).toBeNull();
});

it("names the file in plain text, with no button to open it", async () => {
  setup({ paged: false });
  using _settings = withSettings({ diffSideBySide: true });
  await using screen = await render(sbsTab(), { container: areaOf(1000) });

  await vi.waitFor(() => expect(titleOf(screen)).toBe("a.ts"));
  expect(query(screen, "[data-sbs-file-title]")?.tagName).toBe("SPAN");
  await expect.element(screen.getByRole("button", { name: "a.ts" })).not.toBeInTheDocument();
});

const LAYOUT_CHOICES = [
  {
    from: { diffSideBySide: true, diffLayout: "split" },
    pick: "Stacked diff view",
    writes: { diffLayout: "stacked", diffSideBySide: false },
  },
  {
    from: { diffSideBySide: true, diffLayout: "stacked" },
    pick: "Split diff view",
    writes: { diffLayout: "split", diffSideBySide: false },
  },
  {
    from: { diffSideBySide: false, diffLayout: "split" },
    pick: "Side-by-side diff view",
    writes: { diffSideBySide: true },
  },
] as const;

it.each(LAYOUT_CHOICES)("the layout toggles write $writes for $pick", async (choice) => {
  setup({ paged: false });
  using _settings = withSettings(choice.from);
  await using screen = await render(sbsTab(), { container: areaOf(1000) });
  const pressed = choice.from.diffSideBySide ? "Side-by-side diff view" : "Split diff view";
  for (const name of ["Stacked diff view", "Split diff view", "Side-by-side diff view"]) {
    await expect
      .element(screen.getByRole("button", { name }))
      .toHaveAttribute("aria-pressed", name === pressed ? "true" : "false");
  }

  await screen.getByRole("button", { name: choice.pick }).click();

  expect(mocks.updateClientSettings.mock.calls).toEqual([[choice.writes]]);
});

const MENU_CHOICES = [
  {
    from: { diffSideBySide: false, diffLayout: "stacked" },
    pick: "Split",
    writes: { diffLayout: "split", diffSideBySide: false },
  },
  {
    from: { diffSideBySide: false, diffLayout: "split" },
    pick: "Side by side",
    writes: { diffSideBySide: true },
  },
  {
    from: { diffSideBySide: true, diffLayout: "split" },
    pick: "Stacked",
    writes: { diffLayout: "stacked", diffSideBySide: false },
  },
] as const;

it.each(MENU_CHOICES)("the narrow menu writes $writes for $pick", async (choice) => {
  setup({ paged: false });
  using _settings = withSettings(choice.from);
  await using screen = await render(sbsTab(), { container: areaOf(480) });
  await screen.getByRole("button", { name: "Diff options" }).click();
  const checked = choice.from.diffSideBySide
    ? "Side by side"
    : choice.from.diffLayout === "split"
      ? "Split"
      : "Stacked";
  for (const name of ["Stacked", "Split", "Side by side"]) {
    await expect
      .element(page.getByRole("menuitemradio", { name, exact: true }))
      .toHaveAttribute("aria-checked", name === checked ? "true" : "false");
  }

  await page.getByRole("menuitemradio", { name: choice.pick, exact: true }).click();

  expect(mocks.updateClientSettings.mock.calls).toEqual([[choice.writes]]);
});

it("falls back to the stacked view with a note when the area is narrower than the panes need", async () => {
  setup({ paged: false });
  using _settings = withSettings({ diffSideBySide: true });
  await using screen = await render(sbsTab(), { container: areaOf(480) });

  await expect.element(screen.getByText("Side by side needs a wider panel.")).toBeVisible();
  await vi.waitFor(() => expect(query(screen, ".diff-render-surface")).not.toBeNull());
  expect(query(screen, "[data-sbs-view]")).toBeNull();
  // The setting stays on, so the menu still shows it and brings back the wrap toggle.
  await screen.getByRole("button", { name: "Diff options" }).click();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Side by side", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await expect.element(page.getByRole("menuitemcheckbox", { name: "Wrap lines" })).toBeVisible();
});

it("hides the wrap toggle and collapse-all in side by side, and shows them stacked", async () => {
  setup({ paged: false });
  const wrap = /diff line wrapping/;
  const collapse = /^(Collapse|Expand) all files$/;
  {
    using _settings = withSettings({ diffSideBySide: false });
    await using screen = await render(sbsTab(), { container: areaOf(1000) });
    await expect.element(screen.getByRole("button", { name: wrap })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: collapse })).toBeVisible();
  }
  using _settings = withSettings({ diffSideBySide: true });
  await using screen = await render(sbsTab(), { container: areaOf(1000) });
  await vi.waitFor(() => expect(query(screen, "[data-sbs-view]")).not.toBeNull());
  await expect.element(screen.getByRole("button", { name: wrap })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: collapse })).not.toBeInTheDocument();
});

it("marks review threads and pending comments on their side and line, and opens them in the card", async () => {
  setup({ paged: false });
  using _settings = withSettings({ diffSideBySide: true });
  using _comments = withPendingComments([
    { position: { kind: "added", newLine: 1 }, body: "Pending note" },
  ]);
  await using screen = await render(sbsTab({ shown: commentingDetail }), {
    container: areaOf(1000),
  });

  await vi.waitFor(() =>
    expect(markers(screen).toSorted()).toEqual(["additions:1", "additions:3", "deletions:1"]),
  );
  const inPane = (side: string, id: string) =>
    query(screen, `[data-sbs-scroller="${side}"] button[data-sbs-annotation="${id}"]`);
  expect(inPane("additions", "additions:3")).not.toBeNull();
  expect(inPane("additions", "additions:1")).not.toBeNull();
  expect(inPane("deletions", "deletions:1")).not.toBeNull();

  markerOf(screen, "additions:3")!.click();
  await expect.element(screen.getByText("Thread on the new side")).toBeVisible();
  expect(
    query(screen, "[data-sbs-annotation-card]")?.getAttribute("data-sbs-annotation-card"),
  ).toBe("additions:3");
  markerOf(screen, "deletions:1")!.click();
  await expect.element(screen.getByText("Thread on the old side")).toBeVisible();
  await expect.element(screen.getByText("Thread on the new side")).not.toBeInTheDocument();
  markerOf(screen, "additions:1")!.click();
  await expect.element(screen.getByText("Pending note")).toBeVisible();
});

it("starts a comment from lines picked in the gutter, with its box open in the card", async () => {
  setup({ paged: false });
  using _settings = withSettings({ diffSideBySide: true });
  using _storage = withStorage({ [COLLAPSE_UNCHANGED_KEY]: "false" });
  await using screen = await render(sbsTab({ shown: commentingDetail }), {
    container: areaOf(1000),
  });
  await vi.waitFor(() => expect(sbsRow(screen, "additions", 5)).toBeDefined());

  await userEvent.click(gutterOf(screen, "additions", 2));

  await expect
    .element(screen.getByRole("textbox", { name: "Comment on lines a.ts:2" }))
    .toBeVisible();
  expect(
    query(screen, "[data-sbs-annotation-card]")?.getAttribute("data-sbs-annotation-card"),
  ).toBe("additions:2");
});

it("starts no comment from a line outside the changed hunks", async () => {
  setup({ paged: false });
  using _settings = withSettings({ diffSideBySide: true });
  using _storage = withStorage({ [COLLAPSE_UNCHANGED_KEY]: "false" });
  await using screen = await render(sbsTab({ shown: commentingDetail }), {
    container: areaOf(1000),
  });
  await vi.waitFor(() => expect(sbsRow(screen, "additions", 8)).toBeDefined());

  await userEvent.click(gutterOf(screen, "additions", 8));

  // Only the two review threads are marked.
  expect(markers(screen).toSorted()).toEqual(["additions:3", "deletions:1"]);
  expect(query(screen, "[data-sbs-annotation-card]")).toBeNull();
  await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
});

it("starts no comment from selected text", async () => {
  setup({ paged: false });
  using _settings = withSettings({ diffSideBySide: true });
  await using screen = await render(sbsTab({ shown: commentingDetail }), {
    container: areaOf(1000),
  });
  await vi.waitFor(() => expect(sbsRow(screen, "additions", 2)).toBeDefined());

  const code = sbsRow(screen, "additions", 2)!.querySelector<HTMLElement>(".sbs-code")!;
  const text = document.createTreeWalker(code, NodeFilter.SHOW_TEXT).nextNode()!;
  window.getSelection()!.setBaseAndExtent(text, 0, text, 3);
  query(screen, ".sbs-diff")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

  expect(window.getSelection()?.toString()).toBe("one");
  await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
  expect(markerOf(screen, "additions:2")).toBeNull();
});

it("starts no comment when a commit is selected", async () => {
  setup({ paged: false });
  using _settings = withSettings({ diffSideBySide: true });
  using _storage = withStorage({ [COLLAPSE_UNCHANGED_KEY]: "false" });
  const commitDetail: PullRequestDetailView = {
    ...commentingDetail,
    commits: [
      { oid: "kept", messageHeadline: "Kept commit", committedDate: "2026-09-01T00:00:00Z" },
    ],
  };
  await using screen = await render(sbsTab({ shown: commitDetail, selectedCommitOid: "kept" }), {
    container: areaOf(1000),
  });
  await vi.waitFor(() => expect(sbsRow(screen, "additions", 2)).toBeDefined());

  await userEvent.click(gutterOf(screen, "additions", 2));

  expect(markerOf(screen, "additions:2")).toBeNull();
  await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
});

it("selects the file a click in the file tree names, and pages forward from the last one loaded", async () => {
  setup({ paged: true });
  using _settings = withSettings({ diffSideBySide: true });
  using _storage = withStorage({ [FILE_TREE_KEY]: "true" });
  await using screen = await render(sbsTab(), { container: areaOf(1200) });
  await vi.waitFor(() => expect(titleOf(screen)).toBe("early-0.ts"));
  const pick = (path: string) => screen.getByRole("button", { name: `tree:${path}` });

  (pick("early-5.ts").element() as HTMLElement).click();
  await vi.waitFor(() => expect(titleOf(screen)).toBe("early-5.ts"));
  (pick("early-38.ts").element() as HTMLElement).click();
  await vi.waitFor(() => expect(titleOf(screen)).toBe("early-38.ts"));
  await expect.element(pick("late.ts")).not.toBeInTheDocument();
  expect(mocks.diffCursors).not.toContain("page-2");

  // Files are listed by path, so early-9.ts is the last loaded.
  (pick("early-9.ts").element() as HTMLElement).click();

  await expect.element(pick("late.ts")).toBeInTheDocument();
  expect(mocks.diffCursors).toContain("page-2");
});

it("selects the file a reveal request names, paging forward to one not loaded yet", async () => {
  setup({ paged: true });
  using _settings = withSettings({ diffSideBySide: true });
  await using screen = await render(sbsTab(), { container: areaOf(1000) });
  await vi.waitFor(() => expect(titleOf(screen)).toBe("early-0.ts"));

  await screen.rerender(sbsTab({ revealRequest: { path: "early-7.ts", nonce: 1 } }));
  await vi.waitFor(() => expect(titleOf(screen)).toBe("early-7.ts"));

  await screen.rerender(sbsTab({ revealRequest: { path: "late.ts", nonce: 2 } }));
  await vi.waitFor(() => expect(titleOf(screen)).toBe("late.ts"));
});

it("keeps the wrap item out of the menu in side by side", async () => {
  setup({ paged: false });
  using _settings = withSettings({ diffSideBySide: true });
  // Just wide enough for the panes, and still narrow enough that the toolbar folds into its menu.
  await using screen = await render(sbsTab(), { container: areaOf(530) });
  await vi.waitFor(() => expect(query(screen, "[data-sbs-view]")).not.toBeNull());

  await screen.getByRole("button", { name: "Diff options" }).click();

  await expect
    .element(page.getByRole("menuitemradio", { name: "Side by side", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await expect
    .element(page.getByRole("menuitemcheckbox", { name: "Wrap lines" }))
    .not.toBeInTheDocument();
});
