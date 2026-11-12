import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  type CodeHistory,
  type CodeHistoryEntry,
  EMPTY_CODE_HISTORY,
  stepCodeHistory,
  useCodeNavigationStore,
} from "./codeNavigationStore";

const entry = (path: string, line = 0, character = 0): CodeHistoryEntry => ({
  path,
  position: { line, character },
});

const range = (line: number) => ({
  start: { line, character: 0 },
  end: { line, character: 3 },
});

const threadA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const threadB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

function freshStore() {
  useCodeNavigationStore.setState({
    historyByThreadKey: {},
    revealByThreadKey: {},
    lastJump: null,
  });
  return useCodeNavigationStore.getState();
}

describe("recordOrigin", () => {
  it("appends the origin to back and clears forward", () => {
    const store = freshStore();
    store.setHistory("a", { back: [entry("one.ts")], forward: [entry("fwd.ts")] });

    store.recordOrigin("a", entry("two.ts", 4, 2));

    expect(useCodeNavigationStore.getState().historyByThreadKey["a"]).toEqual({
      back: [entry("one.ts"), entry("two.ts", 4, 2)],
      forward: [],
    });
  });

  it("starts a thread's history from empty", () => {
    const store = freshStore();
    store.recordOrigin("a", entry("one.ts"));
    expect(useCodeNavigationStore.getState().historyByThreadKey["a"]).toEqual({
      back: [entry("one.ts")],
      forward: [],
    });
  });

  it("does not push the same origin twice in a row", () => {
    const store = freshStore();
    store.recordOrigin("a", entry("one.ts", 1, 2));
    store.recordOrigin("a", entry("one.ts", 1, 2));
    expect(useCodeNavigationStore.getState().historyByThreadKey["a"]?.back).toHaveLength(1);
  });

  it("still clears forward when the origin repeats the top of back", () => {
    const store = freshStore();
    store.setHistory("a", { back: [entry("one.ts")], forward: [entry("fwd.ts")] });
    store.recordOrigin("a", entry("one.ts"));
    expect(useCodeNavigationStore.getState().historyByThreadKey["a"]).toEqual({
      back: [entry("one.ts")],
      forward: [],
    });
  });

  it.each([
    ["path", entry("other.ts", 1, 2)],
    ["line", entry("one.ts", 2, 2)],
    ["character", entry("one.ts", 1, 3)],
  ])("pushes an origin that differs from the top of back by %s", (_field, origin) => {
    const store = freshStore();
    store.recordOrigin("a", entry("one.ts", 1, 2));
    store.recordOrigin("a", origin);
    expect(useCodeNavigationStore.getState().historyByThreadKey["a"]?.back).toHaveLength(2);
  });

  it("only compares against the top: an older equal entry is pushed again", () => {
    const store = freshStore();
    store.recordOrigin("a", entry("one.ts"));
    store.recordOrigin("a", entry("two.ts"));
    store.recordOrigin("a", entry("one.ts"));
    expect(
      useCodeNavigationStore.getState().historyByThreadKey["a"]?.back.map((item) => item.path),
    ).toEqual(["one.ts", "two.ts", "one.ts"]);
  });

  it("keeps the newest 100 entries and drops the oldest", () => {
    const store = freshStore();
    for (let line = 0; line < 105; line += 1) store.recordOrigin("a", entry("one.ts", line));

    const back = useCodeNavigationStore.getState().historyByThreadKey["a"]!.back;
    expect(back).toHaveLength(100);
    expect(back[0]?.position.line).toBe(5);
    expect(back.at(-1)?.position.line).toBe(104);
  });

  it("keeps histories per thread", () => {
    const store = freshStore();
    store.recordOrigin("a", entry("a.ts"));
    store.recordOrigin("b", entry("b.ts"));

    const { historyByThreadKey } = useCodeNavigationStore.getState();
    expect(historyByThreadKey["a"]?.back).toEqual([entry("a.ts")]);
    expect(historyByThreadKey["b"]?.back).toEqual([entry("b.ts")]);
    expect(historyByThreadKey["c"]).toBeUndefined();
  });
});

