import "~/index.css";

import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../../../test/render";
import { isMacPlatform } from "~/lib/utils";

import { fileContentRevision } from "../../files/fileContentRevision";
import {
  SideBySideDiffView,
  type SbsAnnotation,
  type SideBySideDiffViewProps,
} from "./SideBySideDiffView";

type Side = "deletions" | "additions";
const SIDES = ["deletions", "additions"] as const;

const pad = (n: number) => String(n).padStart(3, "0");

/** `count` lines, each unique: `const value007 = 7;`. */
const base = (count = 200) =>
  Array.from({ length: count }, (_, index) => `const value${pad(index + 1)} = ${index + 1};`);

const fileOf = (lines: ReadonlyArray<string>, name = "sample.ts") => ({
  name,
  contents: lines.map((line) => `${line}\n`).join(""),
});

const diffOf = (before: ReadonlyArray<string>, after: ReadonlyArray<string>) =>
  parseDiffFromFile(fileOf(before), fileOf(after));

/** Replaces `remove` lines from the 1-based `at` with `insert`. */
const edit = (
  lines: ReadonlyArray<string>,
  at: number,
  remove: number,
  insert: ReadonlyArray<string>,
) => lines.toSpliced(at - 1, remove, ...insert);

/** The new side of `threeChanges`. */
const threeChangesAfter = () =>
  base()
    .with(19, "const changed020 = 20;")
    .with(99, "const changed100 = 100;")
    .with(179, "const changed180 = 180;");

/** Three separate one-line changes: lines 20, 100 and 180. */
function threeChanges() {
  return diffOf(base(), threeChangesAfter());
}

