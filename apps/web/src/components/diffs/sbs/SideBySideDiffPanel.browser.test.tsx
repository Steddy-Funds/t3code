import "~/index.css";

import {
  parseDiffFromFile,
  type FileDiffContentsLoader,
  type FileDiffLoadedFiles,
  type FileDiffMetadata,
} from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../../../test/render";
import {
  SideBySideDiffPanel,
  type SbsFileEntry,
  type SbsPatchState,
  type SideBySideDiffPanelProps,
} from "./SideBySideDiffPanel";
import { SideBySideDiffView } from "./SideBySideDiffView";

const COLLAPSE_KEY = "t3code.sbsDiff.collapseUnchanged";
const HIGHLIGHT_KEY = "t3code.sbsDiff.highlightMode";

const pad = (n: number) => String(n).padStart(3, "0");
const base = (count = 40) =>
  Array.from({ length: count }, (_, index) => `const value${pad(index + 1)} = ${index + 1};`);
const join = (lines: ReadonlyArray<string>) => lines.map((line) => `${line}\n`).join("");

/** Replaces the 1-based lines named in `changes` with `const <tag> = 1;`. */
const changed = (changes: Readonly<Record<number, string>>) =>
  base().map((line, index) => {
    const tag = changes[index + 1];
    return tag === undefined ? line : `const ${tag} = 1;`;
  });

interface Texts {
  readonly before: string;
  readonly after: string;
}

const textsOf = (changes: Readonly<Record<number, string>>): Texts => ({
  before: join(base()),
  after: join(changed(changes)),
});

const entryOf = (
  name: string,
  texts: Texts,
  options: { readonly prevName?: string } = {},
): SbsFileEntry => {
  const fileDiff = parseDiffFromFile(
    { name: options.prevName ?? name, contents: texts.before },
    { name, contents: texts.after },
  );
  return {
    fileKey: name,
    filePath: name,
    fileDiff: options.prevName ? { ...fileDiff, prevName: options.prevName } : fileDiff,
  };
};

const value = (n: number) => `const value${pad(n)} = ${n};`;

/** A patch of two hunks, 18-24 and 78-84, with lines 21 and 81 changed. */
function twoHunkEntry(name = "patch.ts"): SbsFileEntry {
  const hunk = (start: number, changedLine: number) => {
    const body = [
      ...[0, 1, 2].map((offset) => ` ${value(start + offset)}`),
      `-${value(changedLine)}`,
      `+const changed${pad(changedLine)} = ${changedLine};`,
      ...[1, 2, 3].map((offset) => ` ${value(changedLine + offset)}`),
    ];
    return `@@ -${start},7 +${start},7 @@\n${body.join("\n")}\n`;
  };
  const patch = `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${hunk(18, 21)}${hunk(78, 81)}`;
  const fileDiff = parsePatchFiles(patch)[0]!.files[0]!;
  return { fileKey: name, filePath: name, fileDiff };
}

const NO_HUNKS_TEXTS: Texts = { before: join(base()), after: join(base()) };

const settled: SbsPatchState = { pending: false, error: false, truncated: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const filesOf = (texts: Texts, name: string): FileDiffLoadedFiles => ({
  oldFile: { name, contents: texts.before },
  newFile: { name, contents: texts.after },
});

/** A loader that answers each file from `byName`. */
const loaderOf = (byName: Readonly<Record<string, Texts>>) =>
  vi.fn<FileDiffContentsLoader>(async (fileDiff) => filesOf(byName[fileDiff.name]!, fileDiff.name));

const tooLarge = { _tag: "OrchestrationGetTurnDiffFileContentsError", reason: "too_large" };
const binary = { _tag: "OrchestrationGetTurnDiffFileContentsError", reason: "binary" };

type PanelOverrides = Partial<SideBySideDiffPanelProps> & {
  readonly files: ReadonlyArray<SbsFileEntry>;
};

function Harness({ selectedFileKey, onSelectFile, ...rest }: PanelOverrides) {
  const [selected, setSelected] = useState<string | null>(selectedFileKey ?? null);
  return (
    <SideBySideDiffPanel
      selectedFileKey={selected}
      onSelectFile={(fileKey) => {
        setSelected(fileKey);
        onSelectFile?.(fileKey);
      }}
      scopeKey="scope-1"
      contentsKey="contents-1"
      ignoreWhitespace={false}
      patchState={() => settled}
      onRequestPatch={() => undefined}
      onRetryPatch={() => undefined}
      onOpenFile={() => undefined}
      {...rest}
    />
  );
}

function container() {
  const element = document.createElement("div");
  Object.assign(element.style, {
    display: "flex",
    flexDirection: "column",
    width: "1000px",
    height: "700px",
  });
  return element;
}

/** Starts each test from the settings a first-time user has, plus the ones the test names. */
function mount(
  props: PanelOverrides,
  storage: { readonly collapse?: boolean; readonly highlight?: string } = {},
) {
  localStorage.removeItem(COLLAPSE_KEY);
  localStorage.removeItem(HIGHLIGHT_KEY);
  if (storage.collapse !== undefined)
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(storage.collapse));
  if (storage.highlight !== undefined)
    localStorage.setItem(HIGHLIGHT_KEY, JSON.stringify(storage.highlight));
  // The panel needs no routes, only a box to fill.
  return render(<Harness {...props} />, { container: container(), router: false });
}

const all = (root: ParentNode, selector: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(selector));
const one = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector);

type Side = "deletions" | "additions";
const scrollerOf = (screen: Screen, side: Side) =>
  one(screen.container, `[data-sbs-scroller="${side}"]`);
