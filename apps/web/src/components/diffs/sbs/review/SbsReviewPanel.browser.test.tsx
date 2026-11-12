import "~/index.css";

import {
  parseDiffFromFile,
  type FileDiffContentsLoader,
  type FileDiffLoadedFiles,
} from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { RunId, TurnItemId } from "@t3tools/contracts";
import { type ReviewNote, reviewNoteSectionId } from "@t3tools/shared/reviewNote";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildDiffReviewComment, type ReviewCommentContext } from "~/reviewCommentContext";

import { render, type Screen } from "../../../../../test/render";
import type { ReviewSendOutcome } from "../../../chat/composerSend.logic";
import type { DiffReviewNotes } from "../../AnnotatableCodeView";
import type { PlacedReviewNote } from "../../reviewNoteAnchoring";
import type { SendReviewComments } from "../../useReviewCommentDrafts";
import type { SbsFileEntry, SbsPatchState } from "../SideBySideDiffPanel";
import { SbsReviewPanel, type SbsReviewPanelProps } from "./SbsReviewPanel";

const COLLAPSE_KEY = "t3code.sbsDiff.collapseUnchanged";
const HIGHLIGHT_KEY = "t3code.sbsDiff.highlightMode";

const target = DraftId.make("sbs-review-test");
const SECTION = "unstaged";
const SELECTION_MARKER = "sbs-review:selection";

type Side = "deletions" | "additions";

const pad = (n: number) => String(n).padStart(3, "0");
const base = (count = 40) =>
  Array.from({ length: count }, (_, index) => `const value${pad(index + 1)} = ${index + 1};`);
const join = (lines: ReadonlyArray<string>) => lines.map((line) => `${line}\n`).join("");
const value = (n: number) => `const value${pad(n)} = ${n};`;

interface Texts {
  readonly before: string;
  readonly after: string;
}

/** `count` lines, with the 1-based lines named in `changes` replaced by `const <tag> = 1;`. */
const textsOf = (changes: Readonly<Record<number, string>>, count = 40): Texts => ({
  before: join(base(count)),
  after: join(
    base(count).map((line, index) => {
      const tag = changes[index + 1];
      return tag === undefined ? line : `const ${tag} = 1;`;
    }),
  ),
});

/** Lines 10 and 20 changed: line 10 reads `const alpha = 1;` on the new side. */
const TEXTS_A = textsOf({ 10: "alpha", 20: "beta" });
const TEXTS_B = textsOf({ 5: "gamma" });

const entryOf = (name: string, texts: Texts): SbsFileEntry => ({
  fileKey: name,
  filePath: name,
  fileDiff: parseDiffFromFile({ name, contents: texts.before }, { name, contents: texts.after }),
});

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
  return { fileKey: name, filePath: name, fileDiff: parsePatchFiles(patch)[0]!.files[0]! };
}

const filesOf = (texts: Texts, name: string): FileDiffLoadedFiles => ({
  oldFile: { name, contents: texts.before },
  newFile: { name, contents: texts.after },
});

/** A loader that answers each file from `byName`. */
const loaderOf = (byName: Readonly<Record<string, Texts>>) =>
  vi.fn<FileDiffContentsLoader>(async (fileDiff) => filesOf(byName[fileDiff.name]!, fileDiff.name));

const LOADER = loaderOf({ "a.ts": TEXTS_A, "b.ts": TEXTS_B });