/** A unified diff of one file from hunks written as ` `/`-`/`+` lines. */
function patchOf(hunks: ReadonlyArray<{ oldStart: number; newStart: number; body: string[] }>) {
  const text = hunks
    .map(({ oldStart, newStart, body }) => {
      const oldCount = body.filter((line) => line[0] !== "+").length;
      const newCount = body.filter((line) => line[0] !== "-").length;
      return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body.join("\n")}\n`;
    })
    .join("");
  const patch = `diff --git a/sample.ts b/sample.ts\n--- a/sample.ts\n+++ b/sample.ts\n${text}`;
  return parsePatchFiles(patch)[0]!.files[0]!;
}

const value = (n: number) => `const value${pad(n)} = ${n};`;

/** Lines 18-24 and 78-84 of the file, with line 21 and line 81 changed. */
function twoHunkPatch() {
  const hunk = (start: number, changed: number) => ({
    oldStart: start,
    newStart: start,
    body: [
      ...[0, 1, 2].map((offset) => ` ${value(start + offset)}`),
      `-${value(changed)}`,
      `+const changed${pad(changed)} = ${changed};`,
      ...[1, 2, 3].map((offset) => ` ${value(changed + offset)}`),
    ],
  });
  return patchOf([hunk(18, 21), hunk(78, 81)]);
}

type HarnessProps = Partial<SideBySideDiffViewProps> & { readonly fileDiff: FileDiffMetadata };

function Harness({
  collapseUnchanged = false,
  highlightMode = "words",
  openAnnotationId = null,
  onOpenAnnotationChange,
  ...rest
}: HarnessProps) {
  const [collapse, setCollapse] = useState(collapseUnchanged);
  const [mode, setMode] = useState(highlightMode);
  const [open, setOpen] = useState<string | null>(openAnnotationId);
  return (
    <SideBySideDiffView
      collapseUnchanged={collapse}
      onCollapseUnchangedChange={setCollapse}
      highlightMode={mode}
      onHighlightModeChange={setMode}
      openAnnotationId={open}
      onOpenAnnotationChange={(id) => {
        setOpen(id);
        onOpenAnnotationChange?.(id);
      }}
      {...rest}
    />
  );
}

function mount(props: HarnessProps, size: { width?: number; height?: number } = {}) {
  const container = document.createElement("div");
  Object.assign(container.style, {
    display: "flex",
    flexDirection: "column",
    width: `${size.width ?? 1000}px`,
    height: `${size.height ?? 800}px`,
  });
  // The view needs no routes, only a box to fill.
  return render(<Harness {...props} />, { container, router: false });
}

const all = (root: ParentNode, selector: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(selector));
const one = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector);

const scrollerOf = (screen: Screen, side: Side) =>
  one(screen.container, `[data-sbs-scroller="${side}"]`)!;
const rowsOf = (screen: Screen, side: Side) =>
  all(scrollerOf(screen, side), ".sbs-row[data-sbs-index]");
const numberOf = (row: HTMLElement) => one(row, ".sbs-gutter")!.textContent;
const textOf = (row: HTMLElement) => one(row, ".sbs-code")!.textContent;
const statusOf = (screen: Screen) => one(screen.container, "[data-sbs-status]")?.textContent;
const connectorsOf = (screen: Screen) => all(screen.container, ".sbs-connector");
const foldsOf = (screen: Screen, side: Side) =>
  all(scrollerOf(screen, side), "button.sbs-fold[data-sbs-fold]");
const hintOf = (screen: Screen) => one(screen.container, "[data-sbs-edge-hint]");
const findBarOf = (screen: Screen) => one(screen.container, "[data-sbs-find]");
const findCountOf = (screen: Screen) => one(findBarOf(screen)!, "span.tabular-nums")?.textContent;

const rowByNumber = (screen: Screen, side: Side, line: number) =>
  rowsOf(screen, side).find((row) => numberOf(row) === String(line));
const lineHeightOf = (screen: Screen) =>
  rowsOf(screen, "additions")[0]!.getBoundingClientRect().height;

function isVisible(element: HTMLElement, scroller: HTMLElement) {
  const box = scroller.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return rect.bottom > box.top && rect.top < box.bottom;
}

/** The gutter numbers of the tinted rows a pane shows right now. */
function visibleTinted(screen: Screen, side: Side) {
  const scroller = scrollerOf(screen, side);
  return rowsOf(screen, side)
    .filter((row) => row.dataset.tint !== undefined && isVisible(row, scroller))
    .map(numberOf);
}

function focusPane(screen: Screen, side: Side) {
  scrollerOf(screen, side).focus({ preventScroll: true });
}

async function press(screen: Screen, side: Side, keys: string) {
  focusPane(screen, side);
  await userEvent.keyboard(keys);
}

/** The pixel box of one character of a line's code. */
function columnBox(code: HTMLElement, column: number) {
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let remaining = column;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remaining < length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.setEnd(node, remaining + 1);
      return range.getBoundingClientRect();
    }
    remaining -= length;
  }
  throw new Error(`No column ${column} in ${code.textContent}`);
}

/** Clicks the left quarter of a character, so the caret lands before it. */
async function clickColumn(
  code: HTMLElement,
  column: number,
  modifiers: Array<"Control" | "Meta" | "Alt" | "Shift"> = [],
) {
  const box = columnBox(code, column);
  const origin = code.getBoundingClientRect();
  await userEvent.click(code, {
    modifiers,
    position: {
      x: box.left - origin.left + box.width * 0.25,
      y: box.top - origin.top + box.height / 2,
    },
  });
}

/** The text node and offset of a column, wherever the line's spans split it. */
function textPointAt(code: HTMLElement, column: number) {
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let remaining = column;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
  }
  throw new Error(`No column ${column} in ${code.textContent}`);
}

const SCROLL_TOLERANCE = 1.5;

/** The keymap's `mod+f`: Cmd on a Mac, Ctrl elsewhere. */
const MOD_F = isMacPlatform(navigator.platform) ? "{Meta>}f{/Meta}" : "{Control>}f{/Control}";

describe("stepping through differences", () => {
  it("draws one connector per change and counts them", async () => {
    await using screen = await mount({ fileDiff: threeChanges(), collapseUnchanged: true });

    await vi.waitFor(() => expect(connectorsOf(screen)).toHaveLength(3));
    expect(connectorsOf(screen).map((connector) => connector.dataset.kind)).toEqual([
      "modified",
      "modified",
      "modified",
    ]);
    expect(one(screen.container, "[data-sbs-divider]")).not.toBeNull();
    expect(statusOf(screen)).toBe("1 of 3");
  });

  it("visits the differences in order with F7 and goes back with Shift+F7", async () => {
    await using screen = await mount({ fileDiff: threeChanges() });

    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["20"]));
    expect(statusOf(screen)).toBe("1 of 3");
    expect(visibleTinted(screen, "deletions")).toEqual(["20"]);

    await press(screen, "additions", "{F7}");
    await vi.waitFor(() => expect(statusOf(screen)).toBe("2 of 3"));
    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["100"]));
    expect(visibleTinted(screen, "deletions")).toEqual(["100"]);
    expect(connectorsOf(screen).map((connector) => connector.dataset.sbsConnector)).toEqual(["1"]);

    await userEvent.keyboard("{F7}");
    await vi.waitFor(() => expect(statusOf(screen)).toBe("3 of 3"));
    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["180"]));

    await userEvent.keyboard("{Shift>}{F7}{/Shift}");
    await vi.waitFor(() => expect(statusOf(screen)).toBe("2 of 3"));
    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["100"]));

    await userEvent.keyboard("{Shift>}{F7}{/Shift}");
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));
    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["20"]));
  });

  it("draws the next change's rows with the step, not a frame later", async () => {
    await using screen = await mount({ fileDiff: threeChanges() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));
    expect(rowByNumber(screen, "additions", 100)).toBeUndefined();
    using _frames = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0);

    await press(screen, "additions", "{F7}");
    await vi.waitFor(() => expect(statusOf(screen)).toBe("2 of 3"));
    expect(rowByNumber(screen, "additions", 100)).toBeDefined();
  });

  it("steps with the toolbar buttons and takes keys while a toolbar button has focus", async () => {
    await using screen = await mount({ fileDiff: threeChanges() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));

    await userEvent.click(screen.getByRole("button", { name: "Next difference" }));
    await vi.waitFor(() => expect(statusOf(screen)).toBe("2 of 3"));
    await userEvent.keyboard("{F7}");
    await vi.waitFor(() => expect(statusOf(screen)).toBe("3 of 3"));
    await userEvent.click(screen.getByRole("button", { name: "Previous difference" }));
    await vi.waitFor(() => expect(statusOf(screen)).toBe("2 of 3"));
  });

  it("opens on the last difference when asked to, and takes focus when asked to", async () => {
    await using screen = await mount({
      fileDiff: threeChanges(),
      initialDifference: "last",
      focusOnOpen: true,
    });

    await vi.waitFor(() => expect(statusOf(screen)).toBe("3 of 3"));
    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["180"]));
    expect(document.activeElement).toBe(scrollerOf(screen, "additions"));
  });

  it("does not take focus on opening unless asked to", async () => {
    await using screen = await mount({ fileDiff: threeChanges() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));
    expect(screen.container.contains(document.activeElement)).toBe(false);
  });

  it("counts the differences after the user scrolls off them, and steps on from there", async () => {
    await using screen = await mount({ fileDiff: threeChanges() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));

    scrollerOf(screen, "additions").scrollTop = 0;
    await vi.waitFor(() => expect(statusOf(screen)).toBe("3 differences"));

    await press(screen, "additions", "{F7}");
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));
  });

  it("makes one difference of changes that touch", async () => {
    const before = base(60);
    const after = before.with(9, "const changed010 = 10;").with(10, "const changed011 = 11;");
    await using screen = await mount({ fileDiff: diffOf(before, after) });

    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));
  });

  it("says there are no differences in identical files, and has nothing to step to", async () => {
    await using screen = await mount({ fileDiff: diffOf(base(40), base(40)) });

    await vi.waitFor(() => expect(statusOf(screen)).toBe("No differences"));
    await expect.element(screen.getByRole("button", { name: "Next difference" })).toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Previous difference" }))
      .toBeDisabled();
    expect(connectorsOf(screen)).toHaveLength(0);
  });

  it("keeps the toolbar enabled in a file with no differences when a neighbouring file exists", async () => {
    await using screen = await mount({
      fileDiff: diffOf(base(40), base(40)),
      adjacentFiles: { next: true, previous: false },
    });

    await expect.element(screen.getByRole("button", { name: "Next difference" })).toBeEnabled();
  });
});

describe("stepping past the last difference", () => {
  const oneChange = () => diffOf(base(60), base(60).with(29, "const changed030 = 30;"));

  it("shows a hint first and opens the next file on the second F7", async () => {
    const onOpenAdjacentFile = vi.fn();
    await using screen = await mount({
      fileDiff: oneChange(),
      adjacentFiles: { next: true, previous: false },
      onOpenAdjacentFile,
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await press(screen, "additions", "{F7}");
    await vi.waitFor(() => expect(hintOf(screen)).not.toBeNull());
    expect(hintOf(screen)?.dataset.sbsEdgeHint).toBe("next");
    expect(hintOf(screen)?.textContent).toBe("Press again to go to the next file");
    expect(onOpenAdjacentFile).not.toHaveBeenCalled();

    await userEvent.keyboard("{F7}");
    expect(onOpenAdjacentFile).toHaveBeenCalledExactlyOnceWith("next");
  });

  it("opens the previous file on the second Shift+F7", async () => {
    const onOpenAdjacentFile = vi.fn();
    await using screen = await mount({
      fileDiff: oneChange(),
      adjacentFiles: { next: false, previous: true },
      onOpenAdjacentFile,
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await press(screen, "additions", "{Shift>}{F7}{/Shift}");
    await vi.waitFor(() => expect(hintOf(screen)).not.toBeNull());
    expect(hintOf(screen)?.dataset.sbsEdgeHint).toBe("previous");
    expect(hintOf(screen)?.textContent).toBe("Press again to go to the previous file");

    await userEvent.keyboard("{Shift>}{F7}{/Shift}");
    expect(onOpenAdjacentFile).toHaveBeenCalledExactlyOnceWith("previous");
  });

  it("drops the hint on any other key, so the next F7 only shows it again", async () => {
    const onOpenAdjacentFile = vi.fn();
    await using screen = await mount({
      fileDiff: oneChange(),
      adjacentFiles: { next: true, previous: false },
      onOpenAdjacentFile,
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await press(screen, "additions", "{F7}");
    await vi.waitFor(() => expect(hintOf(screen)).not.toBeNull());
    await userEvent.keyboard("a");
    await vi.waitFor(() => expect(hintOf(screen)).toBeNull());

    await userEvent.keyboard("{F7}");
    await vi.waitFor(() => expect(hintOf(screen)).not.toBeNull());
    expect(onOpenAdjacentFile).not.toHaveBeenCalled();
  });

  it("drops the hint when F4 opens the source, so the next F7 only shows it again", async () => {
    const onOpenAdjacentFile = vi.fn();
    const onOpenSource = vi.fn();
    await using screen = await mount({
      fileDiff: oneChange(),
      adjacentFiles: { next: true, previous: false },
      onOpenAdjacentFile,
      onOpenSource,
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await press(screen, "additions", "{F7}");
    await vi.waitFor(() => expect(hintOf(screen)).not.toBeNull());
    await userEvent.keyboard("{F4}");
    expect(onOpenSource).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(hintOf(screen)).toBeNull());

    await userEvent.keyboard("{F7}");
    await vi.waitFor(() => expect(hintOf(screen)).not.toBeNull());
    expect(onOpenAdjacentFile).not.toHaveBeenCalled();
  });

  it("keeps the hint through a modifier key on its own", async () => {
    await using screen = await mount({
      fileDiff: oneChange(),
      adjacentFiles: { next: true, previous: false },
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await press(screen, "additions", "{F7}");
    await vi.waitFor(() => expect(hintOf(screen)).not.toBeNull());
    await userEvent.keyboard("{Shift}");
    expect(hintOf(screen)).not.toBeNull();
  });

  it("drops the hint when the user scrolls", async () => {
    const onOpenAdjacentFile = vi.fn();
    await using screen = await mount({
      fileDiff: oneChange(),
      adjacentFiles: { next: true, previous: false },
      onOpenAdjacentFile,
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await press(screen, "additions", "{F7}");
    await vi.waitFor(() => expect(hintOf(screen)).not.toBeNull());
    scrollerOf(screen, "additions").scrollTop += 5 * lineHeightOf(screen);
    await vi.waitFor(() => expect(hintOf(screen)).toBeNull());
    expect(onOpenAdjacentFile).not.toHaveBeenCalled();
  });

  it("drops the hint when a step lands on a difference", async () => {
    const before = base(200);
    const after = before.with(19, "const changed020 = 20;").with(179, "const changed180 = 180;");
    await using screen = await mount({
      fileDiff: diffOf(before, after),
      adjacentFiles: { next: true, previous: true },
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 2"));

    await press(screen, "additions", "{Shift>}{F7}{/Shift}");
    await vi.waitFor(() => expect(hintOf(screen)?.dataset.sbsEdgeHint).toBe("previous"));
    await userEvent.keyboard("{F7}");
    await vi.waitFor(() => expect(hintOf(screen)).toBeNull());
    await vi.waitFor(() => expect(statusOf(screen)).toBe("2 of 2"));
  });

  it("does nothing past the last difference when there is no next file", async () => {
    const onOpenAdjacentFile = vi.fn();
    await using screen = await mount({
      fileDiff: oneChange(),
      adjacentFiles: { next: false, previous: true },
      onOpenAdjacentFile,
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await press(screen, "additions", "{F7}");
    await userEvent.keyboard("{F7}");
    expect(hintOf(screen)).toBeNull();
    expect(onOpenAdjacentFile).not.toHaveBeenCalled();
  });

  it("does nothing without adjacentFiles", async () => {
    const onOpenAdjacentFile = vi.fn();
    await using screen = await mount({ fileDiff: oneChange(), onOpenAdjacentFile });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await press(screen, "additions", "{F7}");
    expect(hintOf(screen)).toBeNull();
  });

  it("steps through the toolbar's button to the hint as well", async () => {
    const onOpenAdjacentFile = vi.fn();
    await using screen = await mount({
      fileDiff: oneChange(),
      adjacentFiles: { next: true, previous: false },
      onOpenAdjacentFile,
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await userEvent.click(screen.getByRole("button", { name: "Next difference" }));
    await vi.waitFor(() => expect(hintOf(screen)).not.toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Next difference" }));
    expect(onOpenAdjacentFile).toHaveBeenCalledExactlyOnceWith("next");
  });
});

describe("opening the source", () => {
  it.each([
    ["F4", "{F4}"],
    [
      "Mod+ArrowDown",
      isMacPlatform(navigator.platform)
        ? "{Meta>}{ArrowDown}{/Meta}"
        : "{Control>}{ArrowDown}{/Control}",
    ],
  ])("%s opens the file at the current difference's line on the new side", async (_name, keys) => {
    const onOpenSource = vi.fn();
    await using screen = await mount({ fileDiff: threeChanges(), onOpenSource });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));

    await press(screen, "deletions", keys);
    expect(onOpenSource).toHaveBeenLastCalledWith({ side: "additions", line: 20 });

    await userEvent.keyboard("{F7}");
    await vi.waitFor(() => expect(statusOf(screen)).toBe("2 of 3"));
    await userEvent.keyboard(keys);
    expect(onOpenSource).toHaveBeenLastCalledWith({ side: "additions", line: 100 });
  });

  it("does not open the source on Shift+F4 or Alt+F4", async () => {
    const onOpenSource = vi.fn();
    await using screen = await mount({ fileDiff: threeChanges(), onOpenSource });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));

    await press(screen, "additions", "{Shift>}{F4}{/Shift}");
    await userEvent.keyboard("{Alt>}{F4}{/Alt}");
    expect(onOpenSource).not.toHaveBeenCalled();
  });

  it("opens a pure deletion at the line where the lines were", async () => {
    const before = base(80);
    const onOpenSource = vi.fn();
    await using screen = await mount({
      fileDiff: diffOf(before, edit(before, 31, 3, [])),
      onOpenSource,
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await press(screen, "additions", "{F4}");
    expect(onOpenSource).toHaveBeenCalledExactlyOnceWith({ side: "additions", line: 31 });
  });

  it("opens a deleted file on its old side", async () => {
    const onOpenSource = vi.fn();
    await using screen = await mount({
      fileDiff: parseDiffFromFile(fileOf(base(20)), null),
      onOpenSource,
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await press(screen, "deletions", "{F4}");
    expect(onOpenSource).toHaveBeenCalledExactlyOnceWith({ side: "deletions", line: 1 });
  });

  it("numbers the line by the patch's hunk in patch-only mode", async () => {
    const onOpenSource = vi.fn();
    await using screen = await mount({ fileDiff: twoHunkPatch(), onOpenSource });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 2"));

    await press(screen, "additions", "{F4}");
    expect(onOpenSource).toHaveBeenLastCalledWith({ side: "additions", line: 21 });
    await userEvent.keyboard("{F7}");
    await vi.waitFor(() => expect(statusOf(screen)).toBe("2 of 2"));
    await userEvent.keyboard("{F4}");
    expect(onOpenSource).toHaveBeenLastCalledWith({ side: "additions", line: 81 });
  });
});

describe("insertions and deletions", () => {
  const inserted = ["const added1 = 1;", "const added2 = 2;", "const added3 = 3;"];

  it("tints an insertion on the right and leaves the left a marker on the row below", async () => {
    const before = base(60);
    await using screen = await mount({ fileDiff: diffOf(before, edit(before, 11, 0, inserted)) });

    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));
    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toHaveLength(3));

    const right = rowsOf(screen, "additions").filter((row) => row.dataset.tint === "inserted");
    expect(right.map(textOf)).toEqual(inserted);
    expect(right.map(numberOf)).toEqual(["11", "12", "13"]);

    const left = rowsOf(screen, "deletions");
    expect(left.some((row) => row.dataset.tint !== undefined)).toBe(false);
    expect(left.map(textOf)).not.toContain(inserted[0]);
    expect(left.some((row) => numberOf(row) === "12")).toBe(true);
    // The old file has line 10 then line 11: nothing sits between them.
    const numbers = left.map(numberOf).map(Number);
    expect(numbers.slice(numbers.indexOf(10), numbers.indexOf(10) + 2)).toEqual([10, 11]);
    expect(left.filter((row) => row.dataset.insertAbove !== undefined).map(numberOf)).toEqual([
      "11",
    ]);
    expect(rowByNumber(screen, "deletions", 11)?.dataset.insertAbove).toBe("inserted");
    expect(connectorsOf(screen).map((connector) => connector.dataset.kind)).toEqual(["inserted"]);
  });

  it("tints a deletion on the left and marks the right row below", async () => {
    const before = base(60);
    await using screen = await mount({ fileDiff: diffOf(before, edit(before, 11, 3, [])) });

    await vi.waitFor(() => expect(visibleTinted(screen, "deletions")).toHaveLength(3));
    const left = rowsOf(screen, "deletions").filter((row) => row.dataset.tint === "deleted");
    expect(left.map(numberOf)).toEqual(["11", "12", "13"]);
    expect(rowsOf(screen, "additions").some((row) => row.dataset.tint !== undefined)).toBe(false);
    expect(rowByNumber(screen, "additions", 11)?.dataset.insertAbove).toBe("deleted");
    expect(textOf(rowByNumber(screen, "additions", 11)!)).toBe(value(14));
    expect(connectorsOf(screen).map((connector) => connector.dataset.kind)).toEqual(["deleted"]);
  });

  it("marks below the last row when the lines are added at the end of the file", async () => {
    const before = base(30);
    await using screen = await mount({ fileDiff: diffOf(before, [...before, ...inserted]) });

    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toHaveLength(3));
    const last = rowsOf(screen, "deletions").at(-1)!;
    expect(numberOf(last)).toBe("30");
    expect(last.dataset.insertBelow).toBe("inserted");
  });

  it("tints each row of a modified block, and the row without a partner in full colour", async () => {
    const before = base(60);
    // Two old lines become three new ones.
    const after = edit(before, 21, 2, [
      "const changed021 = 21;",
      "const changed022 = 22;",
      "const another = 1;",
    ]);
    await using screen = await mount({ fileDiff: diffOf(before, after) });

    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toHaveLength(3));
    const right = rowsOf(screen, "additions").filter((row) => row.dataset.tint !== undefined);
    expect(right.map((row) => row.dataset.tint)).toEqual([
      "modified-muted",
      "modified-muted",
      "modified",
    ]);
    const left = rowsOf(screen, "deletions").filter((row) => row.dataset.tint !== undefined);
    expect(left.map((row) => row.dataset.tint)).toEqual(["modified-muted", "modified-muted"]);
    expect(connectorsOf(screen).map((connector) => connector.dataset.kind)).toEqual(["modified"]);
  });

  it("marks the changed words of a modified line", async () => {
    const before = base(40);
    await using screen = await mount({
      fileDiff: diffOf(before, before.with(19, "const changed020 = 20;")),
    });

    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["20"]));
    const right = rowByNumber(screen, "additions", 20)!;
    const left = rowByNumber(screen, "deletions", 20)!;
    expect(
      all(right, ".sbs-word")
        .map((word) => word.textContent)
        .join(""),
    ).toContain("changed");
    expect(
      all(left, ".sbs-word")
        .map((word) => word.textContent)
        .join(""),
    ).toContain("value");
  });
});

describe("highlighting", () => {
  const modified = () => diffOf(base(40), base(40).with(19, "const changed020 = 20;"));

  it("paints whole lines instead of words in the lines mode", async () => {
    await using screen = await mount({ fileDiff: modified(), highlightMode: "lines" });

    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["20"]));
    expect(rowByNumber(screen, "additions", 20)?.dataset.tint).toBe("modified");
    expect(all(screen.container, ".sbs-word")).toHaveLength(0);
    expect(connectorsOf(screen)).toHaveLength(1);
  });

  it("draws nothing in the none mode and says highlighting is off", async () => {
    await using screen = await mount({ fileDiff: modified(), highlightMode: "none" });

    await vi.waitFor(() => expect(statusOf(screen)).toBe("Highlighting is off"));
    expect(all(screen.container, "[data-tint]")).toHaveLength(0);
    expect(all(screen.container, ".sbs-word")).toHaveLength(0);
    expect(connectorsOf(screen)).toHaveLength(0);
    expect(all(screen.container, ".sbs-scroll-marks")).toHaveLength(0);
  });

  it("changes the mode from the highlighting menu", async () => {
    await using screen = await mount({ fileDiff: modified() });
    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["20"]));
    expect(rowByNumber(screen, "additions", 20)?.dataset.tint).toBe("modified-muted");

    await userEvent.click(screen.getByRole("button", { name: "Highlighting: Highlight words" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "Highlight lines" }));
    await vi.waitFor(() =>
      expect(rowByNumber(screen, "additions", 20)?.dataset.tint).toBe("modified"),
    );

    await userEvent.click(screen.getByRole("button", { name: "Highlighting: Highlight lines" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "Do not highlight" }));
    await vi.waitFor(() => expect(statusOf(screen)).toBe("Highlighting is off"));
    expect(connectorsOf(screen)).toHaveLength(0);
  });

  it("marks every change along each pane's edge", async () => {
    await using screen = await mount({ fileDiff: threeChanges() });

    await vi.waitFor(() => expect(all(screen.container, ".sbs-scroll-marks")).toHaveLength(2));
    for (const marks of all(screen.container, ".sbs-scroll-marks")) {
      expect(all(marks, "rect")).toHaveLength(3);
    }
  });
});

describe("scrolling the panes together", () => {
  const block = Array.from({ length: 30 }, (_, index) => `const inserted${pad(index + 1)} = 0;`);
  const withBlock = () => {
    const before = base(150);
    return diffOf(before, edit(before, 41, 0, block));
  };

  it("advances the right pane by the inserted block on top of what the left did", async () => {
    await using screen = await mount({ fileDiff: withBlock() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));
    const left = scrollerOf(screen, "deletions");
    const right = scrollerOf(screen, "additions");
    const lineHeight = lineHeightOf(screen);

    left.scrollTop = 0;
    await vi.waitFor(() => expect(right.scrollTop).toBe(0));

    left.scrollTop = 80 * lineHeight;
    await vi.waitFor(() =>
      expect(Math.abs(right.scrollTop - left.scrollTop - 30 * lineHeight)).toBeLessThan(
        SCROLL_TOLERANCE,
      ),
    );
    expect(right.scrollTop).toBeGreaterThan(left.scrollTop);
  });

  it("shows the same unchanged lines at the same height again after the block", async () => {
    await using screen = await mount({ fileDiff: withBlock() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));
    const left = scrollerOf(screen, "deletions");
    const lineHeight = lineHeightOf(screen);

    left.scrollTop = 60 * lineHeight;
    await vi.waitFor(() => {
      const oldRow = rowByNumber(screen, "deletions", 80);
      const newRow = rowByNumber(screen, "additions", 110);
      expect(oldRow).toBeDefined();
      expect(newRow).toBeDefined();
      expect(textOf(newRow!)).toBe(textOf(oldRow!));
      const leftTop = oldRow!.getBoundingClientRect().top - left.getBoundingClientRect().top;
      const rightTop =
        newRow!.getBoundingClientRect().top -
        scrollerOf(screen, "additions").getBoundingClientRect().top;
      expect(Math.abs(leftTop - rightTop)).toBeLessThan(SCROLL_TOLERANCE);
    });
  });

  it("follows a scroll of the right pane back to the left", async () => {
    await using screen = await mount({ fileDiff: withBlock() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));
    const left = scrollerOf(screen, "deletions");
    const right = scrollerOf(screen, "additions");
    const lineHeight = lineHeightOf(screen);

    right.scrollTop = 110 * lineHeight;
    await vi.waitFor(() =>
      expect(Math.abs(right.scrollTop - left.scrollTop - 30 * lineHeight)).toBeLessThan(
        SCROLL_TOLERANCE,
      ),
    );
  });

  it.each([
    { name: "lines added at the end", before: 300, after: 600, scrolled: "deletions" },
    { name: "lines deleted at the end", before: 600, after: 300, scrolled: "additions" },
  ] as const)(
    "brings the longer side to its last line from the shorter one: $name",
    async ({ before, after, scrolled }) => {
      await using screen = await mount({ fileDiff: diffOf(base(before), base(after)) });
      await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));
      const longer = scrolled === "deletions" ? "additions" : "deletions";
      const last = Math.max(before, after);

      const shorter = scrollerOf(screen, scrolled);
      shorter.scrollTop = shorter.scrollHeight;

      await vi.waitFor(() => {
        const row = rowByNumber(screen, longer, last);
        expect(row).toBeDefined();
        expect(isVisible(row!, scrollerOf(screen, longer))).toBe(true);
      });
    },
  );

  it("mirrors a horizontal scroll", async () => {
    const before = base(60);
    const wide = `const wide = "${"x".repeat(400)}";`;
    await using screen = await mount({
      fileDiff: diffOf(before, before.with(29, wide)),
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));
    const left = scrollerOf(screen, "deletions");
    const right = scrollerOf(screen, "additions");

    expect(left.scrollWidth).toBeGreaterThan(left.clientWidth);
    right.scrollLeft = 150;
    await vi.waitFor(() => expect(Math.abs(left.scrollLeft - right.scrollLeft)).toBeLessThan(1));
    expect(left.scrollLeft).toBeGreaterThan(100);

    left.scrollLeft = 40;
    await vi.waitFor(() => expect(Math.abs(right.scrollLeft - 40)).toBeLessThan(1));
  });

  it("keeps the other pane's height on a sideways scroll of the pane that waits", async () => {
    const wide = (lines: ReadonlyArray<string>) =>
      lines.map((line) => `${line} // ${"x".repeat(300)}`);
    const before = wide(base(150));
    await using screen = await mount({
      fileDiff: diffOf(before, edit(before, 41, 0, wide(block))),
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));
    const left = scrollerOf(screen, "deletions");
    const right = scrollerOf(screen, "additions");
    const lineHeight = lineHeightOf(screen);

    // The right pane's level row is inside the inserted block, so the left one waits at its start.
    right.scrollTop = 55 * lineHeight - Math.floor(right.clientHeight / 3);
    await vi.waitFor(() =>
      expect(Math.abs(right.scrollTop - left.scrollTop - 15 * lineHeight)).toBeLessThan(lineHeight),
    );
    const top = right.scrollTop;

    left.scrollLeft = 100;
    await vi.waitFor(() => expect(Math.abs(right.scrollLeft - 100)).toBeLessThan(1));
    expect(right.scrollTop).toBe(top);
  });

  it("keeps the connectors on their changes while scrolling", async () => {
    await using screen = await mount({ fileDiff: withBlock() });
    await vi.waitFor(() => expect(connectorsOf(screen)).toHaveLength(1));
    const left = scrollerOf(screen, "deletions");
    const right = scrollerOf(screen, "additions");

    // The connector's right end sits on the first inserted row, wherever the pane is scrolled to.
    const rightEndOnFirstInsertedRow = () => {
      const first = rowByNumber(screen, "additions", 41);
      expect(first).toBeDefined();
      const [, rightTop] = pathEnds(connectorsOf(screen)[0]!.getAttribute("d")!);
      const expected = first!.getBoundingClientRect().top - right.getBoundingClientRect().top;
      expect(Math.abs(rightTop - expected)).toBeLessThan(SCROLL_TOLERANCE);
    };
    await vi.waitFor(rightEndOnFirstInsertedRow);

    left.scrollTop += 7 * lineHeightOf(screen);
    await vi.waitFor(() => expect(right.scrollTop).toBeGreaterThan(0));
    await vi.waitFor(rightEndOnFirstInsertedRow);
  });
});