const codeOf = (screen: Screen, side: Side) =>
  all(screen.container, `[data-sbs-scroller="${side}"] .sbs-row[data-sbs-index] .sbs-code`).map(
    (code) => code.textContent,
  );
const statusOf = (screen: Screen) => one(screen.container, "[data-sbs-status]")?.textContent;
const foldsOf = (screen: Screen) => all(screen.container, "button.sbs-fold[data-sbs-fold]");
const loadingOf = (screen: Screen) => screen.getByRole("status", { name: "Loading file..." });
const hasPanes = (screen: Screen) => one(screen.container, "[data-sbs-pane]") !== null;
const noticeOf = (screen: Screen) => one(screen.container, "p.border-b")?.textContent;
const bodyText = (screen: Screen) => screen.container.textContent ?? "";

async function focusPane(screen: Screen, side: Side = "additions") {
  await vi.waitFor(() => expect(scrollerOf(screen, side)).not.toBeNull());
  scrollerOf(screen, side)!.focus({ preventScroll: true });
}

async function showsFile(screen: Screen, tag: string) {
  await vi.waitFor(() => expect(codeOf(screen, "additions")).toContain(`const ${tag} = 1;`));
}

describe("showing a file", () => {
  it("loads both sides whole and shows them", async () => {
    const texts = textsOf({ 10: "alpha" });
    const loadFileContents = loaderOf({ "a.ts": texts });
    const entry = entryOf("a.ts", texts);
    await using screen = await mount({ files: [entry], loadFileContents });

    await showsFile(screen, "alpha");
    expect(loadFileContents).toHaveBeenCalledExactlyOnceWith(entry.fileDiff);
    // The whole file: lines the patch's small context would not hold.
    expect(codeOf(screen, "deletions")).toContain(value(10));
    expect(statusOf(screen)).toBe("1 of 1");
    expect(noticeOf(screen)).toBeUndefined();
  });

  it("shows the loading state until the answer arrives", async () => {
    const answer = deferred<FileDiffLoadedFiles>();
    const texts = textsOf({ 10: "alpha" });
    await using screen = await mount({
      files: [entryOf("a.ts", texts)],
      loadFileContents: () => answer.promise,
    });

    await expect.element(loadingOf(screen)).toBeVisible();
    expect(hasPanes(screen)).toBe(false);
    expect(one(screen.container, "[data-sbs-file-title]")?.textContent).toContain("a.ts");

    answer.resolve(filesOf(texts, "a.ts"));
    await showsFile(screen, "alpha");
    await expect.element(loadingOf(screen)).not.toBeInTheDocument();
  });

  it("says so when the selection has no files", async () => {
    await using screen = await mount({ files: [], loadFileContents: loaderOf({}) });

    await expect.element(screen.getByText("No files changed in this selection.")).toBeVisible();
  });

  it("opens the file from its name", async () => {
    const onOpenFile = vi.fn();
    const texts = textsOf({ 10: "alpha" });
    await using screen = await mount({
      files: [entryOf("src/a.ts", texts)],
      loadFileContents: loaderOf({ "src/a.ts": texts }),
      onOpenFile,
    });
    await showsFile(screen, "alpha");

    await userEvent.click(one(screen.container, "[data-sbs-file-title]")!);

    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("src/a.ts");
  });

  it("opens the new side's line on F4 and ignores the old side's", async () => {
    const onOpenFile = vi.fn();
    const texts = textsOf({ 10: "alpha" });
    await using screen = await mount({
      files: [entryOf("a.ts", texts)],
      loadFileContents: loaderOf({ "a.ts": texts }),
      onOpenFile,
    });
    await showsFile(screen, "alpha");

    await focusPane(screen, "additions");
    await userEvent.keyboard("{F4}");
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("a.ts", 10);
  });

  it("names the old path of a renamed file", async () => {
    const texts = textsOf({ 10: "alpha" });
    const entry = entryOf("new/name.ts", texts, { prevName: "old/name.ts" });
    await using screen = await mount({
      files: [entry],
      loadFileContents: loaderOf({ "new/name.ts": texts }),
    });
    await showsFile(screen, "alpha");

    const title = one(screen.container, "[data-sbs-file-title]")!;
    expect(title.textContent).toContain("old/name.ts");
    expect(title.textContent).toContain("new/name.ts");
    expect(title.textContent).toContain("->");
  });

  it("shows paths under the workspace root relative to it, both names of a rename, and copies the raw path", async () => {
    using write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const texts = textsOf({ 10: "alpha" });
    const entry = entryOf("/repo/src/new.ts", texts, { prevName: "/repo/src/old.ts" });
    await using screen = await mount({
      files: [entry],
      loadFileContents: loaderOf({ "/repo/src/new.ts": texts }),
      workspaceRoot: "/repo",
    });
    await showsFile(screen, "alpha");

    const title = one(screen.container, "[data-sbs-file-title]")!.textContent!;
    expect(title).toContain("src/old.ts");
    expect(title).toContain("src/new.ts");
    expect(title).not.toContain("/repo");

    await userEvent.click(screen.getByRole("button", { name: "Copy file path" }));
    await vi.waitFor(() => expect(write).toHaveBeenCalledExactlyOnceWith("/repo/src/new.ts"));
  });

  it.each([
    { state: "outside the root", path: "/elsewhere/src/a.ts" },
    { state: "beside the root, sharing its start", path: "/repo-other/src/a.ts" },
    { state: "already relative", path: "src/a.ts" },
  ])("shows a path $state as it is given", async ({ path }) => {
    const texts = textsOf({ 10: "alpha" });
    await using screen = await mount({
      files: [entryOf(path, texts)],
      loadFileContents: loaderOf({ [path]: texts }),
      workspaceRoot: "/repo",
    });
    await showsFile(screen, "alpha");

    expect(one(screen.container, "[data-sbs-file-title]")!.textContent).toContain(path);
  });

  it("shows the name as plain text, and opens nothing on F4, without a way to open files", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const texts = textsOf({ 10: "alpha" });
    await using screen = await mount({
      files: [entryOf("src/a.ts", texts)],
      loadFileContents: loaderOf({ "src/a.ts": texts }),
      onOpenFile: undefined,
    });
    await showsFile(screen, "alpha");

    const title = one(screen.container, "[data-sbs-file-title]")!;
    expect(title.tagName).toBe("SPAN");
    expect(title.textContent).toContain("src/a.ts");
    expect(screen.getByRole("button", { name: "src/a.ts" }).elements()).toHaveLength(0);

    await focusPane(screen, "additions");
    await userEvent.keyboard("{F4}");

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("shows a pure rename, which loads one file, as identical contents", async () => {
    const texts = textsOf({ 10: "alpha" });
    const renamed: FileDiffMetadata = {
      ...entryOf("new/name.ts", texts).fileDiff,
      type: "rename-pure",
      prevName: "old/name.ts",
      hunks: [],
    };
    const loadFileContents = vi.fn<FileDiffContentsLoader>(async () => ({
      oldFile: null,
      newFile: { name: "new/name.ts", contents: texts.after },
    }));
    await using screen = await mount({
      files: [{ fileKey: "new/name.ts", filePath: "new/name.ts", fileDiff: renamed }],
      loadFileContents,
    });

    await vi.waitFor(() => expect(noticeOf(screen)).toBe("Contents are identical"));
    expect(statusOf(screen)).toBe("No differences");
    expect(codeOf(screen, "additions")).toContain("const alpha = 1;");
  });

  it("shows a new file as one pane", async () => {
    const texts: Texts = { before: "", after: join(base(12)) };
    const fileDiff = parseDiffFromFile(null, { name: "new.ts", contents: texts.after });
    await using screen = await mount({
      files: [{ fileKey: "new.ts", filePath: "new.ts", fileDiff }],
      loadFileContents: async () => ({
        oldFile: null,
        newFile: { name: "new.ts", contents: texts.after },
      }),
    });

    await vi.waitFor(() => expect(codeOf(screen, "additions")).toHaveLength(12));
    expect(scrollerOf(screen, "deletions")).toBeNull();
    expect(one(screen.container, "[data-sbs-divider]")).toBeNull();
  });

  it("shows a deleted file as one pane", async () => {
    const texts: Texts = { before: join(base(12)), after: "" };
    const fileDiff = parseDiffFromFile({ name: "gone.ts", contents: texts.before }, null);
    await using screen = await mount({
      files: [{ fileKey: "gone.ts", filePath: "gone.ts", fileDiff }],
      loadFileContents: async () => ({
        oldFile: { name: "gone.ts", contents: texts.before },
        newFile: { name: "gone.ts", contents: "" },
      }),
    });

    await vi.waitFor(() => expect(codeOf(screen, "deletions")).toHaveLength(12));
    expect(scrollerOf(screen, "additions")).toBeNull();
  });
});

describe("picking files", () => {
  const texts = {
    "a.ts": textsOf({ 10: "alpha", 30: "alpha2" }),
    "b.ts": textsOf({ 10: "beta" }),
    "c.ts": textsOf({ 10: "gamma" }),
  };
  const entries = () =>
    (["a.ts", "b.ts", "c.ts"] as const).map((name) => entryOf(name, texts[name]));

  it("shows the first file when nothing is selected, or the selection names none", async () => {
    await using screen = await mount({
      files: entries(),
      selectedFileKey: "nope.ts",
      loadFileContents: loaderOf(texts),
    });

    await showsFile(screen, "alpha");
  });

  it("shows the selected file", async () => {
    await using screen = await mount({
      files: entries(),
      selectedFileKey: "b.ts",
      loadFileContents: loaderOf(texts),
    });

    await showsFile(screen, "beta");
  });

  it("moves between files with the Previous and Next buttons, which stop at the ends", async () => {
    const onSelectFile = vi.fn();
    await using screen = await mount({
      files: entries(),
      loadFileContents: loaderOf(texts),
      onSelectFile,
    });
    await showsFile(screen, "alpha");
    await expect.element(screen.getByRole("button", { name: "Previous file" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Next file" }));
    await showsFile(screen, "beta");
    expect(onSelectFile).toHaveBeenLastCalledWith("b.ts");
    await expect.element(screen.getByRole("button", { name: "Previous file" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Next file" }));
    await showsFile(screen, "gamma");
    expect(onSelectFile).toHaveBeenLastCalledWith("c.ts");
    await expect.element(screen.getByRole("button", { name: "Next file" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Previous file" }));
    await showsFile(screen, "beta");
    expect(onSelectFile).toHaveBeenCalledTimes(3);
  });

  it("has no file buttons for a single file", async () => {
    await using screen = await mount({
      files: [entryOf("a.ts", texts["a.ts"])],
      loadFileContents: loaderOf(texts),
    });
    await showsFile(screen, "alpha");

    expect(screen.getByRole("button", { name: "Next file" }).elements()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Previous file" }).elements()).toHaveLength(0);
  });

  it("starts each file on its own folds and scroll", async () => {
    await using screen = await mount(
      { files: entries(), loadFileContents: loaderOf(texts) },
      { collapse: true },
    );
    await showsFile(screen, "alpha");
    await userEvent.click(foldsOf(screen)[0]!);
    const opened = foldsOf(screen).length;

    await userEvent.click(screen.getByRole("button", { name: "Next file" }));
    await showsFile(screen, "beta");
    await userEvent.click(screen.getByRole("button", { name: "Previous file" }));
    await showsFile(screen, "alpha");

    expect(foldsOf(screen).length).toBeGreaterThan(opened);
  });

  it("goes to the next file on a second F7 past the last difference, and focuses its pane", async () => {
    const onSelectFile = vi.fn();
    await using screen = await mount({
      files: entries(),
      loadFileContents: loaderOf(texts),
      onSelectFile,
    });
    await showsFile(screen, "alpha");
    await focusPane(screen);
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 2"));

    await userEvent.keyboard("{F7}");
    await vi.waitFor(() => expect(statusOf(screen)).toBe("2 of 2"));
    await userEvent.keyboard("{F7}");
    await vi.waitFor(() =>
      expect(one(screen.container, "[data-sbs-edge-hint]")?.textContent).toBe(
        "Press again to go to the next file",
      ),
    );
    expect(onSelectFile).not.toHaveBeenCalled();
    await userEvent.keyboard("{F7}");

    await showsFile(screen, "beta");
    expect(onSelectFile).toHaveBeenCalledExactlyOnceWith("b.ts");
    // Reached from the keyboard: the new file's pane has focus and the keys go on.
    await vi.waitFor(() => expect(document.activeElement).toBe(scrollerOf(screen, "additions")));
    expect(statusOf(screen)).toBe("1 of 1");
  });

  it("goes back to the previous file's last difference on Shift+F7", async () => {
    await using screen = await mount({
      files: entries(),
      selectedFileKey: "b.ts",
      loadFileContents: loaderOf(texts),
    });
    await showsFile(screen, "beta");
    await focusPane(screen);
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await userEvent.keyboard("{Shift>}{F7}{/Shift}");
    await vi.waitFor(() =>
      expect(one(screen.container, "[data-sbs-edge-hint]")?.textContent).toBe(
        "Press again to go to the previous file",
      ),
    );
    await userEvent.keyboard("{Shift>}{F7}{/Shift}");

    await showsFile(screen, "alpha");
    await vi.waitFor(() => expect(statusOf(screen)).toBe("2 of 2"));
  });

  it("gives the first and last files no hint past their ends", async () => {
    await using screen = await mount({
      files: entries(),
      loadFileContents: loaderOf(texts),
    });
    await showsFile(screen, "alpha");
    await focusPane(screen);

    await userEvent.keyboard("{Shift>}{F7}{/Shift}");
    await userEvent.keyboard("{Shift>}{F7}{/Shift}");
    expect(one(screen.container, "[data-sbs-edge-hint]")).toBeNull();
  });
});

describe("what the loader says it cannot show", () => {
  const texts = textsOf({ 10: "alpha" });

  it("says a file is too large to show whole, and shows its hunks on request", async () => {
    const entry = twoHunkEntry();
    await using screen = await mount({
      files: [entry],
      loadFileContents: async () => Promise.reject(tooLarge),
    });

    await expect
      .element(screen.getByText("This file is over 1 MB, too large to show whole."))
      .toBeVisible();
    expect(hasPanes(screen)).toBe(false);
    expect(screen.getByText("This file could not be loaded.").elements()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Retry" }).elements()).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Show changed lines only" }));

    await vi.waitFor(() => expect(hasPanes(screen)).toBe(true));
    expect(noticeOf(screen)).toBe("Only the changed lines are available here.");
    expect(all(screen.container, ".sbs-omitted")).not.toHaveLength(0);
    expect(codeOf(screen, "additions")).toContain("const changed021 = 21;");
    expect(statusOf(screen)).toBe("1 of 2");
  });

  it("offers no hunks to show for a too-large file whose patch has none", async () => {
    await using screen = await mount({
      files: [entryOf("big.ts", NO_HUNKS_TEXTS)],
      loadFileContents: async () => Promise.reject(tooLarge),
    });

    await expect
      .element(screen.getByText("This file is over 1 MB, too large to show whole."))
      .toBeVisible();
    expect(screen.getByRole("button", { name: "Show changed lines only" }).elements()).toHaveLength(
      0,
    );
  });

  it("knows a too-large file from the git loader's error text", async () => {
    await using screen = await mount({
      files: [twoHunkEntry()],
      loadFileContents: async () => Promise.reject({ detail: "The file is over 1 MB" }),
    });

    await expect
      .element(screen.getByText("This file is over 1 MB, too large to show whole."))
      .toBeVisible();
  });

  it("knows a too-large file from the process output limit", async () => {
    await using screen = await mount({
      files: [twoHunkEntry()],
      loadFileContents: async () => Promise.reject({ _tag: "VcsProcessOutputLimitError" }),
    });

    await expect
      .element(screen.getByText("This file is over 1 MB, too large to show whole."))
      .toBeVisible();
  });

  it("keeps the too-large choice per file", async () => {
    const files = [twoHunkEntry("one.ts"), twoHunkEntry("two.ts")];
    await using screen = await mount({
      files,
      loadFileContents: async () => Promise.reject(tooLarge),
    });
    await userEvent.click(screen.getByRole("button", { name: "Show changed lines only" }));
    await vi.waitFor(() => expect(hasPanes(screen)).toBe(true));

    await userEvent.click(screen.getByRole("button", { name: "Next file" }));

    await expect
      .element(screen.getByText("This file is over 1 MB, too large to show whole."))
      .toBeVisible();
  });

  it("says a file is binary", async () => {
    await using screen = await mount({
      files: [twoHunkEntry("image.png")],
      loadFileContents: async () => Promise.reject(binary),
    });

    await expect
      .element(screen.getByText("Binary file. Its contents are not shown."))
      .toBeVisible();
    expect(hasPanes(screen)).toBe(false);
    expect(screen.getByRole("button", { name: "Retry" }).elements()).toHaveLength(0);
  });

  it("knows a binary file from the git loader's error text", async () => {
    await using screen = await mount({
      files: [entryOf("image.png", texts)],
      loadFileContents: async () => Promise.reject({ detail: "Refusing a binary file" }),
    });

    await expect
      .element(screen.getByText("Binary file. Its contents are not shown."))
      .toBeVisible();
  });

  it("says contents are identical, with nothing to step to", async () => {
    await using screen = await mount({
      // The patch says something changed; the files read now are the same.
      files: [entryOf("a.ts", texts)],
      loadFileContents: async () => filesOf({ before: texts.before, after: texts.before }, "a.ts"),
    });

    await vi.waitFor(() => expect(noticeOf(screen)).toBe("Contents are identical"));
    expect(statusOf(screen)).toBe("No differences");
    expect(hasPanes(screen)).toBe(true);
  });

  it("says differences are ignored when only whitespace changed and whitespace is ignored", async () => {
    const spaced: Texts = { before: join(base()), after: join(base().with(9, `  ${value(10)}  `)) };
    await using screen = await mount({
      files: [entryOf("a.ts", spaced)],
      ignoreWhitespace: true,
      loadFileContents: loaderOf({ "a.ts": spaced }),
    });

    await vi.waitFor(() =>
      expect(noticeOf(screen)).toBe("Differences ignored: only whitespace changed"),
    );
    expect(statusOf(screen)).toBe("No differences");
  });

  it("shows the whitespace change when whitespace is not ignored", async () => {
    const spaced: Texts = { before: join(base()), after: join(base().with(9, `  ${value(10)}  `)) };
    await using screen = await mount({
      files: [entryOf("a.ts", spaced)],
      ignoreWhitespace: false,
      loadFileContents: loaderOf({ "a.ts": spaced }),
    });

    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));
    expect(noticeOf(screen)).toBeUndefined();
  });

  it("shows a changed ignoreWhitespace without loading again", async () => {
    const spaced: Texts = { before: join(base()), after: join(base().with(9, `  ${value(10)}  `)) };
    const loadFileContents = loaderOf({ "a.ts": spaced });
    const props = { files: [entryOf("a.ts", spaced)], loadFileContents };
    await using screen = await mount({ ...props, ignoreWhitespace: false });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await screen.rerender(<Harness {...props} ignoreWhitespace />);

    await vi.waitFor(() =>
      expect(noticeOf(screen)).toBe("Differences ignored: only whitespace changed"),
    );
    expect(loadFileContents).toHaveBeenCalledOnce();
  });

  it("shows the changed lines with a notice and a Retry when the whole file failed to load", async () => {
    // The same two changes as twoHunkEntry's patch (lines 21 and 81), in a whole file.
    const whole: Texts = {
      before: join(base(90)),
      after: join(
        base(90).map((line, index) =>
          index === 20 || index === 80 ? `const changed${pad(index + 1)} = ${index + 1};` : line,
        ),
      ),
    };
    const loadFileContents = vi
      .fn<FileDiffContentsLoader>()
      .mockRejectedValueOnce(new Error("disk on fire"))
      .mockResolvedValue(filesOf(whole, "a.ts"));
    await using screen = await mount({ files: [twoHunkEntry("a.ts")], loadFileContents });

    await vi.waitFor(() =>
      expect(noticeOf(screen)).toContain(
        "The whole file could not be loaded. Showing its changed lines only.",
      ),
    );
    expect(hasPanes(screen)).toBe(true);
    expect(statusOf(screen)).toBe("1 of 2");
    // The patch's own hunks: the gap between them is omitted, not a fold that opens.
    expect(all(screen.container, ".sbs-omitted")).not.toHaveLength(0);
    expect(foldsOf(screen)).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await vi.waitFor(() => expect(noticeOf(screen)).toBeUndefined());
    expect(loadFileContents).toHaveBeenCalledTimes(2);
    // The whole file: the same gap is now a fold.
    await vi.waitFor(() => expect(foldsOf(screen)).not.toHaveLength(0));
    expect(all(screen.container, ".sbs-omitted")).toHaveLength(0);
  });

  it("says the file could not be loaded when it failed and the patch has no hunks", async () => {
    const loadFileContents = vi
      .fn<FileDiffContentsLoader>()
      .mockRejectedValueOnce(new Error("disk on fire"))
      .mockResolvedValue(filesOf(NO_HUNKS_TEXTS, "a.ts"));
    await using screen = await mount({
      files: [entryOf("a.ts", NO_HUNKS_TEXTS)],
      loadFileContents,
    });

    await expect.element(screen.getByText("This file could not be loaded.")).toBeVisible();
    expect(hasPanes(screen)).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await vi.waitFor(() => expect(noticeOf(screen)).toBe("Contents are identical"));
    expect(loadFileContents).toHaveBeenCalledTimes(2);
  });

  it("keeps failing on a Retry whose load fails again", async () => {
    const loadFileContents = vi.fn<FileDiffContentsLoader>(async () =>
      Promise.reject(new Error("again")),
    );
    await using screen = await mount({
      files: [entryOf("a.ts", NO_HUNKS_TEXTS)],
      loadFileContents,
    });
    await expect.element(screen.getByText("This file could not be loaded.")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalledTimes(2));
    await expect.element(screen.getByText("This file could not be loaded.")).toBeVisible();
  });

  it("shows the Retry's loading state in between when nothing is on screen yet", async () => {
    const second = deferred<FileDiffLoadedFiles>();
    const loadFileContents = vi
      .fn<FileDiffContentsLoader>()
      .mockRejectedValueOnce(new Error("x"))
      .mockReturnValueOnce(second.promise);
    await using screen = await mount({
      files: [entryOf("a.ts", NO_HUNKS_TEXTS)],
      loadFileContents,
    });
    await expect.element(screen.getByText("This file could not be loaded.")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    // The failed answer stays on screen until the new one is in.
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalledTimes(2));
    second.resolve(filesOf(NO_HUNKS_TEXTS, "a.ts"));
    await vi.waitFor(() => expect(noticeOf(screen)).toBe("Contents are identical"));
  });

  it("says there are no line changes for a file with no hunks that was loaded without a loader", async () => {
    await using screen = await mount({ files: [entryOf("a.ts", NO_HUNKS_TEXTS)] });

    await expect.element(screen.getByText("No line changes to show for this file.")).toBeVisible();
    expect(hasPanes(screen)).toBe(false);
  });
});

describe("without a way to read whole files", () => {
  it("shows the patch's hunks with a notice, and never calls a loader", async () => {
    await using screen = await mount({ files: [twoHunkEntry()] });

    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 2"));
    expect(noticeOf(screen)).toBe("Only the changed lines are available here.");
    expect(all(screen.container, ".sbs-omitted").map((row) => row.textContent)).toContain(
      "53 lines not in the patch",
    );
    expect(foldsOf(screen)).toHaveLength(0);
    expect(screen.getByRole("status", { name: "Loading file..." }).elements()).toHaveLength(0);
  });

  it("warns that a truncated patch is incomplete", async () => {
    await using screen = await mount({
      files: [twoHunkEntry()],
      patchState: () => ({ pending: false, error: false, truncated: true }),
    });

    await vi.waitFor(() =>
      expect(noticeOf(screen)).toBe(
        "This file's patch is cut off. The changes shown are incomplete.",
      ),
    );
    expect(hasPanes(screen)).toBe(true);
  });

  it("warns of a cut-off patch ahead of the failure notice's retry only when the load did not fail", async () => {
    await using screen = await mount({
      files: [twoHunkEntry()],
      loadFileContents: async () => Promise.reject(tooLarge),
      patchState: () => ({ pending: false, error: false, truncated: true }),
    });
    await userEvent.click(screen.getByRole("button", { name: "Show changed lines only" }));

    await vi.waitFor(() =>
      expect(noticeOf(screen)).toBe(
        "This file's patch is cut off. The changes shown are incomplete.",
      ),
    );
  });

  it("says both that the whole file failed and that the patch is cut off", async () => {
    await using screen = await mount({
      files: [twoHunkEntry()],
      loadFileContents: async () => Promise.reject(new Error("x")),
      patchState: () => ({ pending: false, error: false, truncated: true }),
    });

    await vi.waitFor(() =>
      expect(noticeOf(screen)).toContain(
        "The whole file could not be loaded, and its patch is cut off. The changes shown are incomplete.",
      ),
    );
    await expect.element(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});

describe("a pending patch", () => {
  const texts = textsOf({ 10: "alpha" });

  it("asks for the patch, shows loading and does not read the file", async () => {
    const onRequestPatch = vi.fn();
    const loadFileContents = loaderOf({ "a.ts": texts });
    await using screen = await mount({
      files: [entryOf("a.ts", texts)],
      loadFileContents,
      patchState: () => ({ pending: true, error: false, truncated: false }),
      onRequestPatch,
    });

    await vi.waitFor(() => expect(onRequestPatch).toHaveBeenCalledWith("a.ts"));
    await expect.element(loadingOf(screen)).toBeVisible();
    expect(loadFileContents).not.toHaveBeenCalled();
    expect(hasPanes(screen)).toBe(false);
  });

  it("asks once per file and reads the file when the patch arrives", async () => {
    const onRequestPatch = vi.fn();
    const loadFileContents = loaderOf({ "a.ts": texts });
    const props = { files: [entryOf("a.ts", texts)], loadFileContents, onRequestPatch };
    await using screen = await mount({
      ...props,
      patchState: () => ({ pending: true, error: false, truncated: false }),
    });
    await vi.waitFor(() => expect(onRequestPatch).toHaveBeenCalledOnce());

    await screen.rerender(<Harness {...props} patchState={() => settled} />);

    await showsFile(screen, "alpha");
    expect(loadFileContents).toHaveBeenCalledOnce();
    expect(onRequestPatch).toHaveBeenCalledOnce();
  });

  it("offers a Retry when the patch failed, and it asks again", async () => {
    const onRetryPatch = vi.fn();
    const onRequestPatch = vi.fn();
    await using screen = await mount({
      files: [entryOf("a.ts", texts)],
      loadFileContents: loaderOf({ "a.ts": texts }),
      patchState: () => ({ pending: true, error: true, truncated: false }),
      onRetryPatch,
      onRequestPatch,
    });

    await expect
      .element(screen.getByText("This file's changes could not be loaded."))
      .toBeVisible();
    expect(screen.getByRole("status", { name: "Loading file..." }).elements()).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(onRetryPatch).toHaveBeenCalledExactlyOnceWith("a.ts");
  });

  it("asks for the patch of the file stepped to", async () => {
    const onRequestPatch = vi.fn();
    const files = [entryOf("a.ts", texts), entryOf("b.ts", texts)];
    await using screen = await mount({
      files,
      loadFileContents: loaderOf({ "a.ts": texts, "b.ts": texts }),
      patchState: (path) => ({ pending: path === "b.ts", error: false, truncated: false }),
      onRequestPatch,
    });
    await showsFile(screen, "alpha");
    expect(onRequestPatch).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Next file" }));

    await vi.waitFor(() => expect(onRequestPatch).toHaveBeenCalledExactlyOnceWith("b.ts"));
    await expect.element(loadingOf(screen)).toBeVisible();
  });
});

describe("answers that arrive late", () => {
  const texts = {
    "a.ts": textsOf({ 10: "alpha" }),
    "b.ts": textsOf({ 10: "beta" }),
  };
  const entries = () => (["a.ts", "b.ts"] as const).map((name) => entryOf(name, texts[name]));

  it("does not show the old file's answer after another file was picked", async () => {
    const first = deferred<FileDiffLoadedFiles>();
    const second = deferred<FileDiffLoadedFiles>();
    const answers = [first, second];
    const loadFileContents = vi.fn<FileDiffContentsLoader>(() => answers.shift()!.promise);
    await using screen = await mount({ files: entries(), loadFileContents });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalledOnce());

    await userEvent.click(screen.getByRole("button", { name: "Next file" }));
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalledTimes(2));
    first.resolve(filesOf(texts["a.ts"], "a.ts"));

    // a.ts's answer is in, and b.ts is what is selected: still loading, not a.ts.
    await expect.element(loadingOf(screen)).toBeVisible();
    expect(hasPanes(screen)).toBe(false);
    expect(bodyText(screen)).not.toContain("const alpha = 1;");

    second.resolve(filesOf(texts["b.ts"], "b.ts"));
    await showsFile(screen, "beta");
    expect(codeOf(screen, "additions")).not.toContain("const alpha = 1;");
  });

  it("does not show a failure of the old file for the new one", async () => {
    const first = deferred<FileDiffLoadedFiles>();
    const second = deferred<FileDiffLoadedFiles>();
    const answers = [first, second];
    const loadFileContents = vi.fn<FileDiffContentsLoader>(() => answers.shift()!.promise);
    await using screen = await mount({ files: entries(), loadFileContents });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalledOnce());

    await userEvent.click(screen.getByRole("button", { name: "Next file" }));
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalledTimes(2));
    first.reject(binary);

    await expect.element(loadingOf(screen)).toBeVisible();
    expect(bodyText(screen)).not.toContain("Binary file");
    second.resolve(filesOf(texts["b.ts"], "b.ts"));
    await showsFile(screen, "beta");
  });

  it("does not show an answer of another selection for a file of the same name", async () => {
    const first = deferred<FileDiffLoadedFiles>();
    const second = deferred<FileDiffLoadedFiles>();
    const answers = [first, second];
    const loadFileContents = vi.fn<FileDiffContentsLoader>(() => answers.shift()!.promise);
    const props = { files: [entryOf("a.ts", texts["a.ts"])], loadFileContents };
    await using screen = await mount({ ...props, scopeKey: "scope-1" });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalledOnce());

    await screen.rerender(<Harness {...props} scopeKey="scope-2" />);
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalledTimes(2));
    first.resolve(filesOf(texts["a.ts"], "a.ts"));

    await expect.element(loadingOf(screen)).toBeVisible();
    expect(hasPanes(screen)).toBe(false);

    second.resolve(filesOf(texts["b.ts"], "a.ts"));
    await showsFile(screen, "beta");
    expect(codeOf(screen, "additions")).not.toContain("const alpha = 1;");
  });

  it("shows the old file while the same file is read again, then the new answer", async () => {
    const second = deferred<FileDiffLoadedFiles>();
    const loadFileContents = vi
      .fn<FileDiffContentsLoader>()
      .mockResolvedValueOnce(filesOf(texts["a.ts"], "a.ts"))
      .mockReturnValueOnce(second.promise);
    const props = { files: [entryOf("a.ts", texts["a.ts"])], loadFileContents };
    await using screen = await mount({ ...props, contentsKey: "contents-1" });
    await showsFile(screen, "alpha");

    await screen.rerender(<Harness {...props} contentsKey="contents-2" />);
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalledTimes(2));

    expect(screen.getByRole("status", { name: "Loading file..." }).elements()).toHaveLength(0);
    expect(codeOf(screen, "additions")).toContain("const alpha = 1;");

    second.resolve(filesOf(texts["b.ts"], "a.ts"));
    await showsFile(screen, "beta");
  });

  it("drops the answer of a read that a newer one replaced", async () => {
    const first = deferred<FileDiffLoadedFiles>();
    const second = deferred<FileDiffLoadedFiles>();
    const answers = [first, second];
    const loadFileContents = vi.fn<FileDiffContentsLoader>(() => answers.shift()!.promise);
    const props = { files: [entryOf("a.ts", texts["a.ts"])], loadFileContents };
    await using screen = await mount({ ...props, contentsKey: "contents-1" });
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalledOnce());

    await screen.rerender(<Harness {...props} contentsKey="contents-2" />);
    await vi.waitFor(() => expect(loadFileContents).toHaveBeenCalledTimes(2));
    first.resolve(filesOf(texts["a.ts"], "a.ts"));
    await expect.element(loadingOf(screen)).toBeVisible();
    expect(hasPanes(screen)).toBe(false);

    second.resolve(filesOf(texts["b.ts"], "a.ts"));
    await showsFile(screen, "beta");
  });

  it("reads again when the loader is replaced", async () => {
    const props = { files: [entryOf("a.ts", texts["a.ts"])] };
    const first = loaderOf({ "a.ts": texts["a.ts"] });
    await using screen = await mount({ ...props, loadFileContents: first });
    await showsFile(screen, "alpha");

    const second = loaderOf({ "a.ts": texts["b.ts"] });
    await screen.rerender(<Harness {...props} loadFileContents={second} />);

    await showsFile(screen, "beta");
    expect(second).toHaveBeenCalledOnce();
  });

  it("ignores an answer that arrives after the panel is gone", async () => {
    const answer = deferred<FileDiffLoadedFiles>();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await using screen = await mount({
      files: [entryOf("a.ts", texts["a.ts"])],
      loadFileContents: () => answer.promise,
    });
    await expect.element(loadingOf(screen)).toBeVisible();

    await screen.unmount();
    answer.resolve(filesOf(texts["a.ts"], "a.ts"));
    await answer.promise;

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("remembered settings", () => {
  const texts = textsOf({ 10: "alpha", 30: "beta" });
  const props = () => ({
    files: [entryOf("a.ts", texts)],
    loadFileContents: loaderOf({ "a.ts": texts }),
  });

  it("folds unchanged lines by default", async () => {
    await using screen = await mount(props());
    await showsFile(screen, "alpha");

    expect(foldsOf(screen).length).toBeGreaterThan(0);
    await expect
      .element(screen.getByRole("button", { name: "Collapse unchanged lines" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("follows the stored setting, and stores the switch", async () => {
    await using screen = await mount(props(), { collapse: false });
    await showsFile(screen, "alpha");
    expect(foldsOf(screen)).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Collapse unchanged lines" }));

    await vi.waitFor(() => expect(foldsOf(screen).length).toBeGreaterThan(0));
    expect(JSON.parse(localStorage.getItem(COLLAPSE_KEY)!)).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Collapse unchanged lines" }));
    await vi.waitFor(() => expect(foldsOf(screen)).toHaveLength(0));
    expect(JSON.parse(localStorage.getItem(COLLAPSE_KEY)!)).toBe(false);
  });

  it("keeps the stored switch for the next file", async () => {
    const both = { "a.ts": texts, "b.ts": textsOf({ 10: "gamma" }) };
    await using screen = await mount({
      files: [entryOf("a.ts", both["a.ts"]), entryOf("b.ts", both["b.ts"])],
      loadFileContents: loaderOf(both),
    });
    await showsFile(screen, "alpha");
    await userEvent.click(screen.getByRole("button", { name: "Collapse unchanged lines" }));
    await vi.waitFor(() => expect(foldsOf(screen)).toHaveLength(0));

    await userEvent.click(screen.getByRole("button", { name: "Next file" }));

    await showsFile(screen, "gamma");
    expect(foldsOf(screen)).toHaveLength(0);
  });

  it("uses the stored highlight mode and stores a new one", async () => {
    await using screen = await mount(props(), { highlight: "lines" });
    await showsFile(screen, "alpha");
    expect(all(screen.container, ".sbs-word")).toHaveLength(0);
    expect(one(screen.container, '[data-sbs-scroller="additions"] [data-tint]')?.dataset.tint).toBe(
      "modified",
    );

    await userEvent.click(screen.getByRole("button", { name: "Highlighting: Highlight lines" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Do not highlight" }));

    await vi.waitFor(() => expect(statusOf(screen)).toBe("Highlighting is off"));
    expect(JSON.parse(localStorage.getItem(HIGHLIGHT_KEY)!)).toBe("none");
  });

  it("falls back to the defaults when the stored values are not valid", async () => {
    localStorage.setItem(COLLAPSE_KEY, '"yes"');
    localStorage.setItem(HIGHLIGHT_KEY, '"rainbow"');
    await using screen = await render(<Harness {...props()} />, {
      container: container(),
      router: false,
    });
    await showsFile(screen, "alpha");

    expect(foldsOf(screen).length).toBeGreaterThan(0);
    expect(one(screen.container, '[data-sbs-scroller="additions"] [data-tint]')?.dataset.tint).toBe(
      "modified-muted",
    );
  });
});

describe("a caller's own view", () => {
  const texts = textsOf({ 10: "alpha" });

  it("renders the view the caller returns, with the props the panel computed", async () => {
    const seen: Array<{
      fileDiff: FileDiffMetadata;
      adjacent: unknown;
      focusOnOpen: boolean | undefined;
    }> = [];
    const renderView = (
      viewProps: Parameters<NonNullable<SideBySideDiffPanelProps["renderView"]>>[0],
    ): ReactNode => {
      seen.push({
        fileDiff: viewProps.fileDiff,
        adjacent: viewProps.adjacentFiles,
        focusOnOpen: viewProps.focusOnOpen,
      });
      return (
        <div data-wrapper="">
          <SideBySideDiffView
            {...viewProps}
            annotations={[
              { id: "note", side: "additions", startLine: 10, endLine: 10, data: null },
            ]}
          />
        </div>
      );
    };
    const files = [entryOf("a.ts", texts), entryOf("b.ts", texts)];
    await using screen = await mount({
      files,
      loadFileContents: loaderOf({ "a.ts": texts, "b.ts": texts }),
      renderView,
    });

    await showsFile(screen, "alpha");
    expect(one(screen.container, "[data-wrapper] [data-sbs-pane]")).not.toBeNull();
    await vi.waitFor(() =>
      expect(one(screen.container, "[data-sbs-annotation='note']")).not.toBeNull(),
    );
    const last = seen.at(-1)!;
    expect(last.adjacent).toEqual({ next: true, previous: false });
    expect(last.focusOnOpen).toBe(false);
    // The whole file, not the patch it was asked from.
    expect(last.fileDiff).not.toBe(files[0]!.fileDiff);
  });

  it("passes the patch itself while the whole file is not available", async () => {
    const entry = twoHunkEntry();
    let passed: FileDiffMetadata | undefined;
    await using screen = await mount({
      files: [entry],
      renderView: (viewProps) => {
        passed = viewProps.fileDiff;
        return <SideBySideDiffView {...viewProps} />;
      },
    });

    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 2"));
    expect(passed).toBe(entry.fileDiff);
  });
});