const settled: SbsPatchState = { pending: false, error: false, truncated: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

const HEX_TAIL = "0123456789abcdef0123456789abcd";

function noteOf(
  n: number,
  startLine: number,
  endLine = startLine,
  path = "a.ts",
): ReviewNote & { readonly id: TurnItemId } {
  return {
    id: TurnItemId.make(`turn-item:review-note:thread-1:${HEX_TAIL}${String(n).padStart(2, "0")}`),
    kind: "review_note",
    path,
    startLine,
    endLine,
    note: `Flagged note number ${n}.`,
    excerpt: `const flagged${n} = ${n};`,
    excerptTruncated: false,
    contentRevision: "3b18e512dba79e4c8300dd08aeb37f8e728b8dad",
    runId: RunId.make("run-1"),
  };
}

const exact = (
  note: ReviewNote,
  fileKey = "a.ts",
  kind: "exact" | "moved" = "exact",
): PlacedReviewNote => ({
  note,
  fileKey,
  anchor: { kind, startLine: note.startLine, endLine: note.endLine },
});

const notesOf = (
  placed: ReadonlyArray<PlacedReviewNote>,
  onDismiss: DiffReviewNotes["onDismiss"] = () => undefined,
  answered: ReadonlyArray<TurnItemId> = [],
): DiffReviewNotes => ({ placed, answeredIds: new Set(answered), onDismiss });

const NO_NOTES = notesOf([]);

type PanelProps = Partial<SbsReviewPanelProps> & { readonly files: ReadonlyArray<SbsFileEntry> };

/**
 * The panel as DiffPanel holds it: a note asked for stays asked for until the panel says it is
 * in view or has no lines, and the caller's callbacks hear about it.
 */
function Harness({ noteReveal = null, onNoteRevealed, onNoteUnplaced, ...rest }: PanelProps) {
  const [reveal, setReveal] = useState(noteReveal);
  // A new request in a rerender is a new step, as DiffPanel sets one.
  const [asked, setAsked] = useState(noteReveal);
  if (noteReveal !== asked) {
    setAsked(noteReveal);
    setReveal(noteReveal);
  }
  return (
    <SbsReviewPanel
      selectedFileKey={null}
      onSelectFile={() => undefined}
      loadFileContents={LOADER}
      scopeKey="scope-1"
      contentsKey="contents-1"
      ignoreWhitespace={false}
      patchState={() => settled}
      onRequestPatch={() => undefined}
      onRetryPatch={() => undefined}
      onOpenFile={() => undefined}
      sectionId={SECTION}
      sectionTitle="Changes"
      composerDraftTarget={target}
      reviewNotes={NO_NOTES}
      {...rest}
      noteReveal={reveal}
      onNoteRevealed={() => {
        onNoteRevealed?.();
        setReveal(null);
      }}
      onNoteUnplaced={() => {
        onNoteUnplaced?.();
        setReveal(null);
      }}
    />
  );
}

/** Starts the test from an empty message draft and the settings a first-time user has. */
function setup(): Disposable {
  const reset = () => useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  reset();
  // Every row of a short file is mounted, so a test can reach any line without scrolling.
  localStorage.setItem(COLLAPSE_KEY, "false");
  localStorage.removeItem(HIGHLIGHT_KEY);
  return { [Symbol.dispose]: reset };
}

function mount(props: PanelProps) {
  const container = document.createElement("div");
  Object.assign(container.style, {
    display: "flex",
    flexDirection: "column",
    width: "1000px",
    height: "1100px",
  });
  // The panel needs no routes, only a box to fill.
  return render(<Harness {...props} />, { container, router: false });
}

const saved = () => useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments ?? [];

interface SeedInput {
  readonly id: string;
  readonly side: Side;
  readonly start: number;
  readonly end?: number;
  readonly endSide?: Side;
  readonly text?: string;
  readonly sectionId?: string;
  readonly filePath?: string;
  readonly fenceLanguage?: string;
}

/** Puts a comment on lines `entry` has into the message draft, as the stacked view would. */
function seed(entry: SbsFileEntry, input: SeedInput): ReviewCommentContext {
  const built = buildDiffReviewComment({
    id: input.id,
    sectionId: input.sectionId ?? SECTION,
    sectionTitle: "Changes",
    filePath: input.filePath ?? entry.filePath,
    fileDiff: entry.fileDiff,
    range: {
      start: input.start,
      side: input.side,
      end: input.end ?? input.start,
      endSide: input.endSide ?? input.side,
    },
    text: input.text ?? `Comment ${input.id}`,
  });
  if (!built) throw new Error(`No lines ${input.start} of ${entry.filePath} to comment on`);
  const comment = input.fenceLanguage ? { ...built, fenceLanguage: input.fenceLanguage } : built;
  useComposerDraftStore.getState().addReviewComment(target, comment, { appendReference: false });
  return comment;
}

const all = (root: ParentNode, selector: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(selector));
const one = (root: ParentNode, selector: string) => root.querySelector<HTMLElement>(selector);

const scrollerOf = (screen: Screen, side: Side) =>
  one(screen.container, `[data-sbs-scroller="${side}"]`)!;
const rowsOf = (screen: Screen, side: Side) =>
  all(scrollerOf(screen, side), ".sbs-row[data-sbs-index]");
const numberOf = (row: HTMLElement) => one(row, ".sbs-gutter")!.textContent;
const rowByNumber = (screen: Screen, side: Side, line: number) =>
  rowsOf(screen, side).find((row) => numberOf(row) === String(line));
const gutterOf = (screen: Screen, side: Side, line: number) =>
  one(rowByNumber(screen, side, line)!, ".sbs-gutter")!;
const codeOf = (screen: Screen, side: Side, line: number) =>
  one(rowByNumber(screen, side, line)!, ".sbs-code")!;
const selectedOf = (screen: Screen, side: Side) =>
  rowsOf(screen, side)
    .filter((row) => row.dataset.selected !== undefined)
    .map(numberOf);
/** The line numbers a pane marks for an annotation. */
const annotatedOf = (screen: Screen, side: Side) =>
  rowsOf(screen, side)
    .filter((row) => one(row, ".sbs-gutter")?.hasAttribute("data-annotated"))
    .map(numberOf);
const markersOf = (screen: Screen) =>
  all(screen.container, "[data-sbs-annotation]").map((marker) =>
    marker.getAttribute("data-sbs-annotation")!,
  );
const markerOf = (screen: Screen, id: string) =>
  one(screen.container, `[data-sbs-annotation="${id}"]`)!;
const cardOf = (screen: Screen) => one(screen.container, "[data-sbs-annotation-card]");
const cardText = (screen: Screen) => cardOf(screen)?.textContent ?? "";
const noticesOf = (screen: Screen) =>
  all(screen.container, "p.border-b").map((notice) => notice.textContent ?? "");
const lostLinesNotice = (screen: Screen) =>
  noticesOf(screen).find((text) => text.includes(" in the message "));

function isVisible(element: HTMLElement, scroller: HTMLElement) {
  const box = scroller.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return rect.bottom > box.top && rect.top < box.bottom;
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

async function showsRows(screen: Screen, side: Side, ...lines: number[]) {
  await vi.waitFor(() => {
    for (const line of lines) expect(rowByNumber(screen, side, line)).toBeDefined();
  });
}

/** Selects text in one pane the way a drag does, and lets go of the mouse. */
async function selectText(
  screen: Screen,
  side: Side,
  from: { readonly line: number; readonly column: number },
  to: { readonly line: number; readonly column: number } = from,
) {
  await showsRows(screen, side, from.line, to.line);
  const start = textPointAt(codeOf(screen, side, from.line), from.column);
  const end = textPointAt(codeOf(screen, side, to.line), to.column);
  window.getSelection()!.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
  releaseMouse(screen);
}

const releaseMouse = (screen: Screen) =>
  one(screen.container, ".sbs-diff")!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

/** Picks lines in the gutter: a click, then a Shift+click for a range. */
async function pickLines(screen: Screen, side: Side, from: number, to = from) {
  await showsRows(screen, side, from, to);
  // A number can show twice in a patch, so the gutter is clicked by a test id, not by its text.
  const click = async (line: number, modifiers?: Array<"Shift">) => {
    const gutter = gutterOf(screen, side, line);
    gutter.setAttribute("data-testid", "pick-gutter");
    await userEvent.click(page.getByTestId("pick-gutter"), modifiers ? { modifiers } : undefined);
    gutter.removeAttribute("data-testid");
  };
  await click(from);
  if (to !== from) await click(to, ["Shift"]);
}

const button = (screen: Screen, name: string) => screen.getByRole("button", { name, exact: true });

async function expectPickCard(screen: Screen, label: string) {
  await vi.waitFor(() => expect(cardText(screen)).toContain(label));
  await expect.element(button(screen, "Comment")).toBeVisible();
}

/** Picks the lines, opens the box on them and types `words` into it. */
async function openBox(
  screen: Screen,
  side: Side,
  from: number,
  to = from,
  words: string | null = "My words",
) {
  await pickLines(screen, side, from, to);
  await userEvent.click(button(screen, "Comment"));
  await expect.element(screen.getByRole("textbox")).toBeVisible();
  if (words !== null) await userEvent.fill(screen.getByRole("textbox"), words);
}

const copyFrom = (element: Element) => {
  const clipboardData = new DataTransfer();
  const event = new ClipboardEvent("copy", { clipboardData, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return { text: clipboardData.getData("text/plain"), prevented: event.defaultPrevented };
};

const SELECTION_OF = (start: number, side: Side, end = start, endSide: Side = side) => ({
  start,
  side,
  end,
  endSide,
});

const A = entryOf("a.ts", TEXTS_A);
const B = entryOf("b.ts", TEXTS_B);

describe("picking lines", () => {
  it.each([
    { name: "one line of the new pane", side: "additions", from: 12, to: 12, label: "Line 12" },
    {
      name: "a range of the new pane",
      side: "additions",
      from: 12,
      to: 14,
      label: "Lines 12 to 14",
    },
    { name: "one line of the old pane", side: "deletions", from: 12, to: 12, label: "Old line 12" },
    {
      name: "a range of the old pane",
      side: "deletions",
      from: 12,
      to: 13,
      label: "Old lines 12 to 13",
    },
  ] as const)("opens a card for $name picked in the gutter", async ({ side, from, to, label }) => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });

    await pickLines(screen, side, from, to);

    await expectPickCard(screen, label);
    expect(markersOf(screen)).toEqual([SELECTION_MARKER]);
    expect(saved()).toEqual([]);
  });

  it("reports a gutter pick dragged across lines", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await showsRows(screen, "additions", 13, 16);

    await userEvent.dragAndDrop(
      gutterOf(screen, "additions", 13),
      gutterOf(screen, "additions", 16),
    );

    await expectPickCard(screen, "Lines 13 to 16");
  });

  it.each([
    { name: "within a line of the new pane", side: "additions", to: 12, label: "Line 12" },
    { name: "across lines of the new pane", side: "additions", to: 13, label: "Lines 12 to 13" },
    { name: "within a line of the old pane", side: "deletions", to: 12, label: "Old line 12" },
    {
      name: "across lines of the old pane",
      side: "deletions",
      to: 13,
      label: "Old lines 12 to 13",
    },
  ] as const)("opens a card for text selected $name", async ({ side, to, label }) => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });

    await selectText(screen, side, { line: 12, column: 6 }, { line: to, column: 10 });

    await expectPickCard(screen, label);
  });

  it("opens the card when the selection is extended with the Shift key", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await showsRows(screen, "additions", 12, 13);
    const start = textPointAt(codeOf(screen, "additions", 12), 6);
    const end = textPointAt(codeOf(screen, "additions", 13), 10);

    window.getSelection()!.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
    one(screen.container, ".sbs-diff")!.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Shift", shiftKey: true, bubbles: true }),
    );

    await expectPickCard(screen, "Lines 12 to 13");
  });

  it("leaves out the last line when the selection stops before its first character", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });

    await selectText(screen, "additions", { line: 12, column: 6 }, { line: 14, column: 0 });

    await expectPickCard(screen, "Lines 12 to 13");
  });

  it("closes the card when a click in the code gives the lines up", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await pickLines(screen, "additions", 12);
    await expectPickCard(screen, "Line 12");

    await userEvent.click(codeOf(screen, "additions", 16));

    await vi.waitFor(() => expect(cardOf(screen)).toBeNull());
    expect(markersOf(screen)).toEqual([]);
    expect(selectedOf(screen, "additions")).toEqual([]);
  });

  it("closes the card, then drops the pick, on Escape", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await pickLines(screen, "additions", 12);
    await expectPickCard(screen, "Line 12");

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(cardOf(screen)).toBeNull());
    expect(markersOf(screen)).toEqual([SELECTION_MARKER]);

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([]));
  });

  it("closes the card when a text selection collapses", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await selectText(screen, "additions", { line: 12, column: 6 }, { line: 12, column: 14 });
    await expectPickCard(screen, "Line 12");

    window.getSelection()!.removeAllRanges();
    releaseMouse(screen);

    await vi.waitFor(() => expect(cardOf(screen)).toBeNull());
    expect(markersOf(screen)).toEqual([]);
  });

  it("replaces a pick with the next one", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await pickLines(screen, "additions", 12);
    await expectPickCard(screen, "Line 12");

    await pickLines(screen, "deletions", 15);

    await expectPickCard(screen, "Old line 15");
    expect(markersOf(screen)).toEqual([SELECTION_MARKER]);
    expect(annotatedOf(screen, "additions")).toEqual([]);
    expect(annotatedOf(screen, "deletions")).toEqual(["15"]);
  });

  it("opens the box on the picked lines", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });

    await openBox(screen, "additions", 12, 14, null);

    expect(screen.getByRole("textbox").element().getAttribute("aria-label")).toMatch(
      /^Comment on lines /u,
    );
    expect(annotatedOf(screen, "additions")).toEqual(["12", "13", "14"]);
    expect(markersOf(screen)).toHaveLength(1);
    // The pick became the box: no second card entry for the same lines.
    expect(cardText(screen)).not.toContain("Lines 12 to 14");
  });

  it("quotes the words selected in the new pane", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await selectText(screen, "additions", { line: 12, column: 6 }, { line: 12, column: 14 });
    await expectPickCard(screen, "Line 12");

    await userEvent.click(button(screen, "Comment"));
    await expect.element(screen.getByRole("textbox")).toBeVisible();
    expect(cardText(screen)).toContain("value012");
    await userEvent.fill(screen.getByRole("textbox"), "Why this name?");
    await userEvent.click(button(screen, "Comment"));

    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]!.text).toBe("> value012\n\nWhy this name?");
  });

  it("quotes words selected in the old pane from the lines it commented on", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    // Old line 10 is a line the change deleted: only the old pane has it.
    await selectText(screen, "deletions", { line: 10, column: 6 }, { line: 10, column: 14 });
    await expectPickCard(screen, "Old line 10");

    await userEvent.click(button(screen, "Comment"));
    await userEvent.fill(screen.getByRole("textbox"), "Gone for a reason?");
    await userEvent.click(button(screen, "Comment"));

    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]!.text).toBe("> value010\n\nGone for a reason?");
    expect(saved()[0]!.selection).toEqual(SELECTION_OF(10, "deletions"));
  });

  it("quotes nothing for lines picked in the gutter", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });

    await openBox(screen, "additions", 12, 12, "Plain words");
    await userEvent.click(button(screen, "Comment"));

    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]!.text).toBe("Plain words");
  });
});