/** The left top and the right top of a connector's path, `M0,<lt>C… <far>,<rt> …`. */
function pathEnds(path: string): [number, number] {
  const left = Number(/^M0,(-?[\d.]+)/.exec(path)?.[1]);
  const right = Number(/,(-?[\d.]+)$/.exec(path.split("L")[0]!)?.[1]);
  return [left, right];
}

describe("windowed rows", () => {
  it("renders only the rows near the viewport of a long file", async () => {
    const before = base(5000);
    await using screen = await mount({
      fileDiff: diffOf(before, before.with(2499, "const changed2500 = 2500;")),
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));
    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["2500"]));

    const lineHeight = lineHeightOf(screen);
    const sheet = one(scrollerOf(screen, "additions"), ".sbs-sheet")!;
    // Plus the room past the end that lets the level row reach the last line.
    const tail = sheet.getBoundingClientRect().height - 5000 * lineHeight;
    expect(tail).toBeGreaterThan(0);
    expect(tail).toBeLessThan(scrollerOf(screen, "additions").clientHeight);
    for (const side of SIDES) {
      expect(rowsOf(screen, side).length).toBeGreaterThan(20);
      expect(rowsOf(screen, side).length).toBeLessThan(250);
    }
    expect(rowByNumber(screen, "additions", 1)).toBeUndefined();
    expect(rowByNumber(screen, "additions", 5000)).toBeUndefined();

    const right = scrollerOf(screen, "additions");
    right.scrollTop = right.scrollHeight;
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 5000)).toBeDefined());
    expect(rowByNumber(screen, "additions", 2500)).toBeUndefined();
    expect(rowsOf(screen, "additions").length).toBeLessThan(250);
    await vi.waitFor(() => expect(rowByNumber(screen, "deletions", 5000)).toBeDefined());
  });
});

