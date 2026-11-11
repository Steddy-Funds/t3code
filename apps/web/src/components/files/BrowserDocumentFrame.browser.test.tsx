import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";

import { HtmlRenderDocument } from "./BrowserDocumentFrame";

const sizeChanged = (height: number) => ({
  jsonrpc: "2.0",
  method: "ui/notifications/size-changed",
  params: { height },
});

describe("HtmlRenderDocument", () => {
  it("reports the page's first height and ignores messages from other windows", async () => {
    using pageUrl = (() => {
      const page = `<script>parent.postMessage(${JSON.stringify(sizeChanged(321))}, "*");</script>`;
      const url = URL.createObjectURL(new Blob([page], { type: "text/html" }));
      return { url, [Symbol.dispose]: () => URL.revokeObjectURL(url) };
    })();
    const onContentHeight = vi.fn();
    await using _screen = await render(
      <HtmlRenderDocument src={pageUrl.url} title="Report" onContentHeight={onContentHeight} />,
    );

    await vi.waitFor(() => expect(onContentHeight).toHaveBeenCalledWith(321));

    // Listeners run in registration order, so once this one sees the message the frame's has too.
    const delivered = new Promise<void>((resolve) =>
      window.addEventListener("message", () => resolve(), { once: true }),
    );
    window.postMessage(sizeChanged(999), "*");
    await delivered;
    expect(onContentHeight).toHaveBeenCalledTimes(1);
  });

  it("replays an app shortcut whose key a code shortcut shares", async () => {
    const mac = isMacPlatform(navigator.platform);
    // What the page's bootstrap reports for a mod+b the page left unused.
    const modB = {
      jsonrpc: "2.0",
      method: "t3/notifications/keydown",
      params: { key: "b", code: "KeyB", metaKey: mac, ctrlKey: !mac },
    };
    using pageUrl = (() => {
      const page = `<script>
        addEventListener("message", function (event) {
          if (event.data === "press") parent.postMessage(${JSON.stringify(modB)}, "*");
        });
        parent.postMessage(${JSON.stringify(sizeChanged(120))}, "*");
      </script>`;
      const url = URL.createObjectURL(new Blob([page], { type: "text/html" }));
      return { url, [Symbol.dispose]: () => URL.revokeObjectURL(url) };
    })();
    const onContentHeight = vi.fn();
    const replayed = vi.fn();
    const keys = new AbortController();
    using _keys = { [Symbol.dispose]: () => keys.abort() };
    window.addEventListener("keydown", (event) => replayed(event.key, event.target), {
      signal: keys.signal,
    });
    await using screen = await render(
      <>
        <style>{`iframe[title="Keys"] { display: block; width: 300px; height: 120px; }`}</style>
        <HtmlRenderDocument src={pageUrl.url} title="Keys" onContentHeight={onContentHeight} />
      </>,
    );
    await vi.waitFor(() => expect(onContentHeight).toHaveBeenCalled());
    const frame = screen.getByTitle("Keys").element() as HTMLIFrameElement;

    // The frame replays keys only while it has the focus and the reader was just active.
    await userEvent.click(frame);
    await vi.waitFor(() => expect(document.activeElement).toBe(frame));
    frame.contentWindow?.postMessage("press", "*");

    await vi.waitFor(() => expect(replayed).toHaveBeenCalledWith("b", frame));
  });

  it("leaves desktop-only shortcuts with the page in a browser tab", async () => {
    using pageUrl = (() => {
      // The page reports back the shortcuts it was told to hand over.
      const page = `<script>
        addEventListener("message", function (event) {
          var data = event.data;
          if (data && data.method === "t3/notifications/shortcuts") {
            parent.postMessage({ handedOver: data.params.shortcuts }, "*");
          }
        });
      </script>`;
      const url = URL.createObjectURL(new Blob([page], { type: "text/html" }));
      return { url, [Symbol.dispose]: () => URL.revokeObjectURL(url) };
    })();
    const handedOver: Array<ReadonlyArray<{ key: string; altKey: boolean }>> = [];
    const messages = new AbortController();
    using _messages = { [Symbol.dispose]: () => messages.abort() };
    window.addEventListener(
      "message",
      (event) => {
        if (Array.isArray(event.data?.handedOver)) handedOver.push(event.data.handedOver);
      },
      { signal: messages.signal },
    );
    await using _screen = await render(<HtmlRenderDocument src={pageUrl.url} title="Keys" />);

    await vi.waitFor(() => expect(handedOver.length).toBeGreaterThan(0));
    const takes = (key: string, altKey: boolean) =>
      handedOver.at(-1)?.some((shortcut) => shortcut.key === key && shortcut.altKey === altKey);
    expect(takes("b", false)).toBe(true);
    // Back and Forward on mod+alt+arrows and the mod+1 jumps run only in the desktop app.
    expect(takes("arrowleft", true)).toBe(false);
    expect(takes("1", false)).toBe(false);
  });
});

