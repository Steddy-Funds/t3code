import type { CodeViewDiffItem, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { RunId, TurnItemId } from "@t3tools/contracts";
import { type ReviewNote, reviewNoteSectionId } from "@t3tools/shared/reviewNote";
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

describe("review note replies", () => {
  it("keeps the words of an open reply in the message when its note leaves its lines", async () => {
    using _drafts = setup();
    const shown = file("shared.ts");
    const note: ReviewNote = {
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
    const notes = (anchor: DiffReviewNotes["placed"][number]["anchor"]): DiffReviewNotes => ({
      placed: [{ note, fileKey: shown.fileKey, anchor }],
      answeredIds: new Set(),
      onDismiss: () => {},
    });
    await using screen = await render(
      view([shown], "initial", [], undefined, notes({ kind: "exact", startLine: 1, endLine: 1 })),
      { container },
    );
    await click("Reply");
    await typeComment("Only search should retry.");

    await screen.rerender(view([shown], "initial", [], undefined, notes({ kind: "unattached" })));

    expect(container.querySelector("textarea")).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments).toEqual([
      expect.objectContaining({
        sectionId: reviewNoteSectionId(note.id),
        text: "Only search should retry.",
      }),
    ]);
  });
});