describe("new and deleted files", () => {
  it("shows a new file as one tinted pane with no divider", async () => {
    await using screen = await mount({ fileDiff: parseDiffFromFile(null, fileOf(base(30))) });

    // The window grows to the whole file in steps, so wait for all of it.
    await vi.waitFor(() => expect(rowsOf(screen, "additions")).toHaveLength(30));
    expect(one(screen.container, '[data-sbs-pane="deletions"]')).toBeNull();
    expect(one(screen.container, "[data-sbs-divider]")).toBeNull();
    expect(connectorsOf(screen)).toHaveLength(0);
    const rows = rowsOf(screen, "additions");
    expect(rows.every((row) => row.dataset.tint === "inserted")).toBe(true);
    expect(statusOf(screen)).toBe("1 of 1");
  });

  it("shows a deleted file as one tinted pane with no divider", async () => {
    await using screen = await mount({ fileDiff: parseDiffFromFile(fileOf(base(30)), null) });

    await vi.waitFor(() => expect(rowsOf(screen, "deletions")).toHaveLength(30));
    expect(one(screen.container, '[data-sbs-pane="additions"]')).toBeNull();
    expect(one(screen.container, "[data-sbs-divider]")).toBeNull();
    const rows = rowsOf(screen, "deletions");
    expect(rows.every((row) => row.dataset.tint === "deleted")).toBe(true);
  });

  it("steps and finds inside the single pane of a new file", async () => {
    await using screen = await mount({ fileDiff: parseDiffFromFile(null, fileOf(base(30))) });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await press(screen, "additions", MOD_F);
    await vi.waitFor(() => expect(findBarOf(screen)).not.toBeNull());
    await userEvent.keyboard("value007");
    await vi.waitFor(() => expect(findBarOf(screen)?.textContent).toContain("1/1"));
  });
});

describe("activating a token", () => {
  const modified = () => diffOf(base(60), base(60).with(29, "const changed030 = 30;"));

  it("reports the line, the column and the content revision of a Ctrl+click", async () => {
    const onTokenActivate = vi.fn();
    const fileDiff = modified();
    await using screen = await mount({ fileDiff, onTokenActivate });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 12)).toBeDefined());

    // `const value012 = 12;`: column 8 is inside `value012`.
    await clickColumn(one(rowByNumber(screen, "additions", 12)!, ".sbs-code")!, 8, ["Control"]);

    expect(onTokenActivate).toHaveBeenCalledExactlyOnceWith({
      side: "additions",
      line: 12,
      character: 8,
      modifiers: { meta: false, ctrl: true, alt: false, shift: false },
      revision: fileContentRevision(fileDiff.additionLines.join("")),
    });
    expect(typeof onTokenActivate.mock.calls[0]![0].revision).toBe("string");
  });

  it("reports the old side's own line and revision for a click in the left pane", async () => {
    const onTokenActivate = vi.fn();
    const fileDiff = modified();
    await using screen = await mount({ fileDiff, onTokenActivate });
    await vi.waitFor(() => expect(rowByNumber(screen, "deletions", 12)).toBeDefined());

    await clickColumn(one(rowByNumber(screen, "deletions", 12)!, ".sbs-code")!, 10, ["Meta"]);

    expect(onTokenActivate).toHaveBeenCalledExactlyOnceWith({
      side: "deletions",
      line: 12,
      character: 10,
      modifiers: { meta: true, ctrl: false, alt: false, shift: false },
      revision: fileContentRevision(fileDiff.deletionLines.join("")),
    });
    expect(fileContentRevision(fileDiff.deletionLines.join(""))).not.toBe(
      fileContentRevision(fileDiff.additionLines.join("")),
    );
  });

  it("counts columns through the spans of a changed line", async () => {
    const onTokenActivate = vi.fn();
    await using screen = await mount({ fileDiff: modified(), onTokenActivate });
    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["30"]));

    // `const changed030 = 30;`: the word-level tint splits the line into spans.
    const code = one(rowByNumber(screen, "additions", 30)!, ".sbs-code")!;
    expect(code.children.length).toBeGreaterThan(1);
    await clickColumn(code, 15, ["Control"]);

    expect(onTokenActivate).toHaveBeenCalledOnce();
    expect(onTokenActivate.mock.calls[0]![0]).toMatchObject({
      side: "additions",
      line: 30,
      character: 15,
    });
  });

  it("reports the modifiers it was clicked with", async () => {
    const onTokenActivate = vi.fn();
    await using screen = await mount({ fileDiff: modified(), onTokenActivate });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 12)).toBeDefined());

    await clickColumn(one(rowByNumber(screen, "additions", 12)!, ".sbs-code")!, 8, [
      "Control",
      "Shift",
      "Alt",
    ]);

    expect(onTokenActivate.mock.calls[0]![0].modifiers).toEqual({
      meta: false,
      ctrl: true,
      alt: true,
      shift: true,
    });
  });

  it("ignores a plain click, a click on whitespace and a click past the end of the line", async () => {
    const onTokenActivate = vi.fn();
    await using screen = await mount({ fileDiff: modified(), onTokenActivate });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 12)).toBeDefined());
    const code = one(rowByNumber(screen, "additions", 12)!, ".sbs-code")!;

    await clickColumn(code, 8);
    // Column 5 is the space after `const`.
    await clickColumn(code, 5, ["Control"]);
    await userEvent.click(code, {
      modifiers: ["Control"],
      position: { x: code.getBoundingClientRect().width - 4, y: 4 },
    });

    expect(onTokenActivate).not.toHaveBeenCalled();
  });

  it("reports no revision in patch-only mode, and the hunk's own line number", async () => {
    const onTokenActivate = vi.fn();
    await using screen = await mount({ fileDiff: twoHunkPatch(), onTokenActivate });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 78)).toBeDefined());

    await clickColumn(one(rowByNumber(screen, "additions", 78)!, ".sbs-code")!, 8, ["Control"]);

    expect(onTokenActivate).toHaveBeenCalledExactlyOnceWith({
      side: "additions",
      line: 78,
      character: 8,
      modifiers: { meta: false, ctrl: true, alt: false, shift: false },
      revision: null,
    });
  });
});