it("keeps the first and last selected card rings inside the fitted renderer frame", async () => {
  const html = injectHtmlRenderBootstrap(`<!doctype html><html><head><style>
    main { display: grid; gap: 12px; }
    button { box-sizing: border-box; width: 100%; height: 72px; border: 0; }
    button[aria-pressed="true"] { outline: 3px solid blue; outline-offset: 2px; }
  </style></head><body><main>
    <button id="first" aria-pressed="false">Meadow</button>
    <button id="middle" aria-pressed="false">Harbor</button>
    <button id="last" aria-pressed="false">Orchid</button>
  </main><script>
    document.querySelectorAll("button").forEach(function(button) {
      button.addEventListener("click", function() {
        document.querySelectorAll("button").forEach(function(card) {
          card.setAttribute("aria-pressed", String(card === button));
        });
      });
    });
    window.addEventListener("message", function(event) {
      if (event.source !== window.parent || event.data.type !== "select-card") return;
      var button = document.getElementById(event.data.id);
      button.click();
      var rect = button.getBoundingClientRect();
      var style = getComputedStyle(button);
      var ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      window.parent.postMessage({
        type: "selected-card-bounds",
        id: button.id,
        selected: button.getAttribute("aria-pressed") === "true",
        ring: ring,
        left: rect.left - ring,
        right: rect.right + ring,
        top: rect.top - ring,
        bottom: rect.bottom + ring,
        pageHeight: document.documentElement.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth
      }, "*");
    });
  </script></body></html>`);
  const src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
  const container = document.createElement("div");
  container.style.width = "728px";
  const reports = new Map<
    string,
    {
      selected: boolean;
      ring: number;
      left: number;
      right: number;
      top: number;
      bottom: number;
      pageHeight: number;
      viewportHeight: number;
      viewportWidth: number;
      scrollWidth: number;
    }
  >();
  const messages = new AbortController();
  using _messages = { [Symbol.dispose]: () => messages.abort() };
  window.addEventListener(
    "message",
    (event) => {
      const frame = container.querySelector("iframe");
      if (event.source === frame?.contentWindow && event.data?.type === "selected-card-bounds") {
        reports.set(event.data.id, event.data);
      }
    },
    { signal: messages.signal },
  );
  const contentHeight = vi.fn((height: number) => {
    container.style.setProperty("--content-height", `${height}px`);
  });
  await using screen = await render(
    <>
      <style>{`iframe[title="Edge cards"] {
        display: block; width: 100%; height: var(--content-height, 120px); border: 0;
      }`}</style>
      <HtmlRenderDocument src={src} title="Edge cards" onContentHeight={contentHeight} />
    </>,
    { container },
  );

  await vi.waitFor(() => expect(contentHeight).toHaveBeenCalled());
  const frame = screen.getByTitle("Edge cards").element() as HTMLIFrameElement;
  await vi.waitFor(() => {
    expect(frame.getBoundingClientRect().height).toBe(contentHeight.mock.lastCall?.[0]);
  });

  for (const id of ["first", "last"]) {
    frame.contentWindow?.postMessage({ type: "select-card", id }, "*");
    await vi.waitFor(() => expect(reports.get(id)?.selected).toBe(true));
    const bounds = reports.get(id)!;
    expect(bounds.ring).toBe(5);
    expect(bounds.viewportWidth).toBe(728);
    expect(bounds.pageHeight).toBe(contentHeight.mock.lastCall?.[0]);
    expect(bounds.viewportHeight).toBe(bounds.pageHeight);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.viewportWidth);
  }
});