describe("the comment box", () => {
  it("adds one comment to the message on the picked lines of the new pane", async () => {
    using _drafts = setup();
    const onSendComments = vi.fn<SendReviewComments>(async () => ({ status: "dispatched" }));
    await using screen = await mount({ files: [A], onSendComments });
    await openBox(screen, "additions", 12, 14, "Rename these");

    await userEvent.click(button(screen, "Add to message"));

    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({
      sectionId: SECTION,
      filePath: "a.ts",
      text: "Rename these",
      selection: SELECTION_OF(12, "additions", 14),
    });
    expect(onSendComments).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    // The comment stays on the lines as a marker.
    expect(annotatedOf(screen, "additions")).toEqual(["12", "13", "14"]);
  });

  it("adds a comment on old-side lines with the old side as its selection", async () => {
    using _drafts = setup();
    await using screen = await mount({
      files: [A],
      onSendComments: async () => ({ status: "queued" }),
    });
    await openBox(screen, "deletions", 10, 11, "Why drop this?");

    await userEvent.click(button(screen, "Add to message"));

    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({
      sectionId: SECTION,
      filePath: "a.ts",
      selection: SELECTION_OF(10, "deletions", 11),
    });
    expect(annotatedOf(screen, "deletions")).toEqual(["10", "11"]);
    expect(annotatedOf(screen, "additions")).toEqual([]);
  });

  it("adds the comment with the Comment button where nothing can be sent", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await openBox(screen, "additions", 12, 12, "Only to the message");

    expect(screen.getByRole("button", { name: "Send", exact: true }).elements()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Add to message" }).elements()).toHaveLength(0);
    await userEvent.click(button(screen, "Comment"));

    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({
      sectionId: SECTION,
      text: "Only to the message",
      selection: SELECTION_OF(12, "additions"),
    });
  });

  it("offers Send only with onSendComments", async () => {
    using _drafts = setup();
    await using screen = await mount({
      files: [A],
      onSendComments: async () => ({ status: "dispatched" }),
    });

    await openBox(screen, "additions", 12, 12, null);

    await expect.element(button(screen, "Send")).toBeVisible();
    await expect.element(button(screen, "Add to message")).toBeVisible();
  });

  it("keeps Send and Add to message off until there are words", async () => {
    using _drafts = setup();
    await using screen = await mount({
      files: [A],
      onSendComments: async () => ({ status: "dispatched" }),
    });
    await openBox(screen, "additions", 12, 12, null);

    await expect.element(button(screen, "Send")).toBeDisabled();
    await expect.element(button(screen, "Add to message")).toBeDisabled();
    await userEvent.fill(screen.getByRole("textbox"), "  ");
    await expect.element(button(screen, "Send")).toBeDisabled();
    await userEvent.fill(screen.getByRole("textbox"), "Words");
    await expect.element(button(screen, "Send")).toBeEnabled();
  });

  it("sends exactly the one comment", async () => {
    using _drafts = setup();
    // A comment already in the message does not travel with the box's.
    seed(A, { id: "waiting", side: "additions", start: 30 });
    const onSendComments = vi.fn<SendReviewComments>(async () => ({ status: "dispatched" }));
    await using screen = await mount({ files: [A], onSendComments });
    await openBox(screen, "deletions", 12, 13, "Send this alone");

    await userEvent.click(button(screen, "Send"));

    await vi.waitFor(() => expect(onSendComments).toHaveBeenCalledOnce());
    expect(onSendComments.mock.calls[0]![0]).toEqual([
      expect.objectContaining({
        sectionId: SECTION,
        filePath: "a.ts",
        text: "Send this alone",
        selection: SELECTION_OF(12, "deletions", 13),
      }),
    ]);
  });

  it.each([
    { outcome: { status: "dispatched" }, kept: false },
    { outcome: { status: "queued" }, kept: false },
    { outcome: { status: "refused", reason: "The thread is busy." }, kept: true },
    { outcome: { status: "failed", reason: "No connection." }, kept: true },
  ] as const satisfies ReadonlyArray<{ outcome: ReviewSendOutcome; kept: boolean }>)(
    "when the send is $outcome.status, the comment is kept: $kept",
    async ({ outcome, kept }) => {
      using _drafts = setup();
      const answer = deferred<ReviewSendOutcome>();
      const onSendComments = vi.fn<SendReviewComments>(() => answer.promise);
      await using screen = await mount({ files: [A], onSendComments });
      await openBox(screen, "additions", 12, 12, "On its way");

      await userEvent.click(button(screen, "Send"));
      await vi.waitFor(() => expect(onSendComments).toHaveBeenCalledOnce());
      // The box waits for the answer, with its words, and the draft holds nothing yet.
      await expect.element(screen.getByRole("textbox")).toHaveValue("On its way");
      expect(saved()).toEqual([]);

      answer.resolve(outcome);

      await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
      expect(saved().map((comment) => comment.text)).toEqual(kept ? ["On its way"] : []);
      expect(annotatedOf(screen, "additions")).toEqual(kept ? ["12"] : []);
    },
  );

  it("keeps the comment when the send rejects", async () => {
    using _drafts = setup();
    const onSendComments = vi.fn<SendReviewComments>(() => Promise.reject(new Error("socket")));
    await using screen = await mount({ files: [A], onSendComments });
    await openBox(screen, "additions", 12, 12, "Do not lose me");

    await userEvent.click(button(screen, "Send"));

    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    expect(saved()).toHaveLength(1);
    expect(saved()[0]).toMatchObject({
      text: "Do not lose me",
      selection: SELECTION_OF(12, "additions"),
    });
  });

  it("drops the box on Escape", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await openBox(screen, "additions", 12, 12, "Never mind");

    await userEvent.click(screen.getByRole("textbox"));
    await userEvent.keyboard("{Escape}");

    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    expect(saved()).toEqual([]);
    expect(markersOf(screen)).toEqual([]);
  });

  it("drops the box on Cancel", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await openBox(screen, "deletions", 12, 12, "Never mind");

    await userEvent.click(button(screen, "Cancel"));

    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    expect(saved()).toEqual([]);
    expect(markersOf(screen)).toEqual([]);
  });

  it("adds to the message from the keyboard", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await openBox(screen, "additions", 12, 12, "Keyboard words");

    await userEvent.click(screen.getByRole("textbox"));
    await userEvent.keyboard("{Control>}{Enter}{/Control}");

    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]!.text).toBe("Keyboard words");
  });
});

