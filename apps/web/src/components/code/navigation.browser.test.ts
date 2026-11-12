import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type CodeLocation,
  type EnvironmentId,
  type KeybindingCommand,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  type CodeHistoryEntry,
  EMPTY_CODE_HISTORY,
  useCodeNavigationStore,
} from "../../codeNavigationStore";
import {
  hostRightPanel,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import {
  codeNavigationThreadKey,
  expireCodeJump,
  navigateToCodeLocation,
  registerCodeViewer,
} from "./navigation";

// The dispatcher's keybinding lookup is its own test's business: capture what navigation.ts
// registers and call the handlers directly.
const registered = vi.hoisted(() => ({
  scopes: [] as Array<{
    commands: Partial<Record<KeybindingCommand, (event: KeyboardEvent) => boolean | void>>;
    options: { when?: (event: KeyboardEvent) => boolean; capture?: boolean };
    release: () => void;
    released: boolean;
  }>,
}));

vi.mock("../../shortcuts/dispatcher", () => ({
  registerCommands: (
    commands: (typeof registered.scopes)[number]["commands"],
    options: (typeof registered.scopes)[number]["options"],
  ) => {
    const scope = {
      commands,
      options,
      released: false,
      release: () => {
        scope.released = true;
      },
    };
    registered.scopes.push(scope);
    return scope.release;
  },
}));

const threadA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const threadB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));
const keyA = codeNavigationThreadKey(threadA);
const keyB = codeNavigationThreadKey(threadB);

const entry = (path: string, line = 0, character = 0): CodeHistoryEntry => ({
  path,
  position: { line, character },
});

const target = (path: string, line: number, character = 0): CodeLocation => ({
  path,
  external: false,
  range: {
    start: { line, character },
    end: { line, character: character + 2 },
  },
});

function setup() {
  registered.scopes.length = 0;
  useCodeNavigationStore.setState({
    historyByThreadKey: {},
    revealByThreadKey: {},
    lastJump: null,
  });
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
  (document.activeElement as HTMLElement | null)?.blur();
  const stack = new DisposableStack();
  return stack;
}

function mountViewer(
  stack: DisposableStack,
  threadRef: typeof threadA,
  initial: CodeHistoryEntry | null,
) {
  const element = document.createElement("div");
  const input = document.createElement("textarea");
  element.append(input);
  document.body.append(element);
  stack.defer(() => element.remove());
  const state = { location: initial };
  stack.defer(registerCodeViewer({ element, threadRef, location: () => state.location }));
  return { element, input, state };
}

function press(command: "navigation.back" | "navigation.forward", target?: EventTarget) {
  const scope = registered.scopes.at(-1)!;
  const event = new KeyboardEvent("keydown", { cancelable: true, bubbles: true });
  const stopPropagation = vi.spyOn(event, "stopPropagation");
  Object.defineProperty(event, "target", { value: target ?? document.body });
  const handled = scope.commands[command]!(event);
  return { handled, event, stopPropagation };
}

const history = (key: string) =>
  useCodeNavigationStore.getState().historyByThreadKey[key] ?? EMPTY_CODE_HISTORY;

const activeFile = (ref: typeof threadA) => {
  const surface = selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref);
  return surface?.kind === "file" ? surface : null;
};