describe("stepCodeHistory", () => {
  it("steps back: the top of back is the target and the current location goes to forward", () => {
    const history: CodeHistory = { back: [entry("one.ts"), entry("two.ts")], forward: [] };

    const step = stepCodeHistory(history, "back", entry("here.ts", 9, 1));

    expect(step?.target).toEqual(entry("two.ts"));
    expect(step?.history).toEqual({ back: [entry("one.ts")], forward: [entry("here.ts", 9, 1)] });
  });

  it("steps forward: the top of forward is the target and the current location goes to back", () => {
    const history: CodeHistory = {
      back: [entry("one.ts")],
      forward: [entry("f1.ts"), entry("f2.ts")],
    };

    const step = stepCodeHistory(history, "forward", entry("here.ts"));

    expect(step?.target).toEqual(entry("f2.ts"));
    expect(step?.history).toEqual({
      back: [entry("one.ts"), entry("here.ts")],
      forward: [entry("f1.ts")],
    });
  });

  it("returns null for an empty stack, and does not read the other one", () => {
    expect(stepCodeHistory(EMPTY_CODE_HISTORY, "back", entry("here.ts"))).toBeNull();
    expect(stepCodeHistory(EMPTY_CODE_HISTORY, "forward", entry("here.ts"))).toBeNull();
    expect(stepCodeHistory({ back: [entry("a.ts")], forward: [] }, "forward", null)).toBeNull();
    expect(stepCodeHistory({ back: [], forward: [entry("a.ts")] }, "back", null)).toBeNull();
  });

  it("leaves the other stack alone when the current location is unknown", () => {
    const history: CodeHistory = { back: [entry("one.ts")], forward: [entry("f.ts")] };

    const step = stepCodeHistory(history, "back", null);

    expect(step?.history).toEqual({ back: [], forward: [entry("f.ts")] });
  });

  it("does not mutate the history it is given", () => {
    const history: CodeHistory = { back: [entry("one.ts")], forward: [] };
    stepCodeHistory(history, "back", entry("here.ts"));
    expect(history).toEqual({ back: [entry("one.ts")], forward: [] });
  });

  it("back then forward returns to where you were", () => {
    const start: CodeHistory = { back: [entry("origin.ts", 3, 1)], forward: [] };
    const here = entry("target.ts", 10, 4);

    const back = stepCodeHistory(start, "back", here)!;
    expect(back.target).toEqual(entry("origin.ts", 3, 1));

    const forward = stepCodeHistory(back.history, "forward", back.target)!;
    expect(forward.target).toEqual(here);
    expect(forward.history).toEqual(start);
  });

  it("does not stack the same location twice on the opposite stack", () => {
    const history: CodeHistory = { back: [entry("one.ts")], forward: [entry("here.ts")] };

    const step = stepCodeHistory(history, "back", entry("here.ts"));

    expect(step?.history.forward).toEqual([entry("here.ts")]);
  });

  it("caps the opposite stack at 100 entries", () => {
    const forward = Array.from({ length: 100 }, (_, line) => entry("f.ts", line));

    const step = stepCodeHistory({ back: [entry("one.ts")], forward }, "back", entry("here.ts"));

    expect(step?.history.forward).toHaveLength(100);
    expect(step?.history.forward[0]).toEqual(entry("f.ts", 1));
    expect(step?.history.forward.at(-1)).toEqual(entry("here.ts"));
  });
});

describe("reveal and consumeReveal", () => {
  it("stamps an increasing id and records the jump with the current href", () => {
    vi.stubGlobal("window", { location: { href: "http://app.test/threads/a" } });
    try {
      const store = freshStore();
      store.reveal("a", threadA, "src/one.ts", range(4));
      const first = useCodeNavigationStore.getState().revealByThreadKey["a"]!;
      store.reveal("a", threadA, "src/two.ts", range(9));
      const second = useCodeNavigationStore.getState().revealByThreadKey["a"]!;

      expect(first).toMatchObject({ path: "src/one.ts", range: range(4) });
      expect(second).toMatchObject({ path: "src/two.ts", range: range(9) });
      expect(second.id).toBeGreaterThan(first.id);
      expect(useCodeNavigationStore.getState().lastJump).toEqual({
        threadRef: threadA,
        href: "http://app.test/threads/a",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lastJump follows the most recent reveal across threads, with that moment's href", () => {
    try {
      vi.stubGlobal("window", { location: { href: "http://app.test/a" } });
      const store = freshStore();
      store.reveal("a", threadA, "a.ts", range(0));
      vi.stubGlobal("window", { location: { href: "http://app.test/b" } });
      store.reveal("b", threadB, "b.ts", range(0));

      const state = useCodeNavigationStore.getState();
      expect(state.lastJump).toEqual({ threadRef: threadB, href: "http://app.test/b" });
      expect(state.revealByThreadKey["a"]?.path).toBe("a.ts");
      expect(state.revealByThreadKey["b"]?.path).toBe("b.ts");
      expect(state.revealByThreadKey["a"]?.id).not.toBe(state.revealByThreadKey["b"]?.id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("consumes a reveal whose id still matches", () => {
    vi.stubGlobal("window", { location: { href: "http://app.test/" } });
    try {
      const store = freshStore();
      store.reveal("a", threadA, "a.ts", range(1));
      store.reveal("b", threadB, "b.ts", range(1));
      const { id } = useCodeNavigationStore.getState().revealByThreadKey["a"]!;

      store.consumeReveal("a", id);

      const { revealByThreadKey } = useCodeNavigationStore.getState();
      expect(revealByThreadKey["a"]).toBeUndefined();
      expect(revealByThreadKey["b"]).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a newer reveal when an older one is consumed", () => {
    vi.stubGlobal("window", { location: { href: "http://app.test/" } });
    try {
      const store = freshStore();
      store.reveal("a", threadA, "old.ts", range(1));
      const older = useCodeNavigationStore.getState().revealByThreadKey["a"]!;
      store.reveal("a", threadA, "new.ts", range(2));
      const before = useCodeNavigationStore.getState();

      store.consumeReveal("a", older.id);

      const after = useCodeNavigationStore.getState();
      expect(after.revealByThreadKey["a"]?.path).toBe("new.ts");
      expect(after).toBe(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("ignores consuming a thread that has no reveal", () => {
    const store = freshStore();
    const before = useCodeNavigationStore.getState();
    store.consumeReveal("missing", 1);
    expect(useCodeNavigationStore.getState()).toBe(before);
  });
});
