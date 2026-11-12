import {
  type CodeSemanticTokensLegend,
  type CodeServerState,
  type CodeServerStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import { fileContentRevision } from "@t3tools/shared/fileContentRevision";
import {
  getThemeEditorColors,
  MATERIAL_OCEAN_THEME,
  type ThemeEditorColors,
} from "@t3tools/shared/themePalettes";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";

// Each query waits until the test settles it, so answers can land in any order.
const mocks = vi.hoisted(() => ({
  queries: [] as Array<{
    request: { semanticTokens?: { input: Record<string, unknown> } };
    options: { refresh?: boolean };
    settle: (result: unknown) => void;
  }>,
  theme: null as ThemeEditorColors | null,
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  executeAtomQuery: ((_registry: unknown, request: never, options: never) =>
    new Promise((resolve) => {
      mocks.queries.push({ request, options, settle: resolve });
    })) as never,
}));
vi.mock(import("~/state/codeIntel"), () => ({
  codeIntelEnvironment: {
    semanticTokens: (request: unknown) => ({ semanticTokens: request }),
  } as never,
}));
vi.mock(import("~/lib/paintedThemeEditorColors"), () => ({
  usePaintedThemeEditorColors: () => mocks.theme,
}));

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  setProjectFileQueryData,
} from "../files/projectFilesQueryState";
import { semanticHighlightResolver, textLines } from "./semanticHighlighting";
import { useSemanticHighlighting } from "./useSemanticHighlighting";

const environmentId = EnvironmentId.make("env-semantic");
const ocean = getThemeEditorColors(MATERIAL_OCEAN_THEME, "dark")!;

const TEXT = "def describe(invoice, currency):\n    return len(invoice.lines)\n";
const EDITED = "def describe(invoice, currency):\n    return len(invoice.items)\n";
// ty's legend: types index 2 parameter, 5 variable, 6 property, 7 function; modifier bit 0 definition.
const legend: CodeSemanticTokensLegend = {
  tokenTypes: [
    "namespace",
    "class",
    "parameter",
    "selfParameter",
    "clsParameter",
    "variable",
  ].concat(["property", "function", "method", "keyword", "string", "number", "decorator"]),
  tokenModifiers: ["definition", "readonly", "async", "documentation"],
};
// describe, invoice, currency on line 0; len, invoice, lines on line 1.
const DATA = [
  0, 4, 8, 7, 1, 0, 9, 7, 2, 1, 0, 9, 8, 2, 1, 1, 11, 3, 7, 0, 0, 4, 7, 2, 0, 0, 8, 5, 6, 0,
];
const EDITED_DATA = [1, 23, 5, 6, 0];

const server = (state: CodeServerState): CodeServerStatus => ({
  languageId: "python",
  name: "ty",
  state,
  libraryRoots: [],
});

function Viewer(props: {
  readonly text: string;
  readonly path?: string;
  readonly server?: CodeServerStatus | null;
  readonly supported?: boolean;
  /** Zero-based lines rendered, as Pierre renders only a window of a long file. */
  readonly rows?: ReadonlyArray<number>;
  readonly refreshStatus?: () => void;
}) {
  const status = props.server === undefined ? server("ready") : props.server;
  const semantic = useSemanticHighlighting({
    environmentId,
    cwd: "/repo",
    path: props.path ?? "src/invoices.py",
    text: props.text,
    shown: true,
    intel: {
      supported: props.supported ?? true,
      servers: status === null ? [] : [status],
      server: status,
      libraryRoot: null,
      libraryCode: false,
      refreshStatus: props.refreshStatus ?? (() => {}),
    },
  });
  const lines = textLines(props.text);
  return (
    <div
      data-viewer
      ref={(host) => {
        if (host === null) return;
        const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
        const rows = (props.rows ?? lines.map((_, line) => line)).map((line) => {
          const row = document.createElement("div");
          row.dataset.line = String(line + 1);
          row.textContent = lines[line] ?? "";
          return row;
        });
        root.replaceChildren(...rows);
        semantic.onPostRender(host, "mount");
      }}
    />
  );
}