describe("comments already in the message", () => {
  it("marks the lines of a comment with this section", async () => {
    using _drafts = setup();
    seed(A, { id: "c1", side: "additions", start: 12, end: 13 });
    await using screen = await mount({ files: [A] });

    await showsRows(screen, "additions", 12, 13);

    await vi.waitFor(() => expect(annotatedOf(screen, "additions")).toEqual(["12", "13"]));
    expect(annotatedOf(screen, "deletions")).toEqual([]);
    expect(markersOf(screen)).toEqual(["c1"]);
    expect(lostLinesNotice(screen)).toBeUndefined();
  });

  it("marks an old-side comment on the old pane", async () => {
    using _drafts = setup();
    seed(A, { id: "c1", side: "deletions", start: 10 });
    await using screen = await mount({ files: [A] });

    await vi.waitFor(() => expect(annotatedOf(screen, "deletions")).toEqual(["10"]));
    expect(annotatedOf(screen, "additions")).toEqual([]);
  });

  it("lists the comment in its card, and takes it out of the draft on delete", async () => {
    using _drafts = setup();
    seed(A, { id: "c1", side: "additions", start: 12, text: "First remark" });
    seed(A, { id: "c2", side: "additions", start: 25, text: "Second remark" });
    await using screen = await mount({ files: [A] });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual(["c1", "c2"]));

    await userEvent.click(markerOf(screen, "c1"));
    await vi.waitFor(() => expect(cardText(screen)).toContain("First remark"));
    expect(cardText(screen)).not.toContain("Second remark");
    await userEvent.click(screen.getByRole("button", { name: "Delete comment" }));

    await vi.waitFor(() => expect(markersOf(screen)).toEqual(["c2"]));
    expect(saved().map((comment) => comment.id)).toEqual(["c2"]);
    expect(cardOf(screen)).toBeNull();
  });

  it("shows a comment across both sides on the side it ends on", async () => {
    using _drafts = setup();
    // As the stacked view makes it: from old line 9 to new line 12.
    const comment = seed(A, {
      id: "c1",
      side: "deletions",
      start: 9,
      end: 12,
      endSide: "additions",
    });
    expect(comment.selection).toEqual(SELECTION_OF(9, "deletions", 12, "additions"));
    await using screen = await mount({ files: [A] });

    await vi.waitFor(() => expect(markersOf(screen)).toEqual(["c1"]));
    expect(annotatedOf(screen, "deletions")).toEqual([]);
    expect(annotatedOf(screen, "additions")).toEqual(["9", "10", "11", "12"]);
  });

  it("shows the comments of the same section from another surface, not the rest", async () => {
    using _drafts = setup();
    seed(A, { id: "other-section", side: "additions", start: 12, sectionId: "staged" });
    seed(A, { id: "other-file", side: "additions", start: 14, filePath: "b.ts" });
    seed(A, { id: "not-a-diff", side: "additions", start: 16, fenceLanguage: "ts" });
    seed(A, { id: "mine", side: "additions", start: 18 });
    await using screen = await mount({ files: [A] });

    await vi.waitFor(() => expect(markersOf(screen)).toEqual(["mine"]));
    expect(annotatedOf(screen, "additions")).toEqual(["18"]);
    expect(lostLinesNotice(screen)).toBeUndefined();
    expect(saved()).toHaveLength(4);
  });

  it("does not draw a comment on lines the file no longer has, and says so", async () => {
    using _drafts = setup();
    seed(A, { id: "c1", side: "additions", start: 38, end: 39 });
    seed(A, { id: "c2", side: "additions", start: 12 });
    const shorter = textsOf({ 10: "alpha" }, 30);
    await using screen = await mount({ files: [A] });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual(["c2", "c1"]));
    expect(lostLinesNotice(screen)).toBeUndefined();

    await screen.rerender(
      <Harness
        files={[A]}
        contentsKey="contents-2"
        loadFileContents={loaderOf({ "a.ts": shorter })}
      />,
    );

    await vi.waitFor(() => expect(markersOf(screen)).toEqual(["c2"]));
    const lines = saved().find((comment) => comment.id === "c1")!.rangeLabel;
    expect(lostLinesNotice(screen)).toBe(
      `A comment in the message is on lines this file no longer has: ${lines}`,
    );
    expect(saved().map((comment) => comment.id)).toEqual(expect.arrayContaining(["c1", "c2"]));
  });

  it("counts every comment it cannot draw", async () => {
    using _drafts = setup();
    const first = seed(A, { id: "c1", side: "additions", start: 37 });
    const second = seed(A, { id: "c2", side: "deletions", start: 38 });
    await using screen = await mount({ files: [A] });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual(["c2", "c1"]));

    await screen.rerender(
      <Harness
        files={[A]}
        contentsKey="contents-2"
        loadFileContents={loaderOf({ "a.ts": textsOf({}, 30) })}
      />,
    );

    await vi.waitFor(() => expect(markersOf(screen)).toEqual([]));
    expect(lostLinesNotice(screen)).toBe(
      `2 comments in the message are on lines this file no longer has: ${first.rangeLabel}, ${second.rangeLabel}`,
    );
    expect(saved()).toHaveLength(2);
  });

  it("keeps the notice off other files' comments", async () => {
    using _drafts = setup();
    seed(A, { id: "c1", side: "additions", start: 38, filePath: "other.ts" });
    await using screen = await mount({ files: [A] });

    await showsRows(screen, "additions", 12);

    expect(lostLinesNotice(screen)).toBeUndefined();
    expect(markersOf(screen)).toEqual([]);
  });
});

