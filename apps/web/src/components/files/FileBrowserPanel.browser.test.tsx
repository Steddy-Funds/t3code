import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { RightPanelSheet } from "~/components/RightPanelSheet";
import { dismissContextMenu } from "~/contextMenuFallback";
import { isMacPlatform } from "~/lib/utils";
import { act, render } from "../../../test/render";
import FileBrowserPanel, { type ProjectPaneOptions } from "./FileBrowserPanel";
import { dispatchPreviewAction } from "../preview/previewActionBus";
import { writeExpandedDirectories } from "./fileTreeExpansion";

type DirectoryState = Omit<
  ReturnType<typeof import("./useDirectoryEntries").useDirectoryEntries>,
  "entries"
> & { entries: readonly ProjectEntry[] };

const entries: readonly ProjectEntry[] = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
];
let directory: DirectoryState;

function setup(overrides: Partial<DirectoryState> = {}): DirectoryState {
  directory = {
    entries,
    load: () => Promise.resolve(),
    refresh: () => {},
    revalidate: () => {},
    ready: true,
    error: null,
    rootFailure: null,
    isPending: false,
    loadingDirectories: new Set(),
    ...overrides,
  };
  return directory;
}
const pathSearch = {
  entries: [],
  isPending: false,
  error: null,
  truncated: false,
  refresh: () => {},
};

vi.mock("./useDirectoryEntries", () => ({ useDirectoryEntries: () => directory }));
vi.mock("~/state/queries", () => ({ useProjectPathSearch: () => pathSearch }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: () => Promise.resolve() }),
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));

const projectEntries: ProjectEntry[] = [
  { path: "src", kind: "directory" },
  { path: "src/app.ts", kind: "file" },
  { path: "README.md", kind: "file" },
  { path: "notes.txt", kind: "file" },
];

function projectPane(overrides: Partial<ProjectPaneOptions> = {}): ProjectPaneOptions {
  return {
    gitChanges: [],
    focusPending: false,
    onTreeFocused: () => {},
    onSelectOpenedFile: () => {},
    selectOpenedFileShortcut: null,
    ...overrides,
  };
}

/** Clears a focus request once the tree reports it, as the pane's store does. */
function ProjectTree(props: {
  selectedPath?: string | null;
  revealId?: number;
  pane?: ProjectPaneOptions;
}) {
  const pane = props.pane ?? projectPane();
  const [focusPending, setFocusPending] = useState(pane.focusPending);
  return (
    <>
      <input aria-label="Composer" />
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={props.selectedPath ?? null}
        selectedPathRevealId={props.revealId ?? 0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
        projectPane={{
          ...pane,
          focusPending,
          onTreeFocused: () => {
            setFocusPending(false);
            pane.onTreeFocused();
          },
        }}
      />
    </>
  );
}

function hasShadowFocus(row: HTMLElement): boolean {
  return (row.getRootNode() as ShadowRoot).activeElement === row;
}

function findTreeRow(path: string): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    if (row) return row;
  }
  return null;
}

function findTreeScroller(): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const scroller = host.shadowRoot?.querySelector<HTMLElement>(
      "[data-file-tree-virtualized-scroll]",
    );
    if (scroller) return scroller;
  }
  return null;
}

function isTreeRowInView(path: string): boolean {
  const rowRect = findTreeRow(path)?.getBoundingClientRect();
  const scrollerRect = findTreeScroller()?.getBoundingClientRect();
  return (
    rowRect !== undefined &&
    scrollerRect !== undefined &&
    rowRect.top >= scrollerRect.top &&
    rowRect.bottom <= scrollerRect.bottom
  );
}

function sizedContainer(): HTMLElement {
  const container = document.createElement("div");
  container.style.cssText = "display:flex;flex-direction:column;height:300px;width:300px";
  return container;
}

function withDirectoryListing(listing: readonly ProjectEntry[]): Disposable {
  directory.entries = listing;
  return {
    [Symbol.dispose]: () => {
      directory.entries = entries;
      directory.ready = true;
    },
  };
}

