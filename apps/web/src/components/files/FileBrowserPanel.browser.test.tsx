import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { dismissContextMenu } from "~/contextMenuFallback";
import { render } from "../../../test/render";
import FileBrowserPanel, { type ProjectPaneOptions } from "./FileBrowserPanel";

type DirectoryState = ReturnType<typeof import("./useDirectoryEntries").useDirectoryEntries>;

const defaultEntries: ProjectEntry[] = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
];
let directory: DirectoryState;

function setup(overrides: Partial<DirectoryState> = {}): DirectoryState {
  directory = {
    entries: defaultEntries,
    load: () => Promise.resolve(),
    refresh: () => {},
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