describe("patch-only mode", () => {
  it("shows the hunks with an omitted row between them and no fold to open it", async () => {
    await using screen = await mount({ fileDiff: twoHunkPatch(), collapseUnchanged: true });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 2"));

    for (const side of SIDES) {
      const scroller = scrollerOf(screen, side);
      const children = all(scroller, ".sbs-window > *");
      const between = children.findIndex((child) =>
        child.textContent?.includes("53 lines not in the patch"),
      );
      expect(between).toBeGreaterThan(0);
      expect(children[between]!.classList.contains("sbs-omitted")).toBe(true);
      const numbers = (rows: HTMLElement[]) =>
        rows.filter((row) => row.dataset.sbsIndex !== undefined).map(numberOf);
      // Line numbers run 18-24, then restart at 78 after the omitted row.
      expect(numbers(children.slice(0, between))).toEqual([
        "18",
        "19",
        "20",
        "21",
        "22",
        "23",
        "24",
      ]);
      expect(numbers(children.slice(between + 1))).toEqual([
        "78",
        "79",
        "80",
        "81",
        "82",
        "83",
        "84",
      ]);
      expect(foldsOf(screen, side)).toHaveLength(0);
    }
    expect(all(screen.container, "[data-sbs-fold]")).toHaveLength(0);
  });

  it("says how many lines the patch leaves out before the first hunk", async () => {
    await using screen = await mount({ fileDiff: twoHunkPatch() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 2"));

    const omitted = all(scrollerOf(screen, "additions"), ".sbs-omitted");
    expect(omitted.map((row) => row.textContent)).toEqual([
      "17 lines not in the patch",
      "53 lines not in the patch",
    ]);
  });

  it("does nothing when an omitted row is clicked", async () => {
    await using screen = await mount({ fileDiff: twoHunkPatch(), collapseUnchanged: true });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 2"));
    const before = rowsOf(screen, "additions").length;

    await userEvent.click(all(scrollerOf(screen, "additions"), ".sbs-omitted")[1]!);

    expect(rowsOf(screen, "additions")).toHaveLength(before);
    expect(all(screen.container, ".sbs-omitted").length).toBe(4);
  });

  it("tints the changes and draws their connectors from the hunks", async () => {
    await using screen = await mount({ fileDiff: twoHunkPatch() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 2"));

    // Both hunks fit the pane: the omitted run between them takes one row.
    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["21", "81"]));
    expect(visibleTinted(screen, "deletions")).toEqual(["21", "81"]);
    await vi.waitFor(() => expect(connectorsOf(screen)).toHaveLength(2));
    await press(screen, "additions", "{F7}");
    await vi.waitFor(() => expect(statusOf(screen)).toBe("2 of 2"));
  });

  it("draws markers only for annotations whose lines the patch holds", async () => {
    const annotations: SbsAnnotation[] = [
      { id: "inside", side: "additions", startLine: 80, endLine: 80, data: null },
      { id: "outside", side: "additions", startLine: 50, endLine: 50, data: null },
    ];
    await using screen = await mount({ fileDiff: twoHunkPatch(), annotations });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 2"));

    await vi.waitFor(() =>
      expect(
        all(screen.container, "[data-sbs-annotation]").map(
          (marker) => marker.dataset.sbsAnnotation,
        ),
      ).toEqual(["inside"]),
    );
  });

  it("scrolls the two panes together over the omitted rows", async () => {
    // Short enough that the 17 rows do not fit.
    await using screen = await mount({ fileDiff: twoHunkPatch() }, { height: 160 });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 2"));
    const left = scrollerOf(screen, "deletions");
    const right = scrollerOf(screen, "additions");
    expect(right.scrollHeight).toBeGreaterThan(right.clientHeight + 100);

    right.scrollTop = 100;
    await vi.waitFor(() => expect(Math.abs(left.scrollTop - 100)).toBeLessThan(SCROLL_TOLERANCE));
    left.scrollTop = 30;
    await vi.waitFor(() => expect(Math.abs(right.scrollTop - 30)).toBeLessThan(SCROLL_TOLERANCE));
  });
});

describe("folds", () => {
  it("folds the unchanged runs between the changes", async () => {
    await using screen = await mount({ fileDiff: threeChanges(), collapseUnchanged: true });
    await vi.waitFor(() => expect(connectorsOf(screen)).toHaveLength(3));

    for (const side of SIDES) {
      expect(foldsOf(screen, side)).toHaveLength(4);
      expect(rowsOf(screen, side)).toHaveLength(4 + 1 + 4 + 4 + 1 + 4 + 4 + 1 + 4);
    }
    expect(foldsOf(screen, "additions")[0]!.getAttribute("aria-label")).toBe(
      "Show 15 unchanged lines",
    );
    expect(foldsOf(screen, "additions")[1]!.getAttribute("aria-label")).toBe(
      "Show 71 unchanged lines",
    );
    expect(all(screen.container, "g.sbs-fold-link")).toHaveLength(4);
  });

  it("opens a fold clicked in either pane and both panes gain the same rows", async () => {
    // Tall enough that both states fit, so the sheets have no room past the end to measure.
    await using screen = await mount(
      { fileDiff: threeChanges(), collapseUnchanged: true },
      { height: 1400 },
    );
    await vi.waitFor(() => expect(connectorsOf(screen)).toHaveLength(3));
    const rowsBefore = rowsOf(screen, "additions").length;
    const heightOf = (side: Side) =>
      one(scrollerOf(screen, side), ".sbs-sheet")!.getBoundingClientRect().height;
    const heightBefore = heightOf("additions");
    const lineHeight = lineHeightOf(screen);

    await userEvent.click(foldsOf(screen, "deletions")[0]!);

    await vi.waitFor(() => expect(foldsOf(screen, "deletions")).toHaveLength(3));
    expect(foldsOf(screen, "additions")).toHaveLength(3);
    // The fold hid 15 lines; its one row becomes 15.
    expect(rowsOf(screen, "deletions").length).toBe(rowsBefore + 15);
    expect(rowsOf(screen, "additions").length).toBe(rowsBefore + 15);
    expect(heightOf("deletions")).toBeCloseTo(heightBefore + 14 * lineHeight, 0);
    expect(heightOf("additions")).toBeCloseTo(heightBefore + 14 * lineHeight, 0);
    expect(rowsOf(screen, "deletions").map(numberOf)).toEqual(
      rowsOf(screen, "additions").map(numberOf),
    );

    // The next fold, clicked in the right pane, opens in both. The rows below it are windowed out.
    const label = (side: Side) =>
      foldsOf(screen, side).map((fold) => fold.getAttribute("aria-label"));
    expect(label("additions")[0]).toBe("Show 71 unchanged lines");
    await userEvent.click(foldsOf(screen, "additions")[0]!);
    await vi.waitFor(() => expect(label("additions")).not.toContain("Show 71 unchanged lines"));
    expect(label("deletions")).not.toContain("Show 71 unchanged lines");
    expect(rowsOf(screen, "deletions").map(numberOf)).toEqual(
      rowsOf(screen, "additions").map(numberOf),
    );
    expect(rowByNumber(screen, "deletions", 60)).toBeDefined();
  });

  it("opens a fold from the wave that joins its two rows in the divider", async () => {
    await using screen = await mount({ fileDiff: threeChanges(), collapseUnchanged: true });
    await vi.waitFor(() => expect(connectorsOf(screen)).toHaveLength(3));

    await userEvent.click(all(screen.container, "g.sbs-fold-link .sbs-fold-link-line")[0]!);

    await vi.waitFor(() => expect(foldsOf(screen, "additions")).toHaveLength(3));
    expect(foldsOf(screen, "deletions")).toHaveLength(3);
  });

  it("folds and unfolds all unchanged lines from the toolbar switch", async () => {
    await using screen = await mount({ fileDiff: threeChanges(), collapseUnchanged: true });
    await vi.waitFor(() => expect(connectorsOf(screen)).toHaveLength(3));
    const toggle = screen.getByRole("button", { name: "Collapse unchanged lines" });
    await expect.element(toggle).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(toggle);
    await vi.waitFor(() => expect(foldsOf(screen, "additions")).toHaveLength(0));
    expect(foldsOf(screen, "deletions")).toHaveLength(0);
    await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
    const past =
      one(scrollerOf(screen, "additions"), ".sbs-sheet")!.getBoundingClientRect().height -
      200 * lineHeightOf(screen);
    expect(past).toBeGreaterThan(0);
    expect(past).toBeLessThan(scrollerOf(screen, "additions").clientHeight);

    await userEvent.click(toggle);
    await vi.waitFor(() => expect(foldsOf(screen, "additions")).toHaveLength(4));
    expect(foldsOf(screen, "deletions")).toHaveLength(4);
  });

  it("closes the folds the user opened when the switch is turned off and on", async () => {
    await using screen = await mount({ fileDiff: threeChanges(), collapseUnchanged: true });
    await vi.waitFor(() => expect(connectorsOf(screen)).toHaveLength(3));
    await userEvent.click(foldsOf(screen, "additions")[0]!);
    await vi.waitFor(() => expect(foldsOf(screen, "additions")).toHaveLength(3));

    const toggle = screen.getByRole("button", { name: "Collapse unchanged lines" });
    await userEvent.click(toggle);
    await vi.waitFor(() => expect(foldsOf(screen, "additions")).toHaveLength(0));
    await userEvent.click(toggle);
    await vi.waitFor(() => expect(foldsOf(screen, "additions")).toHaveLength(4));
  });

  it("keeps the current difference in view when the switch is turned off", async () => {
    await using screen = await mount({ fileDiff: threeChanges(), collapseUnchanged: true });
    await vi.waitFor(() => expect(connectorsOf(screen)).toHaveLength(3));
    await press(screen, "additions", "{F7}{F7}");
    await vi.waitFor(() => expect(statusOf(screen)).toBe("3 of 3"));

    await userEvent.click(screen.getByRole("button", { name: "Collapse unchanged lines" }));

    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["180"]));
    expect(statusOf(screen)).toBe("3 of 3");
  });

  it("does not fold a run too short to hide two lines", async () => {
    const before = base(60);
    // Changes on lines 10 and 20: the run between them is 9 lines, 8 kept as context, 1 hidden.
    const after = before.with(9, "const changed010 = 10;").with(19, "const changed020 = 20;");
    await using screen = await mount({ fileDiff: diffOf(before, after), collapseUnchanged: true });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 2"));

    // Only the runs before the first change and after the last fold: the 9 lines between keep 8 as context.
    expect(foldsOf(screen, "additions").map((fold) => fold.getAttribute("aria-label"))).toEqual([
      "Show 5 unchanged lines",
      "Show 36 unchanged lines",
    ]);
  });

  it("folds nothing in a file with no changes", async () => {
    await using screen = await mount({
      fileDiff: diffOf(base(60), base(60)),
      collapseUnchanged: true,
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("No differences"));

    expect(foldsOf(screen, "additions")).toHaveLength(0);
    expect(rowsOf(screen, "additions")).toHaveLength(60);
  });
});

describe("find", () => {
  const withNeedle = () => {
    const before = base(200);
    const after = before
      .with(9, "const needle = 1; // needle")
      .with(49, "const NEEDLE = 2;")
      .with(139, "const hidden = 'needle in a fold';");
    return diffOf(before, after);
  };

  it("opens a find bar in the focused pane, counts matches and steps with Enter", async () => {
    await using screen = await mount({ fileDiff: withNeedle() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));

    await press(screen, "additions", MOD_F);
    await vi.waitFor(() => expect(findBarOf(screen)).not.toBeNull());
    expect(findBarOf(screen)?.parentElement?.dataset.sbsPane).toBe("additions");
    expect(document.activeElement).toBe(one(findBarOf(screen)!, "input"));

    await userEvent.keyboard("needle");
    await vi.waitFor(() => expect(findCountOf(screen)).toBe("1/4"));
    // The count includes both on line 10, case-insensitively.
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(findCountOf(screen)).toBe("2/4"));
    await userEvent.keyboard("{Enter}{Enter}");
    await vi.waitFor(() => expect(findCountOf(screen)).toBe("4/4"));
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(findCountOf(screen)).toBe("1/4"));
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await vi.waitFor(() => expect(findCountOf(screen)).toBe("4/4"));
  });

  it("scrolls sideways to a match after tabs, as wide as they are drawn", async () => {
    const before = base(60);
    await using screen = await mount({
      fileDiff: diffOf(before, before.with(29, `${"\t".repeat(100)}needle`)),
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 1"));

    await press(screen, "additions", MOD_F);
    await userEvent.keyboard("needle");

    const scroller = scrollerOf(screen, "additions");
    await vi.waitFor(() => {
      const view = scroller.getBoundingClientRect();
      const match = one(scroller, ".sbs-match-current")!.getBoundingClientRect();
      expect(match.left).toBeGreaterThanOrEqual(view.left);
      expect(match.right).toBeLessThanOrEqual(view.right);
    });
  });

  it("marks the matches and the current one in the code", async () => {
    await using screen = await mount({ fileDiff: withNeedle() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));

    await press(screen, "additions", MOD_F);
    await userEvent.keyboard("needle");

    await vi.waitFor(() =>
      expect(all(scrollerOf(screen, "additions"), ".sbs-match-current")).toHaveLength(1),
    );
    expect(all(scrollerOf(screen, "additions"), ".sbs-match").length).toBeGreaterThanOrEqual(2);
    expect(all(scrollerOf(screen, "deletions"), ".sbs-match")).toHaveLength(0);
    expect(
      one(scrollerOf(screen, "additions"), ".sbs-match-current")?.textContent?.toLowerCase(),
    ).toBe("needle");
  });

  it("scrolls to the current match", async () => {
    await using screen = await mount({ fileDiff: withNeedle() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));

    await press(screen, "additions", MOD_F);
    await userEvent.keyboard("NEEDLE = 2");

    await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["50"]));
    expect(
      isVisible(
        one(scrollerOf(screen, "additions"), ".sbs-match-current")!,
        scrollerOf(screen, "additions"),
      ),
    ).toBe(true);
  });

  it("opens the fold a match is inside", async () => {
    await using screen = await mount({ fileDiff: withNeedle(), collapseUnchanged: true });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));
    const labels = (side: Side) =>
      foldsOf(screen, side).map((fold) => fold.getAttribute("aria-label"));
    // Lines 15-45 are hidden between the first and the second change.
    expect(labels("additions")).toContain("Show 31 unchanged lines");
    expect(rowByNumber(screen, "additions", 30)).toBeUndefined();

    await press(screen, "additions", MOD_F);
    await userEvent.keyboard("value030");

    await vi.waitFor(() =>
      expect(one(scrollerOf(screen, "additions"), ".sbs-match-current")).not.toBeNull(),
    );
    expect(labels("additions")).not.toContain("Show 31 unchanged lines");
    expect(labels("deletions")).not.toContain("Show 31 unchanged lines");
    expect(textOf(rowByNumber(screen, "additions", 30)!)).toBe(value(30));
    expect(rowByNumber(screen, "deletions", 30)).toBeDefined();
    expect(isVisible(rowByNumber(screen, "additions", 30)!, scrollerOf(screen, "additions"))).toBe(
      true,
    );
  });

  it("says when nothing matches", async () => {
    await using screen = await mount({ fileDiff: withNeedle() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));

    await press(screen, "additions", MOD_F);
    await userEvent.keyboard("nothing like this");

    await vi.waitFor(() => expect(findCountOf(screen)).toBe("No results"));
    await expect.element(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
    await userEvent.keyboard("{Enter}");
    expect(all(screen.container, ".sbs-match")).toHaveLength(0);
  });

  it("closes on Escape, returns focus to the pane and drops the marks", async () => {
    await using screen = await mount({ fileDiff: withNeedle() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));
    await press(screen, "additions", MOD_F);
    await userEvent.keyboard("needle");
    await vi.waitFor(() => expect(all(screen.container, ".sbs-match").length).toBeGreaterThan(0));

    await userEvent.keyboard("{Escape}");

    await vi.waitFor(() => expect(findBarOf(screen)).toBeNull());
    expect(document.activeElement).toBe(scrollerOf(screen, "additions"));
    expect(all(screen.container, ".sbs-match")).toHaveLength(0);
  });

  it("does not step through the differences from the find field", async () => {
    await using screen = await mount({ fileDiff: withNeedle() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));
    await press(screen, "additions", MOD_F);

    await userEvent.keyboard("{F7}");

    expect(statusOf(screen)).toBe("1 of 3");
    expect(document.activeElement).toBe(one(findBarOf(screen)!, "input"));
  });

  it("closes from the close button", async () => {
    await using screen = await mount({ fileDiff: withNeedle() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));
    await press(screen, "additions", MOD_F);

    await userEvent.click(screen.getByRole("button", { name: "Close find" }));

    await vi.waitFor(() => expect(findBarOf(screen)).toBeNull());
  });

  it("searches the old file from the left pane", async () => {
    await using screen = await mount({ fileDiff: withNeedle() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));

    await press(screen, "deletions", MOD_F);
    await vi.waitFor(() =>
      expect(findBarOf(screen)?.parentElement?.dataset.sbsPane).toBe("deletions"),
    );
    expect(one(findBarOf(screen)!, "input")?.getAttribute("aria-label")).toBe("Find in before");
    await userEvent.keyboard("needle");

    await vi.waitFor(() => expect(findCountOf(screen)).toBe("No results"));
    await userEvent.keyboard("{Control>}a{/Control}value010");
    await vi.waitFor(() => expect(findCountOf(screen)).toBe("1/1"));
  });

  it("closes the find bar before it closes an open annotation", async () => {
    const onOpenAnnotationChange = vi.fn();
    const annotation: SbsAnnotation = {
      id: "note",
      side: "additions",
      startLine: 10,
      endLine: 10,
      data: null,
    };
    await using screen = await mount({
      fileDiff: withNeedle(),
      annotations: [annotation],
      openAnnotationId: "note",
      renderAnnotation: () => <p>A note</p>,
      onOpenAnnotationChange,
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));
    await press(screen, "additions", MOD_F);
    await vi.waitFor(() => expect(findBarOf(screen)).not.toBeNull());

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(findBarOf(screen)).toBeNull());
    expect(onOpenAnnotationChange).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(onOpenAnnotationChange).toHaveBeenCalledExactlyOnceWith(null);
  });
});