describe("agent review notes", () => {
  it("marks a note's lines on the new pane and shows it in a card with Reply and Dismiss", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12, 13);
    await using screen = await mount({ files: [A], reviewNotes: notesOf([exact(note)]) });

    await vi.waitFor(() => expect(annotatedOf(screen, "additions")).toEqual(["12", "13"]));
    expect(annotatedOf(screen, "deletions")).toEqual([]);
    expect(markersOf(screen)).toEqual([note.id]);
    await userEvent.click(markerOf(screen, note.id));

    await vi.waitFor(() => expect(cardText(screen)).toContain("Flagged note number 1."));
    await expect.element(screen.getByRole("button", { name: "Reply" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Dismiss" })).toBeVisible();
  });

  it("dismisses a note by its id", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    const onDismiss = vi.fn();
    await using screen = await mount({
      files: [A],
      reviewNotes: notesOf([exact(note)], onDismiss),
    });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([note.id]));
    await userEvent.click(markerOf(screen, note.id));

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(note.id);
  });

  it("badges a note that moved and one that was answered", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    await using screen = await mount({
      files: [A],
      reviewNotes: notesOf([exact(note, "a.ts", "moved")], () => undefined, [note.id]),
    });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([note.id]));

    await userEvent.click(markerOf(screen, note.id));

    await vi.waitFor(() => expect(cardText(screen)).toContain("Moved"));
    expect(cardText(screen)).toContain("Answered");
  });

  it("draws only the notes that are attached, in the shown file", async () => {
    using _drafts = setup();
    const placed: PlacedReviewNote[] = [
      exact(noteOf(1, 12)),
      { note: noteOf(2, 14), fileKey: "a.ts", anchor: { kind: "unattached" } },
      { note: noteOf(3, 16), fileKey: "a.ts", anchor: { kind: "pending" } },
      exact(noteOf(4, 18, 18, "b.ts"), "b.ts"),
    ];
    await using screen = await mount({ files: [A, B], reviewNotes: notesOf(placed) });

    await vi.waitFor(() => expect(markersOf(screen)).toEqual([noteOf(1, 12).id]));
    expect(annotatedOf(screen, "additions")).toEqual(["12"]);
  });

  it("opens a reply box under the note and adds the reply to the message", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    const onSendComments = vi.fn<SendReviewComments>(async () => ({ status: "dispatched" }));
    await using screen = await mount({
      files: [A],
      reviewNotes: notesOf([exact(note)]),
      onSendComments,
    });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([note.id]));
    await userEvent.click(markerOf(screen, note.id));

    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await expect.element(screen.getByRole("textbox")).toBeVisible();
    // The note stays above its reply box, without Reply and Dismiss.
    expect(cardText(screen)).toContain("Flagged note number 1.");
    expect(screen.getByRole("button", { name: "Reply" }).elements()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Dismiss" }).elements()).toHaveLength(0);
    await userEvent.fill(screen.getByRole("textbox"), "Fixed in the next commit.");
    await userEvent.click(button(screen, "Add to message"));

    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({
      sectionId: reviewNoteSectionId(note.id),
      filePath: "a.ts",
      text: "Fixed in the next commit.",
      rangeLabel: "L12",
    });
    expect(onSendComments).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    // The reply sits under the note, and can be taken back.
    expect(cardText(screen)).toContain("Fixed in the next commit.");
    await userEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    await vi.waitFor(() => expect(saved()).toEqual([]));
  });

  it("sends a reply on its own", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    const onSendComments = vi.fn<SendReviewComments>(async () => ({ status: "queued" }));
    await using screen = await mount({
      files: [A],
      reviewNotes: notesOf([exact(note)]),
      onSendComments,
    });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([note.id]));
    await userEvent.click(markerOf(screen, note.id));
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await userEvent.fill(screen.getByRole("textbox"), "On it.");

    await userEvent.click(button(screen, "Send"));

    await vi.waitFor(() => expect(onSendComments).toHaveBeenCalledOnce());
    expect(onSendComments.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ sectionId: reviewNoteSectionId(note.id), text: "On it." }),
    ]);
    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    expect(saved()).toEqual([]);
  });

  it("drops a reply box on Cancel and gives Reply and Dismiss back", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    await using screen = await mount({ files: [A], reviewNotes: notesOf([exact(note)]) });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([note.id]));
    await userEvent.click(markerOf(screen, note.id));
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await userEvent.fill(screen.getByRole("textbox"), "Never mind");

    await userEvent.click(button(screen, "Cancel"));

    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Reply" })).toBeVisible();
    expect(saved()).toEqual([]);
  });

  it("shares one marker between a note and a comment on overlapping lines, the note first", async () => {
    using _drafts = setup();
    const note = noteOf(1, 13, 14);
    seed(A, { id: "c1", side: "additions", start: 12, end: 13, text: "A human remark" });
    await using screen = await mount({ files: [A], reviewNotes: notesOf([exact(note)]) });

    await vi.waitFor(() => expect(annotatedOf(screen, "additions")).toEqual(["12", "13", "14"]));
    expect(markersOf(screen)).toEqual([note.id]);
    await userEvent.click(markerOf(screen, note.id));

    await vi.waitFor(() => expect(cardText(screen)).toContain("A human remark"));
    expect(cardText(screen).indexOf("Flagged note number 1.")).toBeGreaterThanOrEqual(0);
    expect(cardText(screen).indexOf("Flagged note number 1.")).toBeLessThan(
      cardText(screen).indexOf("A human remark"),
    );
  });

  it("keeps a note on the new pane apart from an old-side comment on the same numbers", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    seed(A, { id: "c1", side: "deletions", start: 12 });
    await using screen = await mount({ files: [A], reviewNotes: notesOf([exact(note)]) });

    await vi.waitFor(() => expect(markersOf(screen)).toHaveLength(2));
    expect(annotatedOf(screen, "additions")).toEqual(["12"]);
    expect(annotatedOf(screen, "deletions")).toEqual(["12"]);
  });
});

