import type { CodeViewDiffItem, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { RunId, TurnItemId } from "@t3tools/contracts";
import {
  type ReviewCommentThread,
  type ReviewNote,
  reviewNoteSectionId,
  reviewThreadSectionId,
} from "@t3tools/shared/reviewNote";
import { StrictMode, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileDiffIdentityKey } from "~/lib/diffRendering";

type ViewerProps = Omit<ComponentProps<typeof StyledDiffCodeView<unknown>>, "options"> & {
  options: {
    enableLineSelection: boolean;
    enableGutterUtility: boolean;
    onGutterUtilityClick: (
      range: SelectedLineRange,
      context: { item: CodeViewDiffItem<unknown> },
    ) => void;
  };
};

// Replace only the virtualized viewer; comment editing and submission use the real components.
vi.mock("./StyledDiffCodeView", () => ({
  StyledDiffCodeView: (props: ViewerProps) =>
    props.items
      ?.filter((item) => item.type === "diff")
      .map((item) => (
        <section key={item.id}>
          <button
            disabled={!props.options?.enableLineSelection || !props.options?.enableGutterUtility}
            onClick={() => {
              props.onSelectedLinesChange?.({ id: item.id, range });
              props.options?.onGutterUtilityClick?.(range, { item });
            }}
          >
            Comment on {item.fileDiff.name}
          </button>
          <code>{item.fileDiff.additionLines.join("")}</code>
          {props.selectedLines?.id === item.id ? (
            <mark>Line {props.selectedLines.range.start}</mark>
          ) : null}
          {item.annotations?.map((annotation) => (
            <div key={`${annotation.side}:${annotation.lineNumber}`}>
              {props.renderAnnotation?.(annotation, item.fileDiff, item)}
            </div>
          ))}
        </section>
      )),
}));

import { AnnotatableCodeView, type DiffReviewNotes } from "./AnnotatableCodeView";
import type { StyledDiffCodeView } from "./StyledDiffCodeView";
import type { SendReviewComments } from "./useReviewCommentDrafts";

const target = DraftId.make("diff-draft-test");
const range: SelectedLineRange = { start: 1, end: 1, side: "additions" };
let container: HTMLDivElement;

function file(
  name: string,
  fileVersion = 1,
  type: FileDiffMetadata["type"] = "change",
  prevName?: string,
  added = "new",
) {
  const fileDiff = parsePatchFiles(
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-old\n+${added}\n`,
    { cacheKeyPrefix: name },
  )[0]!.files[0]!;
  fileDiff.type = type;
  if (prevName) fileDiff.prevName = prevName;
  return {
    fileDiff,
    filePath: name,
    fileKey: buildFileDiffIdentityKey(fileDiff),
    fileVersion,
    collapsed: false,
  };
}

function view(
  files: ReturnType<typeof file>[],
  codeViewKey = "initial",
  pendingFiles: FileDiffMetadata[] = [],
  onSendComments?: SendReviewComments,
  reviewNotes?: DiffReviewNotes,
) {
  return (
    <StrictMode>
      <AnnotatableCodeView
        codeViewKey={codeViewKey}
        files={files}
        pendingFiles={pendingFiles}
        sectionId="unstaged"
        sectionTitle="Uncommitted"
        composerDraftTarget={target}
        onSendComments={onSendComments}
        reviewNotes={reviewNotes}
        options={{}}
        renderHeaderFilenameSuffix={() => null}
        renderHeaderPrefix={() => null}
        onRevealSearchMatch={() => {}}
      />
    </StrictMode>
  );
}

function click(label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent === label || node.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  return act(() => button.click());
}

function editor() {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("Comment editor is not available");
  return textarea;
}

function typeComment(text: string) {
  return act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      editor(),
      text,
    );
    editor().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setup(): Disposable {
  const reset = () => useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  reset();
  container = document.createElement("div");
  return { [Symbol.dispose]: reset };
}

describe("diff comment drafts", () => {
  it("keeps the text and selected line through refresh and a provisional lazy patch", async () => {
    using _drafts = setup();
    const original = file("shared.ts", 1, "rename-pure", "old.ts");
    await using screen = await render(view([original]), { container });
    await click("Comment on shared.ts");
    await typeComment("Keep this draft");
    const refreshed = file("shared.ts", 2, "rename-pure", "old.ts");
    await screen.rerender(view([refreshed], "refreshed"));
    expect(editor().value).toBe("Keep this draft");
    expect(container.querySelector("mark")?.textContent).toBe("Line 1");

    await screen.rerender(
      view([], "loading", [
        { ...refreshed.fileDiff, type: "rename-changed", hunks: [], cacheKey: "shared:pending" },
      ]),
    );
    expect(container.querySelector("textarea")).toBeNull();
    await screen.rerender(view([refreshed], "loaded"));
    expect(editor().value).toBe("Keep this draft");
    expect(container.querySelector("mark")?.textContent).toBe("Line 1");
    await click("Comment");
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments).toEqual([
      expect.objectContaining({
        filePath: "shared.ts",
        text: "Keep this draft",
        selection: { ...range, endSide: "additions" },
      }),
    ]);
    expect(container.querySelector("p")?.textContent).toBe("Keep this draft");
  });

  it("offers Send beside Add to message once the thread can take a comment", async () => {
    using _drafts = setup();
    const onSend = vi.fn<SendReviewComments>(async () => ({ status: "dispatched" }));
    await using _screen = await render(view([file("shared.ts")], "initial", [], onSend), {
      container,
    });

    await click("Comment on shared.ts");
    await typeComment("For the message");
    await click("Add to message");
    await click("Comment on shared.ts");
    await typeComment("For the agent, now");
    await click("Send");

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith([
      expect.objectContaining({ filePath: "shared.ts", text: "For the agent, now" }),
    ]);
    expect(
      useComposerDraftStore
        .getState()
        .getComposerDraft(target)
        ?.reviewComments.map((comment) => comment.text),
    ).toEqual(["For the message"]);
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("quotes the words selected in the commented line at the top of the comment", async () => {
    using _drafts = setup();
    await using _screen = await render(
      view([file("shared.ts", 1, "change", undefined, "const value = foo(bar);")]),
      { container },
    );
    const code = container.querySelector("code")!.firstChild!;
    const words = document.createRange();
    words.setStart(code, "const value = ".length);
    words.setEnd(code, "const value = foo(bar)".length);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(words);
    // The press that opens the box is also what clears the selection in a real viewer.
    await act(() =>
      container
        .querySelector("button")!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })),
    );
    selection.removeAllRanges();

    await click("Comment on shared.ts");
    await typeComment("Should this be baz?");
    await click("Comment");

    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments[0]?.text).toBe(
      "> foo(bar)\n\nShould this be baz?",
    );
  });
});

const reviewNote: ReviewNote = {
  id: TurnItemId.make("turn-item:review-note:thread-1:0123456789abcdef0123456789abcdef"),
  kind: "review_note",
  path: "shared.ts",
  startLine: 1,
  endLine: 1,
  note: "Shared by every caller.",
  excerpt: "new",
  excerptTruncated: false,
  contentRevision: "3b18e512dba79e4c8300dd08aeb37f8e728b8dad",
  runId: RunId.make("run-1"),
};

const notesOn = (
  shown: ReturnType<typeof file>,
  anchor: DiffReviewNotes["placed"][number]["anchor"] = { kind: "exact", startLine: 1, endLine: 1 },
): DiffReviewNotes => ({
  placed: [{ note: reviewNote, fileKey: shown.fileKey, anchor }],
  answeredIds: new Set(),
  conversations: new Map(),
  onDismiss: () => {},
});

const savedComments = () =>
  useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments;
const gutterButton = () =>
  Array.from(container.querySelectorAll("button")).find((node) =>
    node.textContent?.startsWith("Comment on "),
  );
const replyButton = () => container.querySelector('button[aria-label="Reply"]');

describe("review note replies", () => {
  it("keeps an open reply while its file reloads, and its words when its note leaves", async () => {
    using _drafts = setup();
    const shown = file("shared.ts");
    const note = reviewNote;
    const notes = (anchor: DiffReviewNotes["placed"][number]["anchor"]) => notesOn(shown, anchor);
    await using screen = await render(
      view([shown], "initial", [], undefined, notes({ kind: "exact", startLine: 1, endLine: 1 })),
      { container },
    );
    await click("Reply");
    await typeComment("Only search should retry.");

    await screen.rerender(view([shown], "initial", [], undefined, notes({ kind: "pending" })));
    await screen.rerender(
      view([shown], "initial", [], undefined, notes({ kind: "exact", startLine: 1, endLine: 1 })),
    );
    await expect.element(screen.getByRole("textbox")).toHaveValue("Only search should retry.");
    expect(savedComments()).toBeUndefined();

    await screen.rerender(view([shown], "initial", [], undefined, notes({ kind: "unattached" })));

    expect(container.querySelector("textarea")).toBeNull();
    expect(savedComments()).toEqual([
      expect.objectContaining({
        sectionId: reviewNoteSectionId(note.id),
        text: "Only search should retry.",
      }),
    ]);
  });

  it("shows a sent comment's thread on its lines, and a reply follows up that thread", async () => {
    using _drafts = setup();
    const shown = file("shared.ts");
    const thread: ReviewCommentThread = {
      kind: "review_comment_thread",
      id: "ctx_root",
      sectionId: reviewThreadSectionId("ctx_root"),
      path: "shared.ts",
      pathBase: "diff",
      startLine: 1,
      endLine: 1,
      excerpt: "new",
      excerptTruncated: false,
      contentRevision: null,
      comment: "Why is this shared?",
      rangeLabel: "L1",
    };
    const notes = (anchor: DiffReviewNotes["placed"][number]["anchor"]): DiffReviewNotes => ({
      ...notesOn(shown, anchor),
      placed: [{ note: thread, fileKey: shown.fileKey, anchor }],
      conversations: new Map([
        [
          thread.id,
          [
            {
              kind: "reply",
              id: TurnItemId.make("turn-item:review-reply:thread-1:abc"),
              text: "Every caller needs it.",
            },
          ],
        ],
      ]),
    });
    await using screen = await render(
      view([shown], "initial", [], undefined, notes({ kind: "exact", startLine: 1, endLine: 1 })),
      { container },
    );
    await expect.element(screen.getByText("Why is this shared?")).toBeVisible();
    await expect.element(screen.getByText("Every caller needs it.")).toBeVisible();
    expect(container.querySelector('[data-review-entry="reply"]')?.textContent).toContain(
      "Every caller needs it.",
    );

    await click("Reply");
    await typeComment("Then say so in the doc comment.");
    await screen.rerender(view([shown], "initial", [], undefined, notes({ kind: "unattached" })));
    expect(savedComments()).toEqual([
      expect.objectContaining({
        sectionId: reviewThreadSectionId("ctx_root"),
        text: "Then say so in the doc comment.",
      }),
    ]);
  });

  it("closes an empty reply whose note left, saving nothing", async () => {
    using _drafts = setup();
    const shown = file("shared.ts");
    await using screen = await render(view([shown], "initial", [], undefined, notesOn(shown)), {
      container,
    });
    await click("Reply");
    expect(editor().value).toBe("");

    await screen.rerender(
      view([shown], "initial", [], undefined, notesOn(shown, { kind: "unattached" })),
    );

    expect(container.querySelector("textarea")).toBeNull();
    expect(savedComments()).toBeUndefined();
  });
});

describe("one box at a time", () => {
  it("shuts the gutter and the note's Reply while a comment box is open, and keeps the box", async () => {
    using _drafts = setup();
    const shown = file("shared.ts");
    const notes = notesOn(shown);
    await using screen = await render(view([shown], "initial", [], undefined, notes), {
      container,
    });
    expect(gutterButton()?.disabled).toBe(false);
    expect(replyButton()).not.toBeNull();

    await click("Comment on shared.ts");
    await typeComment("First thought");

    expect(gutterButton()?.disabled).toBe(true);
    expect(replyButton()).toBeNull();
    await screen.rerender(view([shown], "initial", [], undefined, notes));
    expect(editor().value).toBe("First thought");

    await click("Cancel");

    expect(container.querySelector("textarea")).toBeNull();
    expect(gutterButton()?.disabled).toBe(false);
    expect(replyButton()).not.toBeNull();
  });

  it("shuts the gutter and every Reply while a reply box is open, until it is saved", async () => {
    using _drafts = setup();
    const shown = file("shared.ts");
    const notes = notesOn(shown);
    await using screen = await render(view([shown], "initial", [], undefined, notes), {
      container,
    });

    await click("Reply");
    await typeComment("Answering");

    expect(gutterButton()?.disabled).toBe(true);
    expect(replyButton()).toBeNull();
    await screen.rerender(view([shown], "initial", [], undefined, notes));
    expect(editor().value).toBe("Answering");

    await click("Comment");

    expect(container.querySelector("textarea")).toBeNull();
    expect(gutterButton()?.disabled).toBe(false);
    expect(savedComments()).toEqual([
      expect.objectContaining({ sectionId: reviewNoteSectionId(reviewNote.id), text: "Answering" }),
    ]);
  });
});

describe("a box open when the view goes", () => {
  it("hands a comment box's words to the message", async () => {
    using _drafts = setup();
    const screen = await render(view([file("shared.ts")]), { container });
    await using _screen = screen;
    await click("Comment on shared.ts");
    await typeComment("Left half done");
    expect(savedComments()).toBeUndefined();

    await screen.unmount();

    expect(savedComments()).toEqual([
      expect.objectContaining({ filePath: "shared.ts", text: "Left half done" }),
    ]);
  });

  it("hands a reply box's words to the message under its note", async () => {
    using _drafts = setup();
    const shown = file("shared.ts");
    const screen = await render(view([shown], "initial", [], undefined, notesOn(shown)), {
      container,
    });
    await using _screen = screen;
    await click("Reply");
    await typeComment("Left half done");

    await screen.unmount();

    expect(savedComments()).toEqual([
      expect.objectContaining({
        sectionId: reviewNoteSectionId(reviewNote.id),
        text: "Left half done",
      }),
    ]);
  });

  it("just closes empty boxes", async () => {
    using _drafts = setup();
    const shown = file("shared.ts");
    const screen = await render(view([shown], "initial", [], undefined, notesOn(shown)), {
      container,
    });
    await using _screen = screen;
    await click("Comment on shared.ts");
    await typeComment("   ");

    await screen.unmount();

    expect(savedComments()).toBeUndefined();
  });

  it("leaves a box that is sending to its send", async () => {
    using _drafts = setup();
    let settle!: (outcome: Awaited<ReturnType<SendReviewComments>>) => void;
    const onSend = vi.fn<SendReviewComments>(
      () => new Promise((resolve) => void (settle = resolve)),
    );
    const screen = await render(view([file("shared.ts")], "initial", [], onSend), { container });
    await using _screen = screen;
    await click("Comment on shared.ts");
    await typeComment("On its way");
    await click("Send");
    expect(onSend).toHaveBeenCalledOnce();

    await screen.unmount();
    // Neither saved nor lost: the send decides.
    expect(savedComments()).toBeUndefined();

    await act(() => settle({ status: "failed", reason: "Offline" }));
    expect(savedComments()).toEqual([expect.objectContaining({ text: "On its way" })]);
  });
});