describe("annotations", () => {
  const near: SbsAnnotation<{ text: string }> = {
    id: "near",
    side: "additions",
    startLine: 22,
    endLine: 23,
    data: { text: "Near note" },
  };
  const far: SbsAnnotation<{ text: string }> = {
    id: "far",
    side: "additions",
    startLine: 100,
    endLine: 100,
    data: { text: "Far note" },
  };
  const renderAnnotation = (annotation: SbsAnnotation) => (
    <p data-note="">{(annotation.data as { text: string }).text}</p>
  );

  const cardOf = (screen: Screen) => one(screen.container, "[data-sbs-annotation-card]");
  const markersOf = (screen: Screen) => all(screen.container, "[data-sbs-annotation]");
  const annotatedOf = (screen: Screen, side: Side) =>
    all(scrollerOf(screen, side), ".sbs-gutter[data-annotated]");

  it("marks each annotated line in the gutter, with one button on the first line, and adds no row", async () => {
    await using plain = await mount({ fileDiff: threeChanges() });
    await vi.waitFor(() => expect(statusOf(plain)).toBe("1 of 3"));
    const plainRows = rowsOf(plain, "additions").length;

    await using screen = await mount({ fileDiff: threeChanges(), annotations: [near] });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));

    await vi.waitFor(() => expect(annotatedOf(screen, "additions")).toHaveLength(2));
    expect(annotatedOf(screen, "deletions")).toHaveLength(0);
    expect(markersOf(screen)).toHaveLength(1);
    expect(markersOf(screen)[0]!.dataset.sbsAnnotation).toBe("near");
    expect(numberOf(markersOf(screen)[0]!.closest<HTMLElement>(".sbs-row")!)).toBe("22");
    expect(rowsOf(screen, "additions")).toHaveLength(plainRows);
    expect(cardOf(screen)).toBeNull();
  });

  it("marks an annotation on the old side in the left pane", async () => {
    const onOld: SbsAnnotation = {
      id: "old",
      side: "deletions",
      startLine: 20,
      endLine: 20,
      data: null,
    };
    await using screen = await mount({ fileDiff: threeChanges(), annotations: [onOld] });

    await vi.waitFor(() => expect(annotatedOf(screen, "deletions")).toHaveLength(1));
    expect(annotatedOf(screen, "additions")).toHaveLength(0);
  });

  it("leaves out an annotation on lines the file does not have", async () => {
    const missing: SbsAnnotation = {
      id: "missing",
      side: "additions",
      startLine: 900,
      endLine: 905,
      data: null,
    };
    await using screen = await mount({ fileDiff: threeChanges(), annotations: [missing] });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));

    expect(markersOf(screen)).toHaveLength(0);
    expect(annotatedOf(screen, "additions")).toHaveLength(0);
  });

  it("opens the card on a marker click and closes it on a second click", async () => {
    const onOpenAnnotationChange = vi.fn();
    await using screen = await mount({
      fileDiff: threeChanges(),
      annotations: [near],
      renderAnnotation,
      onOpenAnnotationChange,
    });
    await vi.waitFor(() => expect(markersOf(screen)).toHaveLength(1));

    await userEvent.click(markersOf(screen)[0]!);
    await vi.waitFor(() => expect(cardOf(screen)).not.toBeNull());
    expect(onOpenAnnotationChange).toHaveBeenLastCalledWith("near");
    expect(cardOf(screen)?.dataset.sbsAnnotationCard).toBe("near");
    expect(cardOf(screen)?.textContent).toContain("Near note");

    await userEvent.click(markersOf(screen)[0]!);
    await vi.waitFor(() => expect(cardOf(screen)).toBeNull());
    expect(onOpenAnnotationChange).toHaveBeenLastCalledWith(null);
  });

  it("closes the open card on Escape", async () => {
    const onOpenAnnotationChange = vi.fn();
    await using screen = await mount({
      fileDiff: threeChanges(),
      annotations: [near],
      openAnnotationId: "near",
      renderAnnotation,
      onOpenAnnotationChange,
    });
    await vi.waitFor(() => expect(cardOf(screen)).not.toBeNull());

    await press(screen, "additions", "{Escape}");

    await vi.waitFor(() => expect(cardOf(screen)).toBeNull());
    expect(onOpenAnnotationChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("leaves the diff's keys to a text field in the card", async () => {
    const onOpenAnnotationChange = vi.fn();
    await using screen = await mount({
      fileDiff: threeChanges(),
      annotations: [near],
      openAnnotationId: "near",
      renderAnnotation: () => <textarea aria-label="Reply" />,
      onOpenAnnotationChange,
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));

    const reply = screen.getByRole("textbox", { name: "Reply" });
    await userEvent.click(reply);
    await userEvent.keyboard("{F7}");
    expect(statusOf(screen)).toBe("1 of 3");
    await userEvent.keyboard(MOD_F);
    expect(findBarOf(screen)).toBeNull();
    await userEvent.keyboard("{Escape}");

    expect(cardOf(screen)).not.toBeNull();
    expect(onOpenAnnotationChange).not.toHaveBeenCalled();
    await expect.element(reply).toHaveFocus();
  });

  it("shows no card without a renderer", async () => {
    await using screen = await mount({
      fileDiff: threeChanges(),
      annotations: [near],
      openAnnotationId: "near",
    });
    await vi.waitFor(() => expect(markersOf(screen)).toHaveLength(1));

    expect(cardOf(screen)).toBeNull();
    expect(one(screen.container, ".sbs-gutter[data-annotation-open]")).not.toBeNull();
  });

  it("anchors the card under its range, follows it while scrolling and docks it when the range leaves", async () => {
    await using screen = await mount({
      fileDiff: threeChanges(),
      annotations: [near],
      openAnnotationId: "near",
      renderAnnotation,
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));
    await vi.waitFor(() => expect(cardOf(screen)).not.toBeNull());
    const right = scrollerOf(screen, "additions");
    const pane = right.parentElement!;
    const lineHeight = lineHeightOf(screen);
    const topOf = () =>
      cardOf(screen)!.getBoundingClientRect().top - pane.getBoundingClientRect().top;

    // Under line 23, 4px below it.
    const lastRow = rowByNumber(screen, "additions", 23)!;
    await vi.waitFor(() =>
      expect(
        Math.abs(
          topOf() - (lastRow.getBoundingClientRect().bottom - pane.getBoundingClientRect().top + 4),
        ),
      ).toBeLessThan(SCROLL_TOLERANCE),
    );
    expect(cardOf(screen)?.hasAttribute("data-docked")).toBe(false);
    expect(one(cardOf(screen)!, "button")).toBeNull();

    const start = topOf();
    right.scrollTop += 3 * lineHeight;
    await vi.waitFor(() =>
      expect(Math.abs(topOf() - (start - 3 * lineHeight))).toBeLessThan(SCROLL_TOLERANCE),
    );
    expect(cardOf(screen)?.hasAttribute("data-docked")).toBe(false);

    right.scrollTop = 120 * lineHeight;
    await vi.waitFor(() => expect(cardOf(screen)?.hasAttribute("data-docked")).toBe(true));
    // Docked above the viewport: held against the top edge.
    expect(Math.abs(topOf() - 4)).toBeLessThan(SCROLL_TOLERANCE);
    expect(cardOf(screen)?.textContent).toContain("Near note");
    expect(cardOf(screen)!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      pane.getBoundingClientRect().bottom,
    );
  });

  it("docks the card against the bottom edge while its range is below the viewport, and brings the range back", async () => {
    await using screen = await mount({
      fileDiff: threeChanges(),
      annotations: [far],
      openAnnotationId: "far",
      renderAnnotation,
    });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));
    await vi.waitFor(() => expect(cardOf(screen)?.hasAttribute("data-docked")).toBe(true));
    const right = scrollerOf(screen, "additions");
    const pane = right.parentElement!;
    const card = cardOf(screen)!;
    // Held against the bottom edge of the viewport, which a horizontal scrollbar would shorten.
    const gap =
      pane.getBoundingClientRect().top + right.clientHeight - card.getBoundingClientRect().bottom;
    expect(Math.abs(gap - 4)).toBeLessThan(SCROLL_TOLERANCE);

    const show = screen.getByRole("button", { name: "Show line 100" });
    await userEvent.click(show);

    await vi.waitFor(() => expect(cardOf(screen)?.hasAttribute("data-docked")).toBe(false));
    expect(isVisible(rowByNumber(screen, "additions", 100)!, right)).toBe(true);
    expect(screen.getByRole("button", { name: "Show line 100" }).elements()).toHaveLength(0);
  });

  it("names the lines of a range in the button that brings them back", async () => {
    await using screen = await mount({
      fileDiff: threeChanges(),
      annotations: [{ ...far, startLine: 100, endLine: 104 }],
      openAnnotationId: "far",
      renderAnnotation,
    });

    await expect
      .element(screen.getByRole("button", { name: "Show lines 100 to 104" }))
      .toBeVisible();
  });

  it("opens the fold that hides a docked annotation's range when the lines are brought back", async () => {
    // Short enough that the fold holding line 150 is below the viewport.
    await using screen = await mount(
      {
        fileDiff: threeChanges(),
        collapseUnchanged: true,
        annotations: [
          { id: "deep", side: "additions", startLine: 150, endLine: 150, data: { text: "Deep" } },
        ],
        openAnnotationId: "deep",
        renderAnnotation,
      },
      { height: 220 },
    );
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));
    await vi.waitFor(() => expect(cardOf(screen)?.hasAttribute("data-docked")).toBe(true));
    expect(rowByNumber(screen, "additions", 150)).toBeUndefined();

    await userEvent.click(screen.getByRole("button", { name: "Show line 150" }));

    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 150)).toBeDefined());
    expect(rowByNumber(screen, "deletions", 150)).toBeDefined();
    await vi.waitFor(() => expect(cardOf(screen)?.hasAttribute("data-docked")).toBe(false));
    expect(isVisible(rowByNumber(screen, "additions", 150)!, scrollerOf(screen, "additions"))).toBe(
      true,
    );
  });

  it("leaves the rows, their positions and the connectors as they are with the card open", async () => {
    // The same steps, with and without a card, ending on the same frame.
    async function run(withCard: boolean) {
      await using screen = await mount({
        fileDiff: threeChanges(),
        ...(withCard
          ? { annotations: [near], openAnnotationId: "near", renderAnnotation }
          : { annotations: [] }),
      });
      await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));
      if (withCard) await vi.waitFor(() => expect(cardOf(screen)).not.toBeNull());
      const right = scrollerOf(screen, "additions");
      right.scrollTop = 40 * lineHeightOf(screen);
      await vi.waitFor(() =>
        expect(Math.abs(scrollerOf(screen, "deletions").scrollTop - right.scrollTop)).toBeLessThan(
          SCROLL_TOLERANCE,
        ),
      );
      await press(screen, "additions", "{F7}");
      await vi.waitFor(() => expect(statusOf(screen)).toBe("2 of 3"));
      await vi.waitFor(() => expect(visibleTinted(screen, "additions")).toEqual(["100"]));
      await vi.waitFor(() => expect(connectorsOf(screen)).toHaveLength(1));
      if (withCard) expect(cardOf(screen)?.hasAttribute("data-docked")).toBe(true);

      const layout = (side: Side) => {
        const top = scrollerOf(screen, side).getBoundingClientRect().top;
        return {
          scrollTop: Math.round(scrollerOf(screen, side).scrollTop),
          rows: all(scrollerOf(screen, side), ".sbs-row").map((row) => [
            row.dataset.sbsIndex,
            row.dataset.tint,
            Math.round(row.getBoundingClientRect().top - top),
          ]),
        };
      };
      return {
        deletions: layout("deletions"),
        additions: layout("additions"),
        connectors: connectorsOf(screen).map((connector) => connector.getAttribute("d")),
        height: one(scrollerOf(screen, "additions"), ".sbs-sheet")!.getBoundingClientRect().height,
      };
    }

    const without = await run(false);
    const withCard = await run(true);

    expect(withCard.additions.rows.length).toBeGreaterThan(20);
    expect(withCard).toEqual(without);
  });

  it("moves the card to the new range when another annotation opens", async () => {
    await using screen = await mount({
      fileDiff: threeChanges(),
      annotations: [near, far],
      openAnnotationId: "near",
      renderAnnotation,
    });
    await vi.waitFor(() => expect(cardOf(screen)?.dataset.sbsAnnotationCard).toBe("near"));

    await press(screen, "additions", "{Escape}");
    await vi.waitFor(() => expect(cardOf(screen)).toBeNull());
    await vi.waitFor(() => expect(markersOf(screen).length).toBeGreaterThan(0));
    await userEvent.click(
      markersOf(screen).find((marker) => marker.dataset.sbsAnnotation === "near")!,
    );
    await vi.waitFor(() => expect(cardOf(screen)?.dataset.sbsAnnotationCard).toBe("near"));
  });
});

