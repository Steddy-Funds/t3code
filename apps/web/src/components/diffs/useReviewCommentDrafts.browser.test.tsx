import { useImperativeHandle, type RefObject } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileReviewComment, type ReviewCommentContext } from "~/reviewCommentContext";

import type { ReviewSendOutcome } from "../chat/composerSend.logic";
import {
  type ReviewCommentDrafts,
  type SendReviewComments,
  useReviewCommentDrafts,
} from "./useReviewCommentDrafts";

interface Lines {
  readonly startLine: number;
  readonly endLine: number;
}
type Drafts = ReviewCommentDrafts<Lines>;

const target = DraftId.make("review-drafts-test");
const contents = "one\ntwo\nthree\n";
const stored = () =>
  useComposerDraftStore.getState().getComposerDraft(target)?.reviewComments ?? [];

/** A surface whose comments all belong to one section, as a diff, a file or a note reply does. */
function Surface(props: {
  sectionId: string;
  hookRef: RefObject<Drafts | null>;
  onSend?: SendReviewComments;
  buildComment?: (comment: ReviewCommentContext) => ReviewCommentContext | null;
}) {
  const drafts = useReviewCommentDrafts<Lines>({
    composerDraftTarget: target,
    onSend: props.onSend,
    buildComment: ({ id, range, text }) => {
      const comment = {
        ...buildFileReviewComment({ id, filePath: "notes.md", ...range, text, contents }),
        sectionId: props.sectionId,
      };
      return props.buildComment ? props.buildComment(comment) : comment;
    },
    ownsComment: (comment) => comment.sectionId === props.sectionId,
  });
  useImperativeHandle(props.hookRef, () => drafts);
  return null;
}

function setup(): Disposable & { hook: () => RefObject<Drafts | null> } {
  const reset = () => useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  reset();
  return { hook: () => ({ current: null }), [Symbol.dispose]: reset };
}

function live(hook: RefObject<Drafts | null>): Drafts {
  if (!hook.current) throw new Error("hook did not render");
  return hook.current;
}

const texts = (hook: RefObject<Drafts | null>) =>
  live(hook).annotations.map((annotation) =>
    annotation.kind === "comment" ? annotation.comment.text : `draft:${annotation.text}`,
  );

describe("useReviewCommentDrafts", () => {
  it("shows a stored comment only on the surface that owns it", async () => {
    using drafts = setup();
    const diff = drafts.hook();
    const note = drafts.hook();
    await using _screen = await render(
      <>
        <Surface sectionId="unstaged" hookRef={diff} />
        <Surface sectionId="review-note:x" hookRef={note} />
      </>,
    );

    await act(() => live(note).beginComment({ startLine: 1, endLine: 1 }));
    await act(() => live(note).addToMessage("Yes, keep the old default."));
    await act(() => live(diff).beginComment({ startLine: 2, endLine: 3 }));
    await act(() => live(diff).addToMessage("Rename this."));

    expect(stored().map((comment) => comment.sectionId)).toEqual(["review-note:x", "unstaged"]);
    expect(texts(note)).toEqual(["Yes, keep the old default."]);
    expect(texts(diff)).toEqual(["Rename this."]);

    // Removing it on one surface takes it out of the message for every surface.
    await act(() => live(diff).removeComment(stored()[1]!.id));
    expect(texts(diff)).toEqual([]);
    expect(texts(note)).toEqual(["Yes, keep the old default."]);
  });

  it.each([
    { outcome: { status: "dispatched" }, kept: false },
    { outcome: { status: "queued" }, kept: false },
    { outcome: { status: "refused", reason: "Answer the agent's question first." }, kept: true },
    { outcome: { status: "failed", reason: "Server said no" }, kept: true },
  ] satisfies ReadonlyArray<{ outcome: ReviewSendOutcome; kept: boolean }>)(
    "a send that was $outcome.status keeps the comment in the message: $kept",
    async ({ outcome, kept }) => {
      using drafts = setup();
      const hook = drafts.hook();
      const onSend = vi.fn<SendReviewComments>(async () => outcome);
      await using _screen = await render(
        <Surface sectionId="unstaged" hookRef={hook} onSend={onSend} />,
      );
      await act(() => live(hook).beginComment({ startLine: 1, endLine: 1 }));

      await expect(act(() => live(hook).sendNow?.("Why one?"))).resolves.toEqual(outcome);

      expect(onSend).toHaveBeenCalledWith([expect.objectContaining({ text: "Why one?" })]);
      expect(stored().map((comment) => comment.text)).toEqual(kept ? ["Why one?"] : []);
      // Either way the box is closed: the comment is on its way, or back among the saved ones.
      expect(texts(hook)).toEqual(kept ? ["Why one?"] : []);
    },
  );

  it("keeps a comment whose send was refused after its surface went away", async () => {
    using drafts = setup();
    const hook = drafts.hook();
    let refuse!: (outcome: ReviewSendOutcome) => void;
    const onSend: SendReviewComments = () =>
      new Promise((resolve) => {
        refuse = resolve;
      });
    await using screen = await render(
      <Surface sectionId="unstaged" hookRef={hook} onSend={onSend} />,
    );
    await act(() => live(hook).beginComment({ startLine: 1, endLine: 1 }));
    let sending!: Promise<ReviewSendOutcome> | undefined;
    await act(() => {
      sending = live(hook).sendNow?.("Still wanted");
    });
    expect(texts(hook)).toEqual(["draft:"]);
    expect(live(hook).annotations[0]).toMatchObject({ kind: "draft", sending: true });

    await screen.unmount();
    refuse({ status: "refused", reason: "Another message is still being sent." });
    await sending;

    expect(stored().map((comment) => comment.text)).toEqual(["Still wanted"]);
  });

  it("keeps the box and its words when the lines can no longer be commented", async () => {
    using drafts = setup();
    const hook = drafts.hook();
    const linesGone = { current: false };
    const onSend = vi.fn<SendReviewComments>(async () => ({ status: "dispatched" }));
    await using _screen = await render(
      <Surface
        sectionId="unstaged"
        hookRef={hook}
        onSend={onSend}
        buildComment={(comment) => (linesGone.current ? null : comment)}
      />,
    );
    await act(() => live(hook).beginComment({ startLine: 1, endLine: 1 }));
    await act(() => live(hook).setDraftText("Half written"));
    linesGone.current = true;

    await act(() => live(hook).addToMessage("Half written"));
    await expect(act(() => live(hook).sendNow?.("Half written"))).resolves.toMatchObject({
      status: "refused",
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
    expect(texts(hook)).toEqual(["draft:Half written"]);
  });
});