describe("showing a note that was asked for", () => {
  const LONG_A = textsOf({ 100: "middle" }, 200);

  it("opens the note's card and scrolls its lines into view", async () => {
    using _drafts = setup();
    const note = noteOf(1, 180);
    const onNoteRevealed = vi.fn();
    const onNoteUnplaced = vi.fn();
    await using screen = await mount({
      files: [entryOf("a.ts", LONG_A)],
      loadFileContents: loaderOf({ "a.ts": LONG_A }),
      reviewNotes: notesOf([exact(note)]),
      noteReveal: { noteId: note.id },
      onNoteRevealed,
      onNoteUnplaced,
    });

    await vi.waitFor(() => expect(cardOf(screen)?.dataset.sbsAnnotationCard).toBe(note.id));
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 180)).toBeDefined());
    expect(isVisible(rowByNumber(screen, "additions", 180)!, scrollerOf(screen, "additions"))).toBe(
      true,
    );
    expect(cardText(screen)).toContain("Flagged note number 1.");
    expect(onNoteRevealed).toHaveBeenCalledOnce();
    expect(onNoteUnplaced).not.toHaveBeenCalled();
  });

  it("opens the fold a note asked for is in, with unchanged lines collapsed", async () => {
    using _drafts = setup();
    localStorage.setItem(COLLAPSE_KEY, "true");
    const note = noteOf(1, 180);
    const onNoteRevealed = vi.fn();
    await using screen = await mount({
      files: [entryOf("a.ts", LONG_A)],
      loadFileContents: loaderOf({ "a.ts": LONG_A }),
      reviewNotes: notesOf([exact(note)]),
      noteReveal: { noteId: note.id },
      onNoteRevealed,
    });

    await vi.waitFor(() => expect(cardOf(screen)?.dataset.sbsAnnotationCard).toBe(note.id));
    await vi.waitFor(() => expect(rowByNumber(screen, "additions", 180)).toBeDefined());
    expect(isVisible(rowByNumber(screen, "additions", 180)!, scrollerOf(screen, "additions"))).toBe(
      true,
    );
    expect(markersOf(screen)).toEqual([note.id]);
    expect(onNoteRevealed).toHaveBeenCalledOnce();
  });

  it("calls onNoteRevealed once, even as the panel renders again", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    const onNoteRevealed = vi.fn();
    const props = {
      files: [A],
      reviewNotes: notesOf([exact(note)]),
      noteReveal: { noteId: note.id },
      onNoteRevealed,
    };
    await using screen = await mount(props);
    await vi.waitFor(() => expect(cardOf(screen)?.dataset.sbsAnnotationCard).toBe(note.id));

    await screen.rerender(<Harness {...props} reviewNotes={notesOf([exact(note)])} />);
    await userEvent.click(codeOf(screen, "additions", 16));

    expect(onNoteRevealed).toHaveBeenCalledOnce();
  });

  it("waits for a note whose file is still loading, then opens it", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    const onNoteRevealed = vi.fn();
    const onNoteUnplaced = vi.fn();
    const props = { files: [A], noteReveal: { noteId: note.id }, onNoteRevealed, onNoteUnplaced };
    await using screen = await mount({
      ...props,
      reviewNotes: notesOf([{ note, fileKey: "a.ts", anchor: { kind: "pending" } }]),
    });
    await showsRows(screen, "additions", 12);
    expect(cardOf(screen)).toBeNull();
    expect(onNoteRevealed).not.toHaveBeenCalled();
    expect(onNoteUnplaced).not.toHaveBeenCalled();

    await screen.rerender(<Harness {...props} reviewNotes={notesOf([exact(note)])} />);

    await vi.waitFor(() => expect(cardOf(screen)?.dataset.sbsAnnotationCard).toBe(note.id));
    expect(onNoteRevealed).toHaveBeenCalledOnce();
    expect(onNoteUnplaced).not.toHaveBeenCalled();
  });

  it("calls onNoteUnplaced for a note the panel does not have", async () => {
    using _drafts = setup();
    const onNoteRevealed = vi.fn();
    const onNoteUnplaced = vi.fn();
    await using screen = await mount({
      files: [A],
      reviewNotes: notesOf([exact(noteOf(1, 12))]),
      noteReveal: { noteId: noteOf(9, 12).id },
      onNoteRevealed,
      onNoteUnplaced,
    });

    await vi.waitFor(() => expect(onNoteUnplaced).toHaveBeenCalledOnce());
    expect(onNoteRevealed).not.toHaveBeenCalled();
    expect(cardOf(screen)).toBeNull();
  });

  it("calls onNoteUnplaced for a note with no lines in the diff", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    const onNoteRevealed = vi.fn();
    const onNoteUnplaced = vi.fn();
    await using screen = await mount({
      files: [A],
      reviewNotes: notesOf([{ note, fileKey: "a.ts", anchor: { kind: "unattached" } }]),
      noteReveal: { noteId: note.id },
      onNoteRevealed,
      onNoteUnplaced,
    });

    await vi.waitFor(() => expect(onNoteUnplaced).toHaveBeenCalledOnce());
    expect(onNoteRevealed).not.toHaveBeenCalled();
    expect(cardOf(screen)).toBeNull();
  });

  it("calls onNoteUnplaced for a note on lines the shown file lacks, and other cards still open", async () => {
    using _drafts = setup();
    const lost = noteOf(1, 500);
    const other = noteOf(2, 12);
    const onNoteRevealed = vi.fn();
    const onNoteUnplaced = vi.fn();
    await using screen = await mount({
      files: [A],
      reviewNotes: notesOf([exact(lost), exact(other)]),
      noteReveal: { noteId: lost.id },
      onNoteRevealed,
      onNoteUnplaced,
    });

    await vi.waitFor(() => expect(onNoteUnplaced).toHaveBeenCalledOnce());
    expect(onNoteRevealed).not.toHaveBeenCalled();
    expect(markersOf(screen)).toEqual([other.id]);
    await userEvent.click(markerOf(screen, other.id));
    await vi.waitFor(() => expect(cardOf(screen)?.dataset.sbsAnnotationCard).toBe(other.id));
  });

  it("gives up on a note in another file than the one shown", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12, 12, "b.ts");
    const onNoteRevealed = vi.fn();
    const onNoteUnplaced = vi.fn();
    await using screen = await mount({
      files: [A, B],
      selectedFileKey: "a.ts",
      reviewNotes: notesOf([exact(note, "b.ts")]),
      noteReveal: { noteId: note.id },
      onNoteRevealed,
      onNoteUnplaced,
    });

    await vi.waitFor(() => expect(onNoteRevealed).toHaveBeenCalledOnce());
    expect(onNoteUnplaced).not.toHaveBeenCalled();
    expect(cardOf(screen)).toBeNull();
    expect(markersOf(screen)).toEqual([]);
  });

  it("puts an open box's words in the draft, then opens a note asked for in its file", async () => {
    using _drafts = setup();
    const note = noteOf(1, 30);
    const onNoteRevealed = vi.fn();
    const props = { files: [A], reviewNotes: notesOf([exact(note)]), onNoteRevealed };
    await using screen = await mount(props);
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([note.id]));
    await openBox(screen, "additions", 12, 12, "Typed before the step");

    await screen.rerender(<Harness {...props} noteReveal={{ noteId: note.id }} />);

    await vi.waitFor(() => expect(cardOf(screen)?.dataset.sbsAnnotationCard).toBe(note.id));
    expect(cardText(screen)).toContain("Flagged note number 1.");
    expect(saved()).toHaveLength(1);
    expect(saved()[0]).toMatchObject({
      filePath: "a.ts",
      text: "Typed before the step",
      selection: SELECTION_OF(12, "additions", 12),
    });
    expect(onNoteRevealed).toHaveBeenCalledOnce();
  });

  it("keeps a reply open for its own note, and puts it in the draft for another", async () => {
    using _drafts = setup();
    const first = noteOf(1, 12);
    const second = noteOf(2, 30);
    const onNoteRevealed = vi.fn();
    const props = {
      files: [A],
      reviewNotes: notesOf([exact(first), exact(second)]),
      onNoteRevealed,
    };
    await using screen = await mount(props);
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([first.id, second.id]));
    await userEvent.click(markerOf(screen, first.id));
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await userEvent.fill(screen.getByRole("textbox"), "Half written reply");

    await screen.rerender(<Harness {...props} noteReveal={{ noteId: first.id }} />);
    await vi.waitFor(() => expect(onNoteRevealed).toHaveBeenCalledOnce());
    await expect.element(screen.getByRole("textbox")).toHaveValue("Half written reply");
    expect(saved()).toHaveLength(0);

    await screen.rerender(<Harness {...props} noteReveal={{ noteId: second.id }} />);

    await vi.waitFor(() => expect(cardOf(screen)?.dataset.sbsAnnotationCard).toBe(second.id));
    expect(saved()).toHaveLength(1);
    expect(saved()[0]).toMatchObject({
      sectionId: reviewNoteSectionId(first.id),
      text: "Half written reply",
    });
    expect(onNoteRevealed).toHaveBeenCalledTimes(2);
  });
});

describe("one box at a time", () => {
  it("keeps an open comment box when other lines are picked", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await openBox(screen, "additions", 12, 12, "Half written");

    await pickLines(screen, "additions", 20, 22);
    await pickLines(screen, "deletions", 15);
    await selectText(screen, "additions", { line: 25, column: 6 }, { line: 26, column: 10 });

    await expect.element(screen.getByRole("textbox")).toHaveValue("Half written");
    expect(cardText(screen)).not.toContain("Line");
    expect(markersOf(screen)).toHaveLength(1);
    expect(annotatedOf(screen, "additions")).toEqual(["12"]);
    expect(screen.getByRole("button", { name: "Comment", exact: true }).elements()).toHaveLength(1);
  });

  it("keeps an open comment box when another marker is clicked", async () => {
    using _drafts = setup();
    seed(A, { id: "c1", side: "additions", start: 30, text: "Elsewhere" });
    const note = noteOf(1, 33);
    await using screen = await mount({ files: [A], reviewNotes: notesOf([exact(note)]) });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual(["c1", note.id]));
    await openBox(screen, "additions", 12, 12, "Half written");

    await userEvent.click(markerOf(screen, "c1"));
    await userEvent.click(markerOf(screen, note.id));

    await expect.element(screen.getByRole("textbox")).toHaveValue("Half written");
    expect(cardText(screen)).not.toContain("Elsewhere");
    expect(cardText(screen)).not.toContain("Flagged note number 1.");
  });

  it("keeps an open reply box when lines are picked or another marker is clicked", async () => {
    using _drafts = setup();
    seed(A, { id: "c1", side: "additions", start: 30, text: "Elsewhere" });
    const note = noteOf(1, 12);
    await using screen = await mount({ files: [A], reviewNotes: notesOf([exact(note)]) });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([note.id, "c1"]));
    await userEvent.click(markerOf(screen, note.id));
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await userEvent.fill(screen.getByRole("textbox"), "Half written reply");

    await pickLines(screen, "additions", 20, 22);
    await userEvent.click(markerOf(screen, "c1"));

    await expect.element(screen.getByRole("textbox")).toHaveValue("Half written reply");
    expect(cardText(screen)).toContain("Flagged note number 1.");
    expect(cardText(screen)).not.toContain("Elsewhere");
    expect(cardText(screen)).not.toContain("Lines 20 to 22");
  });

  it("does not let Reply open a second box beside an open comment box", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    await using screen = await mount({ files: [A], reviewNotes: notesOf([exact(note)]) });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([note.id]));
    // The note and the box share lines: one marker, one card, one box.
    await openBox(screen, "additions", 12, 12, "A comment");

    expect(cardText(screen)).toContain("Flagged note number 1.");
    expect(screen.getByRole("textbox").elements()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Reply" }).elements()).toHaveLength(0);
  });

  it("lets the next pick through once the box is closed", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await openBox(screen, "additions", 12, 12, "Half written");
    await userEvent.click(button(screen, "Cancel"));
    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();

    await pickLines(screen, "additions", 20);

    await expectPickCard(screen, "Line 20");
  });
});

