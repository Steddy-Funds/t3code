import { memo, useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import { act, fakeTimers, render } from "../../../test/render";
import { SidebarSwipeMention } from "../sidebar/SidebarSwipeMention";
import { SWIPE_REPLY_RELEASE_IDLE_MS } from "./messageSwipeReply.logic";
import {
  THREAD_CONTEXT_DROP_EVENT,
  threadContextDropTargetProps,
  useThreadContextDrop,
} from "./threadContextDrag";

const ENVIRONMENT_ID = "environment-local" as EnvironmentId;

// ChatComposer is memoized and reused across thread navigation; each render's
// drop callback must write into the draft of the thread it last rendered.
const ComposerDropTarget = memo(function ComposerDropTarget({
  draftKey,
  drafts,
}: {
  draftKey: string;
  drafts: Map<string, Array<ThreadId>>;
}) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  useThreadContextDrop(targetRef, ENVIRONMENT_ID, draftKey, (refs, isActive) => {
    if (!isActive()) return;
    drafts.get(draftKey)?.push(...refs.map((ref) => ref.threadId));
  });
  return <div data-drop-target ref={targetRef} />;
});

// Keep the key stable to isolate effect-event updates; React 19.2 retained initial props.
const StableKeyDropTarget = memo(function StableKeyDropTarget({
  received,
}: {
  received: Array<ThreadId>;
}) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  useThreadContextDrop(targetRef, ENVIRONMENT_ID, "thread-a", (refs) => {
    received.push(...refs.map((ref) => ref.threadId));
  });
  return <div data-drop-target ref={targetRef} />;
});

describe("useThreadContextDrop", () => {
  it("drops into the last rendered thread's draft when the memoized target is reused", async () => {
    const drafts = new Map<string, Array<ThreadId>>([
      ["thread-a", []],
      ["thread-b", []],
    ]);

    await using screen = await render(<ComposerDropTarget draftKey="thread-a" drafts={drafts} />);
    await screen.rerender(<ComposerDropTarget draftKey="thread-b" drafts={drafts} />);

    const dropped: ScopedThreadRef = {
      environmentId: ENVIRONMENT_ID,
      threadId: "thread-dropped" as ThreadId,
    };
    const target = screen.container.querySelector("[data-drop-target]");
    expect(target).not.toBeNull();
    await act(() => {
      target!.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: [dropped] }));
    });

    expect(drafts.get("thread-b")).toEqual(["thread-dropped"]);
    expect(drafts.get("thread-a")).toEqual([]);
  });

  it("reads the latest props in a memoized target whose listener stays attached", async () => {
    const first: Array<ThreadId> = [];
    const latest: Array<ThreadId> = [];

    await using screen = await render(<StableKeyDropTarget received={first} />);
    await screen.rerender(<StableKeyDropTarget received={latest} />);

    const target = screen.container.querySelector("[data-drop-target]");
    expect(target).not.toBeNull();
    await act(() => {
      target!.dispatchEvent(
        new CustomEvent(THREAD_CONTEXT_DROP_EVENT, {
          detail: [{ environmentId: ENVIRONMENT_ID, threadId: "thread-dropped" as ThreadId }],
        }),
      );
    });

    expect(latest).toEqual(["thread-dropped"]);
    expect(first).toEqual([]);
  });
});

const SWIPED_KEY = scopedThreadKey({
  environmentId: ENVIRONMENT_ID,
  threadId: "thread-swiped" as ThreadId,
});

function SwipeMentionFixture({ received }: { received: Array<ThreadId> }) {
  const [list, setList] = useState<HTMLUListElement | null>(null);
  const targetRef = useRef<HTMLDivElement | null>(null);
  useThreadContextDrop(targetRef, ENVIRONMENT_ID, "thread-a", (refs) => {
    received.push(...refs.map((ref) => ref.threadId));
  });
  return (
    <>
      <div ref={targetRef} {...threadContextDropTargetProps()} />
      <ul ref={setList} style={{ width: 240 }}>
        <li data-thread-item={SWIPED_KEY}>
          <div data-sidebar-row={SWIPED_KEY}>Swiped thread</div>
        </li>
      </ul>
      <SidebarSwipeMention list={list} />
    </>
  );
}

describe("SidebarSwipeMention", () => {
  it.each([
    ["Cmd swiping a thread past the threshold mentions it", "MacIntel", true, 8, true, true],
    ["a short Cmd swipe leaves the composer alone", "MacIntel", true, 3, true, false],
    ["a plain swipe leaves the composer alone", "MacIntel", false, 8, false, false],
    ["Cmd swiping off macOS leaves the composer alone", "Linux x86_64", true, 8, false, false],
  ] as const)("%s", async (_name, platform, metaKey, steps, tracks, mentions) => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const received: Array<ThreadId> = [];
    await using screen = await render(<SwipeMentionFixture received={received} />);
    const row = screen.container.querySelector<HTMLElement>("[data-sidebar-row]")!;
    using _timers = fakeTimers();

    await act(() => {
      for (let step = 0; step < steps; step += 1) {
        row.dispatchEvent(new WheelEvent("wheel", { deltaX: -10, bubbles: true, metaKey }));
      }
    });
    const indicator = document.querySelector<HTMLElement>(".swipe-reply-indicator");
    expect(indicator?.hidden === false).toBe(tracks);
    expect(indicator?.dataset.armed).toBe(String(mentions));
    if (tracks) {
      expect(indicator!.querySelector(".lucide-quote")).not.toBeNull();
      expect(indicator!.querySelector(".lucide-reply")).toBeNull();
    }
    // The fingers lift when the wheel events stop.
    await act(() => vi.advanceTimersByTime(SWIPE_REPLY_RELEASE_IDLE_MS));

    expect(received).toEqual(mentions ? ["thread-swiped"] : []);
  });
});