describe("navigateToCodeLocation", () => {
  it("opens the file at the 1-based line, sets the reveal and the last jump", () => {
    using _stack = setup();
    navigateToCodeLocation(threadA, target("src/a.ts", 11, 4));

    expect(activeFile(threadA)).toMatchObject({ relativePath: "src/a.ts", revealLine: 12 });
    expect(useCodeNavigationStore.getState().revealByThreadKey[keyA]).toMatchObject({
      path: "src/a.ts",
      range: target("src/a.ts", 11, 4).range,
    });
    expect(useCodeNavigationStore.getState().lastJump).toEqual({
      threadRef: threadA,
      href: window.location.href,
    });
  });

  it("records where the jump left from, using the viewer's current location", () => {
    using stack = setup();
    const viewer = mountViewer(stack, threadA, entry("src/origin.ts", 3, 1));

    navigateToCodeLocation(threadA, target("src/a.ts", 0));
    viewer.state.location = entry("src/a.ts", 5, 5);
    navigateToCodeLocation(threadA, target("src/b.ts", 0));

    expect(history(keyA).back).toEqual([entry("src/origin.ts", 3, 1), entry("src/a.ts", 5, 5)]);
  });

  it("skips the origin with pushHistory: false, but still reveals and opens", () => {
    using stack = setup();
    mountViewer(stack, threadA, entry("src/origin.ts"));

    navigateToCodeLocation(threadA, target("src/a.ts", 2), { pushHistory: false });

    expect(history(keyA)).toEqual(EMPTY_CODE_HISTORY);
    expect(activeFile(threadA)?.relativePath).toBe("src/a.ts");
    expect(useCodeNavigationStore.getState().revealByThreadKey[keyA]?.path).toBe("src/a.ts");
  });

  it("records nothing when no viewer is registered or the viewer has no location yet", () => {
    using stack = setup();
    navigateToCodeLocation(threadA, target("src/a.ts", 0));
    expect(history(keyA)).toEqual(EMPTY_CODE_HISTORY);

    mountViewer(stack, threadA, null);
    navigateToCodeLocation(threadA, target("src/b.ts", 0));
    expect(history(keyA)).toEqual(EMPTY_CODE_HISTORY);
  });

  it("clears forward on a new jump", () => {
    using stack = setup();
    mountViewer(stack, threadA, entry("src/origin.ts"));
    useCodeNavigationStore.getState().setHistory(keyA, { back: [], forward: [entry("fwd.ts")] });

    navigateToCodeLocation(threadA, target("src/a.ts", 0));

    expect(history(keyA).forward).toEqual([]);
  });

  it("ignores a viewer that is hidden or detached", () => {
    using stack = setup();
    const visible = mountViewer(stack, threadA, entry("visible.ts"));
    const hidden = mountViewer(stack, threadA, entry("hidden.ts"));
    hidden.element.style.display = "none";

    navigateToCodeLocation(threadA, target("src/a.ts", 0));
    expect(history(keyA).back).toEqual([entry("visible.ts")]);

    visible.element.remove();
    navigateToCodeLocation(threadA, target("src/b.ts", 0));
    expect(history(keyA).back).toEqual([entry("visible.ts")]);
  });

  it("takes the origin from the most recently used viewer: focus or pointer press", () => {
    using stack = setup();
    const first = mountViewer(stack, threadA, entry("first.ts"));
    const second = mountViewer(stack, threadA, entry("second.ts"));

    navigateToCodeLocation(threadA, target("x.ts", 0));
    expect(history(keyA).back.at(-1)).toEqual(entry("second.ts"));

    first.input.focus();
    navigateToCodeLocation(threadA, target("y.ts", 0));
    expect(history(keyA).back.at(-1)).toEqual(entry("first.ts"));

    second.element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: false }));
    navigateToCodeLocation(threadA, target("z.ts", 0));
    expect(history(keyA).back.at(-1)).toEqual(entry("second.ts"));
  });

  it("does not take an origin from another thread's viewer", () => {
    using stack = setup();
    mountViewer(stack, threadB, entry("b.ts"));

    navigateToCodeLocation(threadA, target("src/a.ts", 0));

    expect(history(keyA)).toEqual(EMPTY_CODE_HISTORY);
    expect(history(keyB)).toEqual(EMPTY_CODE_HISTORY);
  });

  it("shares the parent thread's history and panel with a hosted side chat", () => {
    using stack = setup();
    stack.defer(hostRightPanel(threadB, threadA));
    mountViewer(stack, threadA, entry("host.ts"));

    expect(codeNavigationThreadKey(threadB)).toBe(keyA);
    navigateToCodeLocation(threadB, target("src/a.ts", 3));

    expect(history(keyA).back).toEqual([entry("host.ts")]);
    expect(useCodeNavigationStore.getState().revealByThreadKey[keyA]?.path).toBe("src/a.ts");
    expect(activeFile(threadA)).toMatchObject({ relativePath: "src/a.ts", revealLine: 4 });
  });

  it("keeps threads' histories apart", () => {
    using stack = setup();
    mountViewer(stack, threadA, entry("a.ts"));
    mountViewer(stack, threadB, entry("b.ts"));

    navigateToCodeLocation(threadA, target("x.ts", 0));
    navigateToCodeLocation(threadB, target("y.ts", 0));

    expect(history(keyA).back).toEqual([entry("a.ts")]);
    expect(history(keyB).back).toEqual([entry("b.ts")]);
  });
});