describe("FileBrowserPanel", () => {
  it("copies with the pointer and returns to the row after keyboard dismissal", async () => {
    setup();
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />,
    );
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    findTreeRow("README.md")!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 2,
      }),
    );
    const action = page.getByRole("menuitem", { name: "Copy mention", exact: true });
    await expect.element(action).toBeVisible();
    await userEvent.click(action);
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("[README.md](README.md)"));

    const row = findTreeRow("README.md")!;
    await userEvent.keyboard("{Tab}");
    row.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect.element(action).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect((row.getRootNode() as ShadowRoot).activeElement).toBe(row));
  });

  it("dragging a file row carries a composer mention without opening it, and dragend releases it", async () => {
    setup();
    const onOpenFile = vi.fn();
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={onOpenFile}
        workspaceMutationId={null}
      />,
    );
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    const row = findTreeRow("README.md")!;

    const dataTransfer = new DataTransfer();
    row.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, composed: true, dataTransfer }),
    );
    // The tree selects the row the drag picked up; mid-drag that must not open it.
    row.click();
    await vi.waitFor(() => expect(row.getAttribute("aria-selected")).toBe("true"));

    expect(dataTransfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toContain("README.md");
    expect(onOpenFile).not.toHaveBeenCalled();

    row.dispatchEvent(new DragEvent("dragend", { bubbles: true, composed: true, dataTransfer }));
    await vi.waitFor(() => expect(row.getAttribute("aria-selected")).not.toBe("true"));

    row.click();
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledTimes(1));

    // The selection stays put, so reopening the selected file must not depend on a selection change.
    row.click();
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledTimes(2));
  });

  it("keeps an expanded folder open when a very large listing rebuilds the tree", async () => {
    setup();
    using _listing = withDirectoryListing(entries);
    const renderPanel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-large-folder-1"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    await using screen = await render(renderPanel());
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    findTreeRow("src/")!.click();
    await vi.waitFor(() => expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true"));

    directory.entries = [
      ...entries,
      // Out of sort order, because inserting in order hides the cost of each insert.
      ...Array.from({ length: 2_000 }, (_, index): ProjectEntry => {
        const name = String((index * 7_919) % 2_000).padStart(4, "0");
        return { path: `src/generated-${name}`, kind: "directory" };
      }),
    ];
    await screen.rerender(renderPanel());

    await vi.waitFor(() => expect(findTreeRow("src/generated-0000/")).not.toBeNull());
    expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the selected file through a very large listing without reopening it", async () => {
    setup();
    const onOpenFile = vi.fn();
    const renderPanel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-large-folder-2"
        projectName="repo"
        selectedPath="src/aaa.ts"
        selectedPathRevealId={1}
        onOpenFile={onOpenFile}
        workspaceMutationId={null}
      />
    );
    using _listing = withDirectoryListing([...entries, { path: "src/aaa.ts", kind: "file" }]);
    await using screen = await render(renderPanel());
    await vi.waitFor(() =>
      expect(findTreeRow("src/aaa.ts")?.getAttribute("aria-selected")).toBe("true"),
    );

    directory.entries = [
      ...directory.entries,
      ...Array.from({ length: 2_000 }, (_, index): ProjectEntry => {
        const name = String((index * 7_919) % 2_000).padStart(4, "0");
        return { path: `src/generated-${name}.ts`, kind: "file" };
      }),
    ];
    await screen.rerender(renderPanel());

    await vi.waitFor(() => expect(findTreeRow("src/generated-0000.ts")).not.toBeNull());
    expect(findTreeRow("src/aaa.ts")?.getAttribute("aria-selected")).toBe("true");
    expect(findTreeRow("src/")?.getAttribute("aria-expanded")).toBe("true");
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it("keeps an open search accurate when a very large folder listing arrives", async () => {
    setup();
    const renderPanel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-large-folder-3"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    using _listing = withDirectoryListing([
      ...entries,
      { path: "lib", kind: "directory" },
      { path: "lib/generated-existing.ts", kind: "file" },
    ]);
    await using screen = await render(renderPanel());
    const search = page.getByRole("searchbox", { name: "Search repo files" });
    await userEvent.fill(search, "generated-");
    await vi.waitFor(() => expect(findTreeRow("lib/generated-existing.ts")).not.toBeNull());

    directory.entries = [
      ...directory.entries,
      ...Array.from({ length: 2_000 }, (_, index): ProjectEntry => {
        const name = String((index * 7_919) % 2_000).padStart(4, "0");
        return { path: `src/generated-${name}.ts`, kind: "file" };
      }),
    ];
    await screen.rerender(renderPanel());

    await vi.waitFor(() => expect(findTreeRow("src/generated-0000.ts")).not.toBeNull());
    expect(findTreeRow("lib/generated-existing.ts")).not.toBeNull();
    await expect.element(search).toHaveValue("generated-");
  });

  it("mod+f from a tree row, or the panel find command, focuses the file search", async () => {
    setup();
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
        answersPanelFind
      />,
    );
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    findTreeRow("README.md")!.focus();

    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    await userEvent.keyboard(`{${modifier}>}f{/${modifier}}`);

    const search = page.getByRole("searchbox", { name: "Search repo files" });
    await expect.element(search).toHaveFocus();

    (search.element() as HTMLElement).blur();
    dispatchPreviewAction("find");
    await expect.element(search).toHaveFocus();
  });

  it("Escape in the file search clears it without closing the panel sheet", async () => {
    setup();
    const onCloseSheet = vi.fn();
    await using _screen = await render(
      <RightPanelSheet animationDurationMs={0} open onClose={onCloseSheet}>
        <FileBrowserPanel
          environmentId={EnvironmentId.make("env-files")}
          cwd="/repo"
          projectName="repo"
          selectedPath={null}
          selectedPathRevealId={0}
          onOpenFile={() => {}}
          workspaceMutationId={null}
        />
      </RightPanelSheet>,
    );
    const search = page.getByRole("searchbox", { name: "Search repo files" });
    await userEvent.fill(search, "read");
    for (const composition of [
      { key: "Escape", isComposing: true, keyCode: 27 },
      { key: "Escape", isComposing: false, keyCode: 229 },
    ]) {
      // Safari ends the composition just before the Escape keydown.
      await act(() => {
        search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        search
          .element()
          .dispatchEvent(new KeyboardEvent("keydown", { ...composition, bubbles: true }));
      });
      await expect.element(search).toHaveValue("read");
    }
    expect(search.element().getAttribute("type")).toBe("text");

    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    await expect.element(search).toHaveFocus();
    await act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true }),
      );
    });
    expect(onCloseSheet).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(onCloseSheet).toHaveBeenCalledOnce());
  });

  it("keeps expanded folders when the panel remounts", async () => {
    setup();
    const panel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    {
      await using _first = await render(panel());
      await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
      findTreeRow("src/")!.click();
      await vi.waitFor(() =>
        expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true"),
      );
    }

    using revalidate = vi.spyOn(directory, "revalidate");
    await using _second = await render(panel());
    await vi.waitFor(() => expect(findTreeRow("src/")).not.toBeNull());
    await vi.waitFor(() => expect(findTreeRow("src/")!.getAttribute("aria-expanded")).toBe("true"));

    // Refresh revalidates the folders behind the rows on screen: the open one and the root.
    // The tree can render its rows again at any time, so compare folders, not calls.
    revalidate.mockClear();
    await userEvent.click(page.getByRole("button", { name: "Refresh workspace files" }));
    expect(new Set(revalidate.mock.calls.flat())).toEqual(new Set(["src", ""]));
  });

  it("opens a chain of single folders from one click and keeps it closed once closed", async () => {
    setup();
    const chain: readonly ProjectEntry[] = [
      { path: "tests", kind: "directory" },
      { path: "tests/edit", kind: "directory" },
      { path: "tests/edit/unit", kind: "directory" },
      { path: "tests/edit/unit/a.ts", kind: "file" },
    ];
    const panel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-single-folder-chain"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    using _listing = withDirectoryListing(chain.slice(0, 1));
    {
      await using screen = await render(panel());
      await vi.waitFor(() => expect(findTreeRow("tests/")).not.toBeNull());
      findTreeRow("tests/")!.click();
      await vi.waitFor(() =>
        expect(findTreeRow("tests/")!.getAttribute("aria-expanded")).toBe("true"),
      );
      for (const listed of [2, 3, 4]) {
        directory.entries = chain.slice(0, listed);
        await screen.rerender(panel());
      }
      await vi.waitFor(() => expect(findTreeRow("tests/edit/unit/a.ts")).not.toBeNull());

      findTreeRow("tests/edit/unit/")!.click();
      await vi.waitFor(() => expect(findTreeRow("tests/edit/unit/a.ts")).toBeNull());
      directory.entries = [...chain, { path: "tests/edit/unit/b.ts", kind: "file" }];
      await screen.rerender(panel());
      expect(findTreeRow("tests/edit/unit/")!.getAttribute("aria-expanded")).toBe("false");
    }

    directory.entries = [...chain, { path: "pkg", kind: "directory" }];
    await using remounted = await render(panel());
    await vi.waitFor(() => expect(findTreeRow("tests/edit/unit/")).not.toBeNull());
    expect(findTreeRow("tests/edit/unit/")!.getAttribute("aria-expanded")).toBe("false");

    // An ignored folder can hold tens of thousands of entries, so it still opens by hand.
    findTreeRow("pkg/")!.click();
    await vi.waitFor(() => expect(findTreeRow("pkg/")!.getAttribute("aria-expanded")).toBe("true"));
    directory.entries = [
      ...directory.entries,
      { path: "pkg/node_modules", kind: "directory", ignored: true },
    ];
    await remounted.rerender(panel());
    await vi.waitFor(() => expect(findTreeRow("pkg/node_modules/")).not.toBeNull());
    expect(findTreeRow("pkg/node_modules/")!.getAttribute("aria-expanded")).toBe("false");
  });

  describe("revealing a folder while folders above it are still loading", () => {
    const roots = Array.from({ length: 12 }, (_, index): ProjectEntry => {
      return { path: `d${String(index).padStart(2, "0")}`, kind: "directory" };
    });
    const listing = (parent: string, count: number) =>
      Array.from({ length: count }, (_, index): ProjectEntry => {
        return { path: `${parent}/f${String(index).padStart(3, "0")}.ts`, kind: "file" };
      });
    const renderPanel = (cwd: string) => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd={cwd}
        projectName="repo"
        selectedPath="d09"
        selectedPathRevealId={1}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    // The tree mounts empty and measures itself before the first listing arrives, as it does for real.
    async function renderRevealedPanel(cwd: string) {
      writeExpandedDirectories(`env-files:${cwd}`, ["d01/", "d01/sub/"]);
      directory.ready = false;
      await using stack = new AsyncDisposableStack();
      const screen = stack.use(await render(renderPanel(cwd), { container: sizedContainer() }));
      directory.entries = roots;
      directory.ready = true;
      await screen.rerender(renderPanel(cwd));
      await vi.waitFor(() => expect(isTreeRowInView("d09/")).toBe(true));
      stack.move();
      return screen;
    }

    it("keeps the revealed folder in view as restored folders above it load", async () => {
      setup();
      const cwd = "/repo-reveal-follows-loading";
      using _listing = withDirectoryListing([]);
      await using screen = await renderRevealedPanel(cwd);

      // d01 lists after the reveal and holds another restored folder, which lists in turn.
      directory.entries = [...roots, ...listing("d01", 60), { path: "d01/sub", kind: "directory" }];
      await screen.rerender(renderPanel(cwd));
      await vi.waitFor(() => expect(findTreeScroller()!.scrollHeight).toBeGreaterThan(60 * 24));
      directory.entries = [...directory.entries, ...listing("d01/sub", 60)];
      await screen.rerender(renderPanel(cwd));

      await vi.waitFor(() => expect(isTreeRowInView("d09/")).toBe(true));
    });

    it("leaves the scroll position alone once the user scrolls the tree", async () => {
      setup();
      const cwd = "/repo-reveal-user-scroll";
      using _listing = withDirectoryListing([]);
      await using screen = await renderRevealedPanel(cwd);

      const scroller = findTreeScroller()!;
      scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, composed: true }));
      scroller.scrollTop = 0;
      directory.entries = [...roots, ...listing("d01", 60)];
      await screen.rerender(renderPanel(cwd));
      await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(60 * 24));

      expect(scroller.scrollTop).toBe(0);
    });
  });

  it("opens a file through the latest onOpenFile, as the Project pane keeps its tree across threads", async () => {
    setup();
    const first = vi.fn();
    const latest = vi.fn();
    const panel = (onOpenFile: (relativePath: string) => void) => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={onOpenFile}
        workspaceMutationId={null}
      />
    );
    await using screen = await render(panel(first));
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());

    await screen.rerender(panel(latest));
    findTreeRow("README.md")!.click();

    await vi.waitFor(() => expect(latest).toHaveBeenCalledExactlyOnceWith("README.md"));
    expect(first).not.toHaveBeenCalled();
  });

  it("in the Project pane, colours changes and follows the opened file without taking focus, and after a search", async () => {
    setup({ entries: projectEntries });
    const pane = projectPane({
      gitChanges: [
        { path: "src/app.ts", change: "modified" },
        { path: "notes.txt", change: "untracked" },
      ],
    });
    await using screen = await render(<ProjectTree pane={pane} />);
    await vi.waitFor(() =>
      expect(findTreeRow("notes.txt")?.getAttribute("data-item-git-status")).toBe("untracked"),
    );
    expect(findTreeRow("src/")?.hasAttribute("data-item-contains-git-change")).toBe(true);

    const composer = page.getByRole("textbox", { name: "Composer" });
    await userEvent.click(composer);
    await screen.rerender(<ProjectTree pane={pane} selectedPath="src/app.ts" revealId={1} />);
    await vi.waitFor(() =>
      expect(findTreeRow("src/app.ts")?.getAttribute("aria-selected")).toBe("true"),
    );
    expect(findTreeRow("src/app.ts")?.getAttribute("data-item-git-status")).toBe("modified");
    await expect.element(composer).toHaveFocus();

    const search = page.getByRole("searchbox");
    await userEvent.click(search);
    await userEvent.keyboard("read");
    await screen.rerender(<ProjectTree pane={pane} selectedPath="notes.txt" revealId={2} />);
    await expect.element(search).toHaveValue("read");
    await expect.element(search).toHaveFocus();
    expect(findTreeRow("notes.txt")?.getAttribute("aria-selected")).not.toBe("true");

    await userEvent.clear(search);
    await vi.waitFor(() =>
      expect(findTreeRow("notes.txt")?.getAttribute("aria-selected")).toBe("true"),
    );
    expect(findTreeRow("src/app.ts")?.getAttribute("aria-selected")).not.toBe("true");
  });

  it("in the Project pane, a focus request lands on the opened file's row, and typing there searches", async () => {
    setup({ entries: projectEntries });
    const onTreeFocused = vi.fn();
    await using _screen = await render(
      <ProjectTree
        selectedPath="src/app.ts"
        revealId={1}
        pane={projectPane({ focusPending: true, onTreeFocused })}
      />,
    );
    await vi.waitFor(() => {
      const row = findTreeRow("src/app.ts");
      expect(row && hasShadowFocus(row)).toBe(true);
    });
    expect(onTreeFocused).toHaveBeenCalledOnce();

    // "n" matches notes.txt only, so the focused row is filtered out.
    await userEvent.keyboard("n");
    const search = page.getByRole("searchbox");
    await expect.element(search).toHaveFocus();
    await expect.element(search).toHaveValue("n");
    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() => {
      const focused = document.activeElement?.shadowRoot?.activeElement;
      expect(focused?.getAttribute("data-item-path")).toBe("notes.txt");
    });
  });

  it("in the Project pane, a root that vanished says so, takes the focus request, and retries", async () => {
    const refresh = vi.fn();
    setup({
      entries: [],
      ready: false,
      error: "Workspace root does not exist.",
      rootFailure: "workspace_root_not_found",
      refresh,
    });
    const onTreeFocused = vi.fn();
    await using _screen = await render(
      <ProjectTree pane={projectPane({ focusPending: true, onTreeFocused })} />,
    );
    await expect
      .element(page.getByText("This folder no longer exists. Its worktree may have been removed."))
      .toBeVisible();
    await expect.element(page.getByText("Loading files…")).not.toBeInTheDocument();
    const retry = page.getByRole("button", { name: "Retry" });
    await expect.element(retry).toHaveFocus();
    expect(onTreeFocused).toHaveBeenCalledOnce();
    await userEvent.click(retry);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