describe("copy", () => {
  const copyFrom = (target: Element) => {
    const clipboardData = new DataTransfer();
    target.dispatchEvent(
      new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true }),
    );
    return clipboardData.getData("text/plain");
  };

  it("copies a selection whose first line has left the rendered rows", async () => {
    await using screen = await mount({ fileDiff: threeChanges() });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 5)).toBeDefined());
    const at = (line: number, column: number) =>
      textPointAt(one(rowByNumber(screen, "additions", line)!, ".sbs-code")!, column);
    const start = at(5, 2);
    window.getSelection()!.setBaseAndExtent(start.node, start.offset, start.node, start.offset + 3);
    one(screen.container, ".sbs-diff")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    const right = scrollerOf(screen, "additions");
    right.scrollTop = 150 * lineHeightOf(screen);
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 160)).toBeDefined());
    expect(rowByNumber(screen, "additions", 5)).toBeUndefined();
    const end = at(160, 4);
    window.getSelection()!.extend(end.node, end.offset);

    const lines = threeChangesAfter();
    expect(copyFrom(right)).toBe(
      [lines[4]!.slice(2), ...lines.slice(5, 159), lines[159]!.slice(0, 4)].join("\n"),
    );
  });

  it("selects one pane's whole file with Mod+A and copies it", async () => {
    await using screen = await mount({ fileDiff: threeChanges() });
    await vi.waitFor(() => expect(statusOf(screen)).toBe("1 of 3"));

    await press(
      screen,
      "additions",
      isMacPlatform(navigator.platform) ? "{Meta>}a{/Meta}" : "{Control>}a{/Control}",
    );

    expect(window.getSelection()?.toString() ?? "").toBe("");
    expect(
      one(screen.container, '[data-sbs-pane="additions"][data-sbs-all-selected]'),
    ).not.toBeNull();
    expect(copyFrom(scrollerOf(screen, "additions"))).toBe(threeChangesAfter().join("\n"));
  });

  it("keeps a selection dragged into the other pane in the pane it started in", async () => {
    await using screen = await mount({ fileDiff: threeChanges() });
    await vi.waitFor(() => expect(rowByNumber(screen, "deletions", 10)).toBeDefined());
    const at = (side: Side, line: number, column: number) =>
      textPointAt(one(rowByNumber(screen, side, line)!, ".sbs-code")!, column);
    const focusPaneOf = () =>
      window
        .getSelection()
        ?.focusNode?.parentElement?.closest("[data-sbs-pane]")
        ?.getAttribute("data-sbs-pane");
    const lines = base();

    // Into the right pane: to the end of the left pane's line at that height.
    const left = at("deletions", 5, 2);
    const right = at("additions", 10, 4);
    window.getSelection()!.setBaseAndExtent(left.node, left.offset, right.node, right.offset);
    expect(copyFrom(scrollerOf(screen, "deletions"))).toBe(
      [lines[4]!.slice(2), ...lines.slice(5, 10)].join("\n"),
    );
    await vi.waitFor(() => expect(focusPaneOf()).toBe("deletions"));

    // Into the left pane: to the start of the right pane's line at that height.
    const from = at("additions", 10, 4);
    const to = at("deletions", 5, 2);
    window.getSelection()!.setBaseAndExtent(from.node, from.offset, to.node, to.offset);
    expect(copyFrom(scrollerOf(screen, "additions"))).toBe(
      [...threeChangesAfter().slice(4, 9), threeChangesAfter()[9]!.slice(0, 4)].join("\n"),
    );
    await vi.waitFor(() => expect(focusPaneOf()).toBe("additions"));
  });

  it("copies the lines picked in the gutter, each with its line break", async () => {
    await using screen = await mount({ fileDiff: threeChanges() });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 14)).toBeDefined());
    const gutter = (line: number) => one(rowByNumber(screen, "additions", line)!, ".sbs-gutter")!;

    await userEvent.click(gutter(12));
    await userEvent.click(gutter(14), { modifiers: ["Shift"] });

    expect(copyFrom(scrollerOf(screen, "additions"))).toBe(
      `${threeChangesAfter().slice(11, 14).join("\n")}\n`,
    );
  });
});

