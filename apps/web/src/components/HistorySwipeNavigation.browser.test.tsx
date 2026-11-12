import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { HistorySwipeNavigation } from "./HistorySwipeNavigation";

const navigateHistory = vi.hoisted(() => vi.fn());
vi.mock("../navigationHistory", () => ({ canNavigateHistory: () => true, navigateHistory }));

function swipe(target: Element, deltaX: number, metaKey = false) {
  for (const delta of [deltaX, 0]) {
    target.dispatchEvent(
      new WheelEvent("wheel", { deltaX: delta, bubbles: true, composed: true, metaKey }),
    );
  }
}

describe("HistorySwipeNavigation", () => {
  it.each([
    ["scrolling left inside a shadow-root scroller keeps the thread", "shadow", 100, -130, false],
    ["scrolling right inside a shadow-root scroller keeps the thread", "shadow", 100, 130, false],
    [
      "scrolling after a shadow scroller remount keeps the thread",
      "shadow-remount",
      100,
      130,
      false,
    ],
    ["scrolling left inside a scroller keeps the thread", "light", 100, -130, false],
    ["swiping back at a shadow-root scroller's left edge navigates", "shadow", 0, -130, true],
    ["swiping back over a panel without overflow navigates", "none", 0, -130, true],
    ["a swipe that started in a closed dialog keeps the thread", "closed-dialog", 0, -130, false],
    ["swiping back over a message you can reply to replies instead", "reply-row", 0, -130, false],
    ["swiping forward over a message navigates", "reply-row", 0, 130, true],
    [
      "Cmd swiping back over a sidebar thread mentions it instead",
      "thread-row-cmd",
      0,
      -130,
      false,
    ],
    ["swiping back over a sidebar thread navigates", "thread-row", 0, -130, true],
  ] as const)("%s", async (_name, scroller, scrollLeft, deltaX, navigates) => {
    navigateHistory.mockReset();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using screen = await render(<HistorySwipeNavigation />);
    const panel = screen.container.appendChild(document.createElement("div"));
    const root = scroller.startsWith("shadow") ? panel.attachShadow({ mode: "open" }) : panel;
    const viewport = root.appendChild(document.createElement("div"));
    const noOverflow =
      scroller === "none" ||
      scroller === "closed-dialog" ||
      scroller === "reply-row" ||
      scroller.startsWith("thread-row");
    viewport.style.cssText = `width: 200px; overflow-x: ${noOverflow ? "visible" : "auto"}`;
    const content = viewport.appendChild(document.createElement("div"));
    content.style.cssText = `height: 20px; width: ${noOverflow ? 100 : 1000}px`;
    viewport.scrollLeft = scrollLeft;

    if (scroller === "reply-row") {
      panel.dataset.messageRole = "assistant";
      viewport.toggleAttribute("data-swipe-reply-surface", true);
    }

    if (scroller.startsWith("thread-row")) panel.dataset.threadItem = "environment:thread";

    if (scroller === "closed-dialog") {
      panel.setAttribute("role", "dialog");
      content.dispatchEvent(new WheelEvent("wheel", { deltaX: -1, bubbles: true, composed: true }));
      panel.remove();
      screen.container.appendChild(viewport);
    }

    if (scroller === "shadow-remount") {
      content.dispatchEvent(new WheelEvent("wheel", { deltaX: 1, bubbles: true, composed: true }));
      const replacement = viewport.cloneNode(true) as HTMLDivElement;
      viewport.replaceWith(replacement);
      replacement.scrollLeft = scrollLeft;
      swipe(replacement, deltaX);
    } else {
      swipe(content, deltaX, scroller === "thread-row-cmd");
    }

    expect(navigateHistory).toHaveBeenCalledTimes(navigates ? 1 : 0);
  });
});