describe("words are never lost", () => {
  it("puts a box's words in the draft when another file is shown", async () => {
    using _drafts = setup();
    const props = { files: [A, B] };
    await using screen = await mount({ ...props, selectedFileKey: "a.ts" });
    await openBox(screen, "additions", 12, 13, "Do not lose me");

    await screen.rerender(<Harness {...props} selectedFileKey="b.ts" />);

    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({
      sectionId: SECTION,
      filePath: "a.ts",
      text: "Do not lose me",
      selection: SELECTION_OF(12, "additions", 13),
    });
    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    // The other file shows no marker for it; the first does, on its return.
    expect(markersOf(screen)).toEqual([]);
    await screen.rerender(<Harness {...props} selectedFileKey="a.ts" />);
    await vi.waitFor(() => expect(annotatedOf(screen, "additions")).toEqual(["12", "13"]));
  });

  it("only closes an empty box when another file is shown", async () => {
    using _drafts = setup();
    const props = { files: [A, B] };
    await using screen = await mount({ ...props, selectedFileKey: "a.ts" });
    await openBox(screen, "additions", 12, 12, null);

    await screen.rerender(<Harness {...props} selectedFileKey="b.ts" />);

    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    expect(saved()).toEqual([]);
  });

  it("drops a pick that has not become a box when another file is shown", async () => {
    using _drafts = setup();
    const props = { files: [A, B] };
    await using screen = await mount({ ...props, selectedFileKey: "a.ts" });
    await pickLines(screen, "additions", 12);
    await expectPickCard(screen, "Line 12");

    await screen.rerender(<Harness {...props} selectedFileKey="b.ts" />);
    await screen.rerender(<Harness {...props} selectedFileKey="a.ts" />);

    await showsRows(screen, "additions", 12);
    expect(markersOf(screen)).toEqual([]);
    expect(cardOf(screen)).toBeNull();
    expect(saved()).toEqual([]);
  });

  it("keeps a send in flight from adding its comment twice when the file changes", async () => {
    using _drafts = setup();
    const answer = deferred<ReviewSendOutcome>();
    const onSendComments = vi.fn<SendReviewComments>(() => answer.promise);
    const props = { files: [A, B], onSendComments };
    await using screen = await mount({ ...props, selectedFileKey: "a.ts" });
    await openBox(screen, "additions", 12, 12, "On its way");
    await userEvent.click(button(screen, "Send"));
    await vi.waitFor(() => expect(onSendComments).toHaveBeenCalledOnce());

    await screen.rerender(<Harness {...props} selectedFileKey="b.ts" />);
    expect(saved()).toEqual([]);
    answer.resolve({ status: "dispatched" });

    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    expect(saved()).toEqual([]);
  });

  it("puts a box's words in the draft when the file reloads without its lines", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await openBox(screen, "additions", 38, 39, "Still mine");

    await screen.rerender(
      <Harness
        files={[A]}
        contentsKey="contents-2"
        loadFileContents={loaderOf({ "a.ts": textsOf({ 10: "alpha" }, 30) })}
      />,
    );

    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({
      filePath: "a.ts",
      text: "Still mine",
      selection: SELECTION_OF(38, "additions", 39),
    });
    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    // The comment's lines are gone, so it is listed above the panes instead.
    await vi.waitFor(() => expect(lostLinesNotice(screen)).toBeDefined());
  });

  it("only closes an empty box when the file reloads without its lines", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await openBox(screen, "additions", 38, 39, null);

    await screen.rerender(
      <Harness
        files={[A]}
        contentsKey="contents-2"
        loadFileContents={loaderOf({ "a.ts": textsOf({ 10: "alpha" }, 30) })}
      />,
    );

    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    expect(saved()).toEqual([]);
  });

  it("keeps a box open through a reload that keeps its lines", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await openBox(screen, "additions", 12, 12, "Still writing");

    await screen.rerender(
      <Harness
        files={[A]}
        contentsKey="contents-2"
        loadFileContents={loaderOf({ "a.ts": textsOf({ 10: "alpha", 20: "other" }) })}
      />,
    );

    await expect.element(screen.getByRole("textbox")).toHaveValue("Still writing");
    expect(saved()).toEqual([]);
  });

  it("puts a box's words in the draft when the view goes", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await openBox(screen, "additions", 12, 13, "Typed before the view went");

    await screen.unmount();

    expect(saved()).toHaveLength(1);
    expect(saved()[0]).toMatchObject({
      sectionId: SECTION,
      filePath: "a.ts",
      text: "Typed before the view went",
      selection: SELECTION_OF(12, "additions", 13),
    });
  });

  it("puts a reply's words in the draft when the view goes", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    await using screen = await mount({ files: [A], reviewNotes: notesOf([exact(note)]) });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([note.id]));
    await userEvent.click(markerOf(screen, note.id));
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await userEvent.fill(screen.getByRole("textbox"), "Answer before the view went");

    await screen.unmount();

    expect(saved()).toHaveLength(1);
    expect(saved()[0]).toMatchObject({
      sectionId: reviewNoteSectionId(note.id),
      text: "Answer before the view went",
    });
  });

  it("puts a reply's words in the draft when another file is shown", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    const props = { files: [A, B], reviewNotes: notesOf([exact(note)]) };
    await using screen = await mount({ ...props, selectedFileKey: "a.ts" });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([note.id]));
    await userEvent.click(markerOf(screen, note.id));
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await userEvent.fill(screen.getByRole("textbox"), "My answer");

    await screen.rerender(<Harness {...props} selectedFileKey="b.ts" />);

    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({
      sectionId: reviewNoteSectionId(note.id),
      text: "My answer",
    });
    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
  });

  it("puts a reply's words in the draft when its note loses its lines", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    const files = [A];
    await using screen = await mount({ files, reviewNotes: notesOf([exact(note)]) });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([note.id]));
    await userEvent.click(markerOf(screen, note.id));
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await userEvent.fill(screen.getByRole("textbox"), "Answer for a vanished note");

    await screen.rerender(
      <Harness
        files={files}
        reviewNotes={notesOf([{ note, fileKey: "a.ts", anchor: { kind: "unattached" } }])}
      />,
    );

    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({
      sectionId: reviewNoteSectionId(note.id),
      text: "Answer for a vanished note",
    });
    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
  });

  it("holds an open reply while its note's file reloads", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    const files = [A];
    await using screen = await mount({ files, reviewNotes: notesOf([exact(note)]) });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([note.id]));
    await userEvent.click(markerOf(screen, note.id));
    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await userEvent.fill(screen.getByRole("textbox"), "Waiting for the file");

    await screen.rerender(
      <Harness
        files={files}
        reviewNotes={notesOf([{ note, fileKey: "a.ts", anchor: { kind: "pending" } }])}
      />,
    );
    await screen.rerender(<Harness files={files} reviewNotes={notesOf([exact(note)])} />);

    await expect.element(screen.getByRole("textbox")).toHaveValue("Waiting for the file");
    expect(saved()).toEqual([]);
  });
});