describe("selecting a range", () => {
  const gutterOf = (screen: Screen, side: Side, line: number) =>
    one(rowByNumber(screen, side, line)!, ".sbs-gutter")!;
  const selectedOf = (screen: Screen, side: Side) =>
    rowsOf(screen, side)
      .filter((row) => row.dataset.selected !== undefined)
      .map(numberOf);

  it("reports a line picked by a click in the line-number gutter", async () => {
    const onSelectRange = vi.fn();
    await using screen = await mount({ fileDiff: threeChanges(), onSelectRange });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 12)).toBeDefined());

    await userEvent.click(gutterOf(screen, "additions", 12));

    expect(onSelectRange).toHaveBeenCalledExactlyOnceWith({
      side: "additions",
      startLine: 12,
      endLine: 12,
      selectedText: "",
    });
    expect(selectedOf(screen, "additions")).toEqual(["12"]);
    expect(document.activeElement).toBe(scrollerOf(screen, "additions"));
  });

  it("extends the picked lines with Shift+click, from the first click", async () => {
    const onSelectRange = vi.fn();
    await using screen = await mount({ fileDiff: threeChanges(), onSelectRange });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 15)).toBeDefined());

    await userEvent.click(gutterOf(screen, "additions", 12));
    await userEvent.click(gutterOf(screen, "additions", 15), { modifiers: ["Shift"] });

    expect(onSelectRange).toHaveBeenLastCalledWith({
      side: "additions",
      startLine: 12,
      endLine: 15,
      selectedText: "",
    });
    expect(selectedOf(screen, "additions")).toEqual(["12", "13", "14", "15"]);

    await userEvent.click(gutterOf(screen, "additions", 9), { modifiers: ["Shift"] });
    expect(onSelectRange).toHaveBeenLastCalledWith({
      side: "additions",
      startLine: 9,
      endLine: 12,
      selectedText: "",
    });
    expect(selectedOf(screen, "additions")).toEqual(["9", "10", "11", "12"]);
  });

  it("starts a new pick when Shift+click is in the other pane", async () => {
    const onSelectRange = vi.fn();
    await using screen = await mount({ fileDiff: threeChanges(), onSelectRange });
    await vi.waitFor(() => expect(rowByNumber(screen, "deletions", 15)).toBeDefined());

    await userEvent.click(gutterOf(screen, "additions", 12));
    await userEvent.click(gutterOf(screen, "deletions", 15), { modifiers: ["Shift"] });

    expect(onSelectRange).toHaveBeenLastCalledWith({
      side: "deletions",
      startLine: 15,
      endLine: 15,
      selectedText: "",
    });
    expect(selectedOf(screen, "additions")).toEqual([]);
    expect(selectedOf(screen, "deletions")).toEqual(["15"]);
  });

  it("reports the lines dragged across in the gutter", async () => {
    const onSelectRange = vi.fn();
    await using screen = await mount({ fileDiff: threeChanges(), onSelectRange });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 16)).toBeDefined());

    await userEvent.dragAndDrop(
      gutterOf(screen, "additions", 13),
      gutterOf(screen, "additions", 16),
    );

    expect(onSelectRange).toHaveBeenCalledExactlyOnceWith({
      side: "additions",
      startLine: 13,
      endLine: 16,
      selectedText: "",
    });
    expect(selectedOf(screen, "additions")).toEqual(["13", "14", "15", "16"]);
  });

  it("reports a drag upwards as an ascending range", async () => {
    const onSelectRange = vi.fn();
    await using screen = await mount({ fileDiff: threeChanges(), onSelectRange });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 16)).toBeDefined());

    await userEvent.dragAndDrop(
      gutterOf(screen, "additions", 16),
      gutterOf(screen, "additions", 13),
    );

    expect(onSelectRange).toHaveBeenCalledExactlyOnceWith({
      side: "additions",
      startLine: 13,
      endLine: 16,
      selectedText: "",
    });
  });

  it("gives the lines up on Escape with null", async () => {
    const onSelectRange = vi.fn();
    await using screen = await mount({ fileDiff: threeChanges(), onSelectRange });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 12)).toBeDefined());
    await userEvent.click(gutterOf(screen, "additions", 12));

    await userEvent.keyboard("{Escape}");

    expect(onSelectRange).toHaveBeenLastCalledWith(null);
    expect(onSelectRange).toHaveBeenCalledTimes(2);
    expect(selectedOf(screen, "additions")).toEqual([]);

    await userEvent.keyboard("{Escape}");
    expect(onSelectRange).toHaveBeenCalledTimes(2);
  });

  it("gives the lines up when a click lands in the code instead", async () => {
    const onSelectRange = vi.fn();
    await using screen = await mount({ fileDiff: threeChanges(), onSelectRange });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 12)).toBeDefined());
    await userEvent.click(gutterOf(screen, "additions", 12));

    await userEvent.click(one(rowByNumber(screen, "additions", 14)!, ".sbs-code")!);

    expect(onSelectRange).toHaveBeenLastCalledWith(null);
    expect(selectedOf(screen, "additions")).toEqual([]);
  });

  it("closes the open annotation first on Escape, then the picked lines", async () => {
    const onSelectRange = vi.fn();
    const onOpenAnnotationChange = vi.fn();
    const note: SbsAnnotation = {
      id: "note",
      side: "additions",
      startLine: 22,
      endLine: 22,
      data: null,
    };
    await using screen = await mount({
      fileDiff: threeChanges(),
      onSelectRange,
      onOpenAnnotationChange,
      annotations: [note],
      openAnnotationId: "note",
      renderAnnotation: () => <p>A note</p>,
    });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 12)).toBeDefined());
    await userEvent.click(gutterOf(screen, "additions", 12));

    await userEvent.keyboard("{Escape}");
    expect(onOpenAnnotationChange).toHaveBeenCalledExactlyOnceWith(null);
    expect(onSelectRange).toHaveBeenCalledTimes(1);

    await userEvent.keyboard("{Escape}");
    expect(onSelectRange).toHaveBeenLastCalledWith(null);
  });

  it("does not pick lines from a click on an annotation marker", async () => {
    const onSelectRange = vi.fn();
    const note: SbsAnnotation = {
      id: "note",
      side: "additions",
      startLine: 22,
      endLine: 22,
      data: null,
    };
    await using screen = await mount({
      fileDiff: threeChanges(),
      onSelectRange,
      annotations: [note],
      renderAnnotation: () => <p>A note</p>,
    });
    await vi.waitFor(() => expect(one(screen.container, "[data-sbs-annotation]")).not.toBeNull());

    await userEvent.click(one(screen.container, "[data-sbs-annotation]")!);

    expect(onSelectRange).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(one(screen.container, "[data-sbs-annotation-card]")).not.toBeNull(),
    );
  });

  it("reports selected text with its lines", async () => {
    const onSelectRange = vi.fn();
    await using screen = await mount({ fileDiff: threeChanges(), onSelectRange });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 12)).toBeDefined());

    await userEvent.dblClick(one(rowByNumber(screen, "additions", 12)!, ".sbs-code")!, {
      position: { x: 60, y: 6 },
    });

    expect(onSelectRange).toHaveBeenCalledOnce();
    const selection = onSelectRange.mock.calls[0]![0];
    expect(selection).toMatchObject({ side: "additions", startLine: 12, endLine: 12 });
    expect(selection.selectedText.length).toBeGreaterThan(0);
    expect(value(12)).toContain(selection.selectedText.trim());
  });

  it("reports the lines of a text selection across rows, without the line it stops before", async () => {
    const onSelectRange = vi.fn();
    await using screen = await mount({ fileDiff: threeChanges(), onSelectRange });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 14)).toBeDefined());
    const at = (line: number, column: number) =>
      textPointAt(one(rowByNumber(screen, "additions", line)!, ".sbs-code")!, column);

    const selectRange = (endLine: number, endColumn: number) => {
      const start = at(12, 6);
      const end = at(endLine, endColumn);
      window.getSelection()!.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
      one(screen.container, ".sbs-diff")!.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true }),
      );
    };

    selectRange(14, 5);
    expect(onSelectRange).toHaveBeenLastCalledWith({
      side: "additions",
      startLine: 12,
      endLine: 14,
      selectedText: expect.stringContaining("value012"),
    });

    // Ending before the first character of line 14 leaves line 14 out.
    selectRange(14, 0);
    expect(onSelectRange).toHaveBeenLastCalledWith(
      expect.objectContaining({ side: "additions", startLine: 12, endLine: 13 }),
    );
  });

  it("gives a text selection up with null once it is collapsed", async () => {
    const onSelectRange = vi.fn();
    await using screen = await mount({ fileDiff: threeChanges(), onSelectRange });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 12)).toBeDefined());
    await userEvent.dblClick(one(rowByNumber(screen, "additions", 12)!, ".sbs-code")!, {
      position: { x: 60, y: 6 },
    });
    expect(onSelectRange).toHaveBeenCalledOnce();

    await userEvent.click(one(rowByNumber(screen, "additions", 14)!, ".sbs-code")!, {
      position: { x: 4, y: 6 },
    });

    expect(onSelectRange).toHaveBeenLastCalledWith(null);
  });

  it("reports a selection dragged into the other pane in the pane it started in", async () => {
    const onSelectRange = vi.fn();
    await using screen = await mount({ fileDiff: threeChanges(), onSelectRange });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 14)).toBeDefined());
    const at = (side: Side, line: number, column: number) =>
      textPointAt(one(rowByNumber(screen, side, line)!, ".sbs-code")!, column);
    const start = at("deletions", 12, 2);
    const end = at("additions", 14, 5);

    window.getSelection()!.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
    one(screen.container, ".sbs-diff")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(onSelectRange).toHaveBeenCalledExactlyOnceWith({
      side: "deletions",
      startLine: 12,
      endLine: 14,
      selectedText: [base()[11]!.slice(2), ...base().slice(12, 14)].join("\n"),
    });
  });

  it("numbers a patch-only selection by its hunk", async () => {
    const onSelectRange = vi.fn();
    await using screen = await mount({ fileDiff: twoHunkPatch(), onSelectRange });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 80)).toBeDefined());

    await userEvent.click(gutterOf(screen, "additions", 79));
    await userEvent.click(gutterOf(screen, "additions", 81), { modifiers: ["Shift"] });

    expect(onSelectRange).toHaveBeenLastCalledWith({
      side: "additions",
      startLine: 79,
      endLine: 81,
      selectedText: "",
    });
  });

  it("works without an onSelectRange", async () => {
    await using screen = await mount({ fileDiff: threeChanges() });
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 12)).toBeDefined());

    await userEvent.click(gutterOf(screen, "additions", 12));

    expect(selectedOf(screen, "additions")).toEqual(["12"]);
    await userEvent.keyboard("{Escape}");
    expect(selectedOf(screen, "additions")).toEqual([]);
  });
});