describe("registerCodeViewer commands", () => {
  it("registers back and forward in the capture phase once, however many viewers", () => {
    using stack = setup();
    expect(registered.scopes).toHaveLength(0);

    mountViewer(stack, threadA, null);
    mountViewer(stack, threadB, null);

    expect(registered.scopes).toHaveLength(1);
    const [scope] = registered.scopes;
    expect(Object.keys(scope!.commands).toSorted()).toEqual([
      "navigation.back",
      "navigation.forward",
    ]);
    expect(scope!.options.capture).toBe(true);
  });

  it("removes the commands only when the last viewer unregisters, then registers anew", () => {
    using stack = setup();
    const first = new DisposableStack();
    const second = new DisposableStack();
    mountViewer(first, threadA, null);
    mountViewer(second, threadA, null);

    first.dispose();
    expect(registered.scopes[0]?.released).toBe(false);
    second.dispose();
    expect(registered.scopes[0]?.released).toBe(true);

    mountViewer(stack, threadA, null);
    expect(registered.scopes).toHaveLength(2);
    expect(registered.scopes[1]?.released).toBe(false);
  });

  it("stops listening for focus once unregistered", () => {
    using stack = setup();
    const viewer = new DisposableStack();
    const mounted = mountViewer(viewer, threadA, entry("a.ts"));
    mountViewer(stack, threadA, entry("other.ts"));
    viewer.dispose();
    document.body.append(mounted.element);
    stack.defer(() => mounted.element.remove());

    mounted.input.focus();
    navigateToCodeLocation(threadA, target("x.ts", 0));

    expect(history(keyA).back).toEqual([entry("other.ts")]);
  });

  it("only handles the key when it does not come from inside a keybinding capture", () => {
    using stack = setup();
    mountViewer(stack, threadA, null);
    const when = registered.scopes[0]!.options.when!;
    const capture = document.createElement("div");
    capture.setAttribute("data-keybinding-capture", "");
    const field = document.createElement("input");
    capture.append(field);
    document.body.append(capture);
    stack.defer(() => capture.remove());

    const from = (node: EventTarget) => {
      const event = new KeyboardEvent("keydown");
      Object.defineProperty(event, "target", { value: node });
      return when(event);
    };

    expect(from(field)).toBe(false);
    expect(from(capture)).toBe(false);
    expect(from(document.body)).toBe(true);
    expect(from(window)).toBe(true);
  });
});