describe("the card is not the panes", () => {
  it("keeps lines picked in the gutter when the card itself is pressed", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await pickLines(screen, "additions", 12, 13);
    await expectPickCard(screen, "Lines 12 to 13");

    await userEvent.click(screen.getByText("Lines 12 to 13"));

    expect(selectedOf(screen, "additions")).toEqual(["12", "13"]);
    expect(markersOf(screen)).toEqual([SELECTION_MARKER]);
    await expect.element(button(screen, "Comment")).toBeVisible();
  });

  it("does not let a mouse release or the Shift key in the card change the pick", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await selectText(screen, "additions", { line: 12, column: 6 }, { line: 12, column: 14 });
    await expectPickCard(screen, "Line 12");
    const label = screen.getByText("Line 12").element();

    window.getSelection()!.selectAllChildren(label);
    label.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    label.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Shift", shiftKey: true, bubbles: true }),
    );

    expect(markersOf(screen)).toEqual([SELECTION_MARKER]);
    await expectPickCard(screen, "Line 12");

    // The same release outside the card sees a selection that is in no pane.
    releaseMouse(screen);
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([]));
  });

  it("makes no pick from typing or selecting in a box", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await openBox(screen, "additions", 12, 12, null);
    const textbox = screen.getByRole("textbox");

    await userEvent.type(textbox, "Hello World, With Capitals");
    const field = textbox.element() as HTMLTextAreaElement;
    field.select();
    field.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    await expect.element(textbox).toHaveValue("Hello World, With Capitals");
    expect(markersOf(screen)).toHaveLength(1);
    expect(annotatedOf(screen, "additions")).toEqual(["12"]);
    expect(cardText(screen)).not.toContain("Line 12");
  });

  it("leaves a copy inside the card to the browser, with lines picked in the gutter", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });
    await pickLines(screen, "additions", 12, 13);
    await expectPickCard(screen, "Lines 12 to 13");
    const label = screen.getByText("Lines 12 to 13").element();
    window.getSelection()!.selectAllChildren(label);

    expect(copyFrom(label)).toEqual({ text: "", prevented: false });
    // The same copy from a pane gives the picked lines.
    expect(copyFrom(scrollerOf(screen, "additions"))).toEqual({
      text: `${base().slice(11, 13).join("\n")}\n`,
      prevented: true,
    });
  });

  it("leaves a copy inside a note's card to the browser", async () => {
    using _drafts = setup();
    const note = noteOf(1, 12);
    await using screen = await mount({ files: [A], reviewNotes: notesOf([exact(note)]) });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([note.id]));
    await userEvent.click(markerOf(screen, note.id));
    await vi.waitFor(() => expect(cardText(screen)).toContain("Flagged note number 1."));
    await pickLines(screen, "additions", 20);
    const noteCard = one(screen.container, `[data-review-note-id="${note.id}"]`);
    // A pick closes the note's card; open it again to copy from it.
    expect(noteCard).toBeNull();
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(markerOf(screen, note.id));
    await vi.waitFor(() => expect(cardText(screen)).toContain("Flagged note number 1."));
    const card = one(screen.container, `[data-review-note-id="${note.id}"]`)!;
    window.getSelection()!.selectAllChildren(card);

    expect(copyFrom(card)).toEqual({ text: "", prevented: false });
  });

  it("still copies only a pane's text when a pane selection is copied", async () => {
    using _drafts = setup();
    const note = noteOf(1, 30);
    seed(A, { id: "c1", side: "additions", start: 25 });
    await using screen = await mount({ files: [A], reviewNotes: notesOf([exact(note)]) });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual(["c1", note.id]));
    await userEvent.click(markerOf(screen, note.id));
    await vi.waitFor(() => expect(cardText(screen)).toContain("Flagged note number 1."));

    await selectText(screen, "additions", { line: 12, column: 6 }, { line: 14, column: 14 });

    const lines = base();
    expect(copyFrom(scrollerOf(screen, "additions"))).toEqual({
      text: [lines[11]!.slice(6), lines[12]!, lines[13]!.slice(0, 14)].join("\n"),
      prevented: true,
    });
  });

  it("copies the old pane's text for a selection there", async () => {
    using _drafts = setup();
    await using screen = await mount({ files: [A] });

    await selectText(screen, "deletions", { line: 10, column: 6 }, { line: 11, column: 14 });

    const lines = base();
    expect(copyFrom(scrollerOf(screen, "deletions"))).toEqual({
      text: [lines[9]!.slice(6), lines[10]!.slice(0, 14)].join("\n"),
      prevented: true,
    });
  });
});

describe("a patch-only view", () => {
  const PATCH = twoHunkEntry();
  const loaderless = { files: [PATCH], loadFileContents: undefined };

  it("picks lines of a hunk by their numbers in the file", async () => {
    using _drafts = setup();
    await using screen = await mount(loaderless);

    await pickLines(screen, "additions", 79, 81);

    await expectPickCard(screen, "Lines 79 to 81");
  });

  it("picks old lines of a hunk", async () => {
    using _drafts = setup();
    await using screen = await mount(loaderless);

    await pickLines(screen, "deletions", 81);

    await expectPickCard(screen, "Old line 81");
  });

  it("selects text in a hunk", async () => {
    using _drafts = setup();
    await using screen = await mount(loaderless);

    await selectText(screen, "additions", { line: 80, column: 6 }, { line: 80, column: 14 });

    await expectPickCard(screen, "Line 80");
  });

  it("adds a comment on hunk lines to the message", async () => {
    using _drafts = setup();
    await using screen = await mount(loaderless);
    await openBox(screen, "additions", 80, 82, "From a hunk");

    await userEvent.click(button(screen, "Comment"));

    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({
      sectionId: SECTION,
      filePath: "patch.ts",
      text: "From a hunk",
      selection: SELECTION_OF(80, "additions", 82),
    });
    expect(annotatedOf(screen, "additions")).toEqual(["80", "81", "82"]);
  });

  it("marks a comment on hunk lines, and a note on them", async () => {
    using _drafts = setup();
    const whole = entryOf("patch.ts", textsOf({ 21: "x" }, 90));
    seed(whole, { id: "c1", side: "additions", start: 19, end: 20 });
    const note = noteOf(1, 82, 82, "patch.ts");
    await using screen = await mount({
      ...loaderless,
      reviewNotes: notesOf([exact(note, "patch.ts")]),
    });

    await showsRows(screen, "additions", 19, 82);

    await vi.waitFor(() => expect(markersOf(screen)).toEqual(["c1", note.id]));
    expect(annotatedOf(screen, "additions")).toEqual(["19", "20", "82"]);
    expect(lostLinesNotice(screen)).toBeUndefined();
  });

  it("does not draw a comment between the hunks, and says so", async () => {
    using _drafts = setup();
    const whole = entryOf("patch.ts", textsOf({ 21: "x" }, 90));
    const between = seed(whole, { id: "c1", side: "additions", start: 50, end: 51 });
    // One line in a hunk and one outside: both ends must be shown.
    const straddling = seed(whole, { id: "c2", side: "additions", start: 23, end: 30 });
    seed(whole, { id: "c3", side: "additions", start: 19 });
    await using screen = await mount(loaderless);
    await showsRows(screen, "additions", 19);

    await vi.waitFor(() => expect(markersOf(screen)).toEqual(["c3"]));
    expect(lostLinesNotice(screen)).toBe(
      `2 comments in the message are on lines outside the changes shown here: ${between.rangeLabel}, ${straddling.rangeLabel}`,
    );
    expect(saved()).toHaveLength(3);
    // The patch notice stays above it.
    expect(noticesOf(screen)[0]).toContain("Only the changed lines are available here.");
  });

  it("puts a note's reply in the draft", async () => {
    using _drafts = setup();
    const note = noteOf(1, 81, 81, "patch.ts");
    await using screen = await mount({
      ...loaderless,
      reviewNotes: notesOf([exact(note, "patch.ts")]),
    });
    await vi.waitFor(() => expect(markersOf(screen)).toEqual([note.id]));
    await userEvent.click(markerOf(screen, note.id));

    await userEvent.click(screen.getByRole("button", { name: "Reply" }));
    await userEvent.fill(screen.getByRole("textbox"), "Hunk reply");
    await userEvent.click(button(screen, "Comment"));

    await vi.waitFor(() => expect(saved()).toHaveLength(1));
    expect(saved()[0]).toMatchObject({
      sectionId: reviewNoteSectionId(note.id),
      filePath: "patch.ts",
      text: "Hunk reply",
    });
  });

  it("reveals a note on a hunk line", async () => {
    using _drafts = setup();
    const note = noteOf(1, 82, 82, "patch.ts");
    const onNoteRevealed = vi.fn();
    await using screen = await mount({
      ...loaderless,
      reviewNotes: notesOf([exact(note, "patch.ts")]),
      noteReveal: { noteId: note.id },
      onNoteRevealed,
    });

    await vi.waitFor(() => expect(cardOf(screen)?.dataset.sbsAnnotationCard).toBe(note.id));
    expect(onNoteRevealed).toHaveBeenCalledOnce();
  });
});