const viewer = (props: Parameters<typeof Viewer>[0]) => (
  <AppAtomRegistryProvider>
    <Viewer {...props} />
  </AppAtomRegistryProvider>
);

function setup(theme: ThemeEditorColors | null = ocean) {
  mocks.queries.length = 0;
  mocks.theme = theme;
}

const asks = () => mocks.queries.filter((query) => query.request.semanticTokens !== undefined);
const inputOf = (index: number) => asks()[index]!.request.semanticTokens!.input;

const answer = (text: string, data: ReadonlyArray<number>) =>
  AsyncResult.success({ legend, data, revision: fileContentRevision(text) });

// Settles a query, then lets its continuation run: an async timer tick drains queued promises.
async function settle(index: number, result: unknown) {
  await act(async () => {
    asks()[index]!.settle(result);
    await vi.advanceTimersByTimeAsync(0);
  });
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** The words painted in the viewer, sorted; only those in `highlight` when one is given. */
function paintedWords(container: HTMLElement, highlight?: Highlight): string[] {
  const root = container.querySelector("[data-viewer]")!.shadowRoot!;
  const words: string[] = [];
  for (const [name, painted] of CSS.highlights) {
    if (!name.startsWith("t3-semantic-") || (highlight && painted !== highlight)) continue;
    for (const range of painted) {
      if ((range as Range).startContainer.getRootNode() === root) words.push(range.toString());
    }
  }
  return words.sort();
}

function highlightOfColor(color: string): Highlight {
  return semanticHighlightResolver(
    { ...ocean, semantic: { probe: { color } } },
    { tokenTypes: ["probe"], tokenModifiers: [] },
  )({ start: 0, length: 1, type: 0, modifiers: 0 })!;
}

describe("useSemanticHighlighting", () => {
  it("paints the server's tokens over the text it asked about", async () => {
    setup();
    using _timers = fakeTimers();
    await using screen = await render(viewer({ text: TEXT }));
    await advance(0);

    expect(asks()).toHaveLength(1);
    expect(inputOf(0)).toEqual({
      document: { cwd: "/repo", path: "src/invoices.py", ifRevision: fileContentRevision(TEXT) },
    });
    expect(asks()[0]!.options.refresh).toBe(false);

    await settle(0, answer(TEXT, DATA));

    expect(paintedWords(screen.container)).toEqual(
      ["currency", "describe", "invoice", "invoice", "len", "lines"].sort(),
    );
    expect(paintedWords(screen.container, highlightOfColor("#f78c6c"))).toEqual([
      "currency",
      "invoice",
      "invoice",
    ]);
  });

  it.each([
    {
      name: "no legend",
      result: AsyncResult.success({ legend: null, revision: fileContentRevision(TEXT) }),
    },
    {
      name: "another revision",
      result: AsyncResult.success({ legend, data: DATA, revision: "0:x" }),
    },
    { name: "a failure", result: AsyncResult.failure(Cause.fail(new Error("server_failed"))) },
  ])("leaves the lexer's colours for an answer with $name", async ({ result }) => {
    setup();
    using _timers = fakeTimers();
    await using screen = await render(viewer({ text: TEXT }));
    await advance(0);

    await settle(0, result);

    expect(paintedWords(screen.container)).toEqual([]);
  });

  it("colours only the lines an edit left alone until the edit's own answer lands", async () => {
    setup();
    using _timers = fakeTimers();
    await using screen = await render(viewer({ text: TEXT }));
    await advance(0);
    await screen.rerender(viewer({ text: EDITED }));
    await advance(250);
    expect(inputOf(1)).toMatchObject({ document: { ifRevision: fileContentRevision(EDITED) } });

    await settle(0, answer(TEXT, DATA));
    expect(paintedWords(screen.container)).toEqual(["currency", "describe", "invoice"]);

    await settle(1, answer(EDITED, EDITED_DATA));
    expect(paintedWords(screen.container)).toEqual(["items"]);
  });

  it("never lets an older answer replace a newer one", async () => {
    setup();
    using _timers = fakeTimers();
    await using screen = await render(viewer({ text: TEXT }));
    await advance(0);
    await screen.rerender(viewer({ text: EDITED }));
    await advance(0);

    await settle(1, answer(EDITED, EDITED_DATA));
    await settle(0, answer(TEXT, DATA));

    expect(paintedWords(screen.container)).toEqual(["items"]);
  });

  it("asks about an edit only once it is saved, since the server reads the file on disk", async () => {
    setup();
    const path = "src/unsaved.py";
    using _unsaved = {
      [Symbol.dispose]: () => clearProjectFileQueryData(environmentId, "/repo", path),
    };
    using _timers = fakeTimers();
    await using screen = await render(viewer({ text: TEXT, path }));
    await advance(0);

    await act(() => setProjectFileQueryData(environmentId, "/repo", path, EDITED));
    await screen.rerender(viewer({ text: EDITED, path }));
    await advance(1_000);
    expect(asks()).toHaveLength(1);

    await act(() => confirmProjectFileQueryData(environmentId, "/repo", path, EDITED));
    await advance(250);
    expect(asks()).toHaveLength(2);
    expect(inputOf(1)).toMatchObject({ document: { ifRevision: fileContentRevision(EDITED) } });
  });

  it.each([
    { name: "no language server for the file", props: { server: null } },
    { name: "an unavailable server", props: { server: server("unavailable") } },
    { name: "a failed server", props: { server: server("failed") } },
    { name: "a server without code intel", props: { supported: false } },
  ])("asks nothing with $name", async ({ props }) => {
    setup();
    using _timers = fakeTimers();
    await using _screen = await render(viewer({ text: TEXT, ...props }));
    await advance(1_000);

    expect(asks()).toEqual([]);
  });

  it("asks nothing under a theme without semantic colours", async () => {
    setup(null);
    using _timers = fakeTimers();
    await using _screen = await render(viewer({ text: TEXT }));
    await advance(1_000);

    expect(asks()).toEqual([]);
  });

  it("repaints in the theme switched to while it asked, and wipes the colours for one without them", async () => {
    setup();
    using _timers = fakeTimers();
    await using screen = await render(viewer({ text: TEXT }));
    await advance(0);
    mocks.theme = { ...ocean, semantic: { ...ocean.semantic, parameter: { color: "#123456" } } };
    await screen.rerender(viewer({ text: TEXT }));

    await settle(0, answer(TEXT, DATA));
    expect(paintedWords(screen.container, highlightOfColor("#123456"))).toEqual([
      "currency",
      "invoice",
      "invoice",
    ]);

    mocks.theme = null;
    await screen.rerender(viewer({ text: TEXT }));
    expect(paintedWords(screen.container)).toEqual([]);
  });

  it("asks once more, fresh, when a server that was starting is ready", async () => {
    setup();
    const refreshStatus = vi.fn();
    using _timers = fakeTimers();
    await using screen = await render(
      viewer({ text: TEXT, server: server("starting"), refreshStatus }),
    );
    await advance(0);
    await settle(0, answer(TEXT, DATA.slice(0, 5)));
    expect(refreshStatus).toHaveBeenCalled();

    await screen.rerender(viewer({ text: TEXT, server: server("ready"), refreshStatus }));
    await advance(250);
    expect(asks()).toHaveLength(2);
    expect(asks()[1]!.options.refresh).toBe(true);

    await settle(1, answer(TEXT, DATA));
    await screen.rerender(viewer({ text: TEXT, server: server("ready"), refreshStatus }));
    await advance(1_000);
    expect(asks()).toHaveLength(2);
    expect(paintedWords(screen.container)).toHaveLength(6);
  });

  it("asks a long file only for the chunk on screen", async () => {
    setup();
    const long = Array.from({ length: 3_500 }, (_, line) => `x${line} = ${line}`).join("\n");
    const rows = Array.from({ length: 20 }, (_, index) => 1_200 + index);
    using _timers = fakeTimers();
    await using screen = await render(viewer({ text: long, rows }));
    await advance(1_000);

    expect(asks()).toHaveLength(1);
    expect(inputOf(0)).toMatchObject({
      range: { start: { line: 1_000, character: 0 }, end: { line: 2_000, character: 0 } },
    });

    await settle(0, answer(long, [1_200, 0, 5, 5, 0]));
    expect(paintedWords(screen.container)).toEqual(["x1200"]);
  });
});