describe("back and forward", () => {
  function jumped(stack: DisposableStack) {
    const viewer = mountViewer(stack, threadA, entry("src/origin.ts", 2, 1));
    navigateToCodeLocation(threadA, target("src/target.ts", 10, 4));
    viewer.state.location = entry("src/target.ts", 10, 4);
    return viewer;
  }

  it("steps back with focus inside a viewer, consuming the key", () => {
    using stack = setup();
    const viewer = jumped(stack);
    viewer.input.focus();

    const { handled, event, stopPropagation } = press("navigation.back");

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalled();
    expect(activeFile(threadA)).toMatchObject({ relativePath: "src/origin.ts", revealLine: 3 });
    expect(useCodeNavigationStore.getState().revealByThreadKey[keyA]).toMatchObject({
      path: "src/origin.ts",
      range: { start: { line: 2, character: 1 }, end: { line: 2, character: 1 } },
    });
    expect(history(keyA)).toEqual({ back: [], forward: [entry("src/target.ts", 10, 4)] });
  });

  it("back then forward returns to where you were, without growing back", () => {
    using stack = setup();
    const viewer = jumped(stack);
    viewer.input.focus();

    press("navigation.back");
    viewer.state.location = entry("src/origin.ts", 2, 1);
    const forward = press("navigation.forward");

    expect(forward.handled).toBe(true);
    expect(activeFile(threadA)).toMatchObject({ relativePath: "src/target.ts", revealLine: 11 });
    expect(history(keyA)).toEqual({ back: [entry("src/origin.ts", 2, 1)], forward: [] });
  });

  it("falls through with an empty stack: false, not prevented", () => {
    using stack = setup();
    const viewer = mountViewer(stack, threadA, entry("a.ts"));
    viewer.input.focus();

    for (const command of ["navigation.back", "navigation.forward"] as const) {
      const { handled, event, stopPropagation } = press(command);
      expect(handled).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      expect(stopPropagation).not.toHaveBeenCalled();
    }
    expect(history(keyA)).toEqual(EMPTY_CODE_HISTORY);
  });

  it("falls through when forward is empty even though back is not", () => {
    using stack = setup();
    const viewer = jumped(stack);
    viewer.input.focus();

    const { handled, event } = press("navigation.forward");

    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(history(keyA).back).toEqual([entry("src/origin.ts", 2, 1)]);
  });

  it("steps when nothing is focused in a viewer but the last jump was at this location", () => {
    using stack = setup();
    jumped(stack);
    (document.activeElement as HTMLElement | null)?.blur();
    // The router resolving the same location again, as `router.invalidate()` does, keeps the jump.
    expireCodeJump();

    const { handled, event } = press("navigation.back");

    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(activeFile(threadA)?.relativePath).toBe("src/origin.ts");
  });

  it("falls through after app navigation changed the location since the jump", () => {
    using stack = setup();
    jumped(stack);
    const before = window.location.href;
    stack.defer(() => window.history.replaceState(null, "", before));
    window.history.replaceState(null, "", `${before.split("#")[0]}#moved`);

    const { handled, event } = press("navigation.back");

    expect(handled).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(history(keyA).back).toEqual([entry("src/origin.ts", 2, 1)]);
  });

  it("falls through after app navigation left the jump's page and came back to it", () => {
    using stack = setup();
    jumped(stack);
    const before = window.location.href;
    stack.defer(() => window.history.replaceState(null, "", before));
    window.history.replaceState(null, "", `${before.split("#")[0]}#moved`);
    expireCodeJump();
    window.history.replaceState(null, "", before);
    expireCodeJump();

    expect(press("navigation.back").handled).toBe(false);
  });

  it("still steps after app navigation when focus is inside a viewer", () => {
    using stack = setup();
    const viewer = jumped(stack);
    const before = window.location.href;
    stack.defer(() => window.history.replaceState(null, "", before));
    window.history.replaceState(null, "", `${before.split("#")[0]}#moved`);
    viewer.input.focus();

    expect(press("navigation.back").handled).toBe(true);
  });

  it("falls through when no jump has happened and nothing is focused in a viewer", () => {
    using stack = setup();
    mountViewer(stack, threadA, entry("a.ts"));
    useCodeNavigationStore.getState().setHistory(keyA, { back: [entry("old.ts")], forward: [] });

    expect(press("navigation.back").handled).toBe(false);
  });

  it("steps the focused viewer's thread, not the thread of the last jump", () => {
    using stack = setup();
    mountViewer(stack, threadA, entry("a-origin.ts"));
    navigateToCodeLocation(threadA, target("a-target.ts", 0));
    const viewerB = mountViewer(stack, threadB, entry("b-origin.ts"));
    useCodeNavigationStore.getState().setHistory(keyB, { back: [entry("b-prev.ts")], forward: [] });
    viewerB.input.focus();

    press("navigation.back");

    expect(activeFile(threadB)?.relativePath).toBe("b-prev.ts");
    expect(activeFile(threadA)?.relativePath).toBe("a-target.ts");
    expect(history(keyA).back).toEqual([entry("a-origin.ts")]);
    expect(history(keyB)).toEqual({ back: [], forward: [entry("b-origin.ts")] });
  });

  it("does not push history while stepping", () => {
    using stack = setup();
    const viewer = jumped(stack);
    viewer.input.focus();
    useCodeNavigationStore.getState().setHistory(keyA, {
      back: [entry("one.ts"), entry("two.ts")],
      forward: [],
    });

    press("navigation.back");
    viewer.state.location = entry("two.ts");
    press("navigation.back");

    expect(activeFile(threadA)?.relativePath).toBe("one.ts");
    expect(history(keyA).back).toEqual([]);
    expect(history(keyA).forward.map((item) => item.path)).toEqual(["src/target.ts", "two.ts"]);
  });

  it("steps without a current location, leaving the other stack as it was", () => {
    using stack = setup();
    const viewer = mountViewer(stack, threadA, null);
    viewer.input.focus();
    useCodeNavigationStore.getState().setHistory(keyA, {
      back: [entry("one.ts")],
      forward: [entry("fwd.ts")],
    });

    expect(press("navigation.back").handled).toBe(true);
    expect(history(keyA)).toEqual({ back: [], forward: [entry("fwd.ts")] });
  });
});
