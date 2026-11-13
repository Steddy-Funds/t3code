import {
  type CodeViewDiffItem,
  DEFAULT_THEMES,
  parseDiffFromFile,
  preloadHighlighter,
} from "@pierre/diffs";
import type { ReactNode } from "react";
import { DEFAULT_RESOLVED_KEYBINDINGS, isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS) as never,
  };
});
// Pierre renders on the main thread: the tokens and rows are the same as the workers'.
vi.mock(import("../DiffWorkerPoolProvider"), () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import { StyledDiffCodeView } from "./StyledDiffCodeView";

// Each word is on one side only, and the sides number their lines differently.
const fileDiff = parseDiffFromFile(
  { name: "a.txt", contents: "import x;\nconst left = beta;\n" },
  { name: "a.txt", contents: "const right = gamma;\nconsume(total);\n" },
);
const items: CodeViewDiffItem<undefined>[] = [{ id: "a", type: "diff", fileDiff }];
const NAVIGATION = isMacPlatform(navigator.platform) ? { metaKey: true } : { ctrlKey: true };

function viewer(diffStyle: "unified" | "split", onTokenActivate = vi.fn()) {
  return (
    <div>
      <StyledDiffCodeView<undefined>
        style={{ width: 900, height: 400, overflow: "auto" }}
        initialItems={items}
        options={{ diffStyle, overflow: "scroll" }}
        onTokenActivate={onTokenActivate}
      />
    </div>
  );
}

function shadowRoot(container: HTMLElement): ShadowRoot {
  const root = container.querySelector("diffs-container")?.shadowRoot;
  if (!root) throw new Error("The viewer rendered no diff");
  return root;
}

/** The token holding `word`, and the middle of the word on screen. */
function wordAt(container: HTMLElement, word: string) {
  for (const token of shadowRoot(container).querySelectorAll<HTMLElement>("[data-char]")) {
    const walker = document.createTreeWalker(token, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text !== null && !(text as Text).data.includes(word)) text = walker.nextNode();
    if (text === null) continue;
    const index = (text as Text).data.indexOf(word);
    const range = document.createRange();
    range.setStart(text, index);
    range.setEnd(text, index + word.length);
    const rect = range.getBoundingClientRect();
    return { token, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  throw new Error(`No token holds ${word}`);
}

async function rendered(container: HTMLElement, word: string) {
  await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["text"] });
  await vi.waitFor(() => wordAt(container, word));
  return wordAt(container, word);
}

function clickWord(container: HTMLElement, word: string, modifiers: MouseEventInit = NAVIGATION) {
  const { token, x, y } = wordAt(container, word);
  const init = { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y };
  return act(() => {
    token.dispatchEvent(new PointerEvent("pointerdown", { ...init, ...modifiers }));
    token.dispatchEvent(new MouseEvent("click", { ...init, ...modifiers }));
  });
}

describe("Go to Declaration in a stacked or split diff", () => {
  it.each(["unified", "split"] as const)(
    "a Cmd+click in the %s layout asks about the word on its own side and line",
    async (diffStyle) => {
      const onTokenActivate = vi.fn();
      await using screen = await render(viewer(diffStyle, onTokenActivate));
      await rendered(screen.container, "gamma");

      await clickWord(screen.container, "beta");
      await clickWord(screen.container, "total");

      expect(onTokenActivate.mock.calls.map(([target]) => target)).toMatchObject([
        { side: "deletions", line: 2, character: 13 },
        { side: "additions", line: 2, character: 8 },
      ]);
      expect(onTokenActivate.mock.calls[0]![1]).toBe(fileDiff);
    },
  );

  it("a plain click asks nothing, and Go to Declaration's key then asks about that word", async () => {
    const onTokenActivate = vi.fn();
    await using screen = await render(viewer("unified", onTokenActivate));
    await rendered(screen.container, "gamma");

    await clickWord(screen.container, "gamma", {});
    expect(onTokenActivate).not.toHaveBeenCalled();
    const surface = screen.container.querySelector<HTMLElement>(".diff-render-surface")!;
    surface.focus();
    const key = new KeyboardEvent("keydown", {
      key: "b",
      code: "KeyB",
      bubbles: true,
      composed: true,
      cancelable: true,
      ...NAVIGATION,
    });
    await act(() => surface.dispatchEvent(key));

    expect(onTokenActivate).toHaveBeenCalledOnce();
    expect(onTokenActivate.mock.calls[0]![0]).toMatchObject({
      side: "additions",
      line: 1,
      character: 14,
    });
    // The key is the diff's here, not the sidebar's.
    expect(key.defaultPrevented).toBe(true);
  });

  it("a held Cmd underlines the hovered word on its own row, where both sides share a line number", async () => {
    await using screen = await render(viewer("unified"));
    await rendered(screen.container, "gamma");
    const { token, x, y } = wordAt(screen.container, "gamma");

    await act(() =>
      token.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          composed: true,
          clientX: x,
          clientY: y,
          pointerType: "mouse",
          ...NAVIGATION,
        }),
      ),
    );

    expect(Array.from(CSS.highlights.get("t3-code-link") ?? [], String)).toEqual(["gamma"]);
    expect(token.hasAttribute("data-code-nav-link")).toBe(true);
  });
});
