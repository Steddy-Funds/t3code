import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type CodeIntelWorkspaceSymbolsInput,
  type CodeWorkspaceSymbol,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../../test/render";
import { CommandDialog, CommandDialogPopup } from "../../ui/command";

const mocks = vi.hoisted(() => ({
  target: null as unknown,
  symbols: [] as ReadonlyArray<CodeWorkspaceSymbol>,
  searches: [] as Array<CodeIntelWorkspaceSymbolsInput>,
  answers: new Map<string, unknown>(),
  navigateToCodeLocation: vi.fn(),
}));

vi.mock(import("~/hooks/useActiveProjectTarget"), () => ({
  useActiveProjectTarget: (() => mocks.target) as never,
}));
vi.mock(import("~/state/codeIntel"), () => ({
  codeIntelEnvironment: {
    status: (request: unknown) => ({ rpc: "status", request }),
    workspaceSymbols: (request: unknown) => ({ rpc: "workspaceSymbols", request }),
  } as never,
}));
// A language server's answer, the same object on every render as the query hook gives.
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: { rpc: string; request: { input: unknown } } | null) => {
    const view = { error: null, failure: null, isPending: false, dataUpdatedAt: 0 };
    if (atom?.rpc !== "workspaceSymbols") return { ...view, data: null };
    const input = atom.request.input as CodeIntelWorkspaceSymbolsInput;
    if (!mocks.answers.has(input.query)) {
      mocks.searches.push(input);
      const query = input.query.toLowerCase();
      const symbols = mocks.symbols.filter(
        (symbol) =>
          (input.kinds === undefined || input.kinds.includes(symbol.kind)) &&
          symbol.name.toLowerCase().startsWith(query),
      );
      mocks.answers.set(input.query, { symbols, truncated: false });
    }
    return { ...view, data: mocks.answers.get(input.query) };
  }) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make([]) as never };
});
vi.mock(import("../navigation"), async (original) => ({
  ...(await original()),
  navigateToCodeLocation: mocks.navigateToCodeLocation,
}));

import { dispatchCommandPalette, useCommandPaletteStore } from "~/commandPaletteStore";
import { focusScopeProps } from "~/lib/focusScopes";

import { CommandPalette } from "../../CommandPalette";
import { CLASS_SYMBOL_KINDS } from "./codePickers.logic";
import { runJumpFromPalette } from "./codeSymbolCommands";
import { WorkspaceSymbolPicker } from "./WorkspaceSymbolPicker";

const threadRef = scopeThreadRef(EnvironmentId.make("env-sym"), ThreadId.make("thread-sym"));

function at(path: string, line: number, external = false): CodeWorkspaceSymbol["location"] {
  return {
    path,
    external,
    range: { start: { line, character: 6 }, end: { line, character: 13 } },
  };
}

const libraryInvoice: CodeWorkspaceSymbol = {
  name: "Invoice",
  kind: "class",
  containerName: "stripe",
  location: at(".venv/lib/python3.13/site-packages/stripe/_invoice.py", 40, true),
};
const invoice: CodeWorkspaceSymbol = {
  name: "Invoice",
  kind: "class",
  containerName: "billing.models",
  location: at("billing/models.py", 11),
};
const invoiceLine: CodeWorkspaceSymbol = {
  name: "InvoiceLine",
  kind: "class",
  location: at("billing/models.py", 52),
};
const invoiceTotal: CodeWorkspaceSymbol = {
  name: "invoice_total",
  kind: "function",
  location: at("billing/totals.py", 3),
};

function setup() {
  mocks.target = {
    environmentId: threadRef.environmentId,
    cwd: "/work/shop",
    projectName: "shop",
    threadRef,
  };
  // The server ranks the library class first.
  mocks.symbols = [libraryInvoice, invoice, invoiceTotal, invoiceLine];
  mocks.searches.length = 0;
  mocks.answers.clear();
  mocks.navigateToCodeLocation.mockReset();
  useCommandPaletteStore.setState(useCommandPaletteStore.getInitialState(), true);
}

// The code viewer's editor: a contenteditable in the code focus scope.
function mountCodeEditor() {
  const viewer = document.createElement("div");
  for (const [name, value] of Object.entries(focusScopeProps("code"))) {
    viewer.setAttribute(name, value);
  }
  const editor = document.createElement("div");
  editor.contentEditable = "true";
  viewer.append(editor);
  document.body.append(viewer);
  return Object.assign(editor, { [Symbol.dispose]: () => viewer.remove() });
}

describe("Go to class", () => {
  it("finds the classes named Invoice, project first, and Enter opens the definition", async () => {
    setup();
    const setOpen = vi.fn();
    await using _screen = await render(
      <CommandDialog open>
        <CommandDialogPopup aria-label="Command palette">
          <WorkspaceSymbolPicker scope="classes" escapeLabel="Back" setOpen={setOpen} />
        </CommandDialogPopup>
      </CommandDialog>,
    );
    using _timers = fakeTimers();

    await userEvent.type(page.getByPlaceholder("Search classes…"), "Invoice");
    expect(mocks.searches).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(150));

    expect(mocks.searches).toEqual([
      { cwd: "/work/shop", query: "Invoice", limit: 100, kinds: CLASS_SYMBOL_KINDS },
    ]);
    await vi.waitFor(() =>
      expect(
        page
          .getByRole("option")
          .elements()
          .map((option) => option.textContent),
      ).toEqual([
        expect.stringContaining("billing/models.py:12"),
        expect.stringContaining("billing/models.py:53"),
        expect.stringContaining("stripe/_invoice.py:41"),
      ]),
    );

    await userEvent.keyboard("{Enter}");

    expect(setOpen).toHaveBeenCalledWith(false);
    expect(runJumpFromPalette()).toBe(true);
    expect(mocks.navigateToCodeLocation).toHaveBeenCalledWith(threadRef, invoice.location);
  });

  it("narrows the last answer to the new query while it runs, so Enter opens a match", async () => {
    setup();
    await using _screen = await render(
      <CommandDialog open>
        <CommandDialogPopup aria-label="Command palette">
          <WorkspaceSymbolPicker scope="classes" escapeLabel="Back" setOpen={vi.fn()} />
        </CommandDialogPopup>
      </CommandDialog>,
    );
    using _timers = fakeTimers();
    const input = page.getByPlaceholder("Search classes…");
    await userEvent.type(input, "Inv");
    await act(() => vi.advanceTimersByTimeAsync(150));
    await vi.waitFor(() => expect(page.getByRole("option").elements()).toHaveLength(3));

    // Still within the debounce: the answer on screen is the one for "Inv".
    await userEvent.type(input, "oiceL");
    await vi.waitFor(() =>
      expect(
        page
          .getByRole("option")
          .elements()
          .map((option) => option.textContent),
      ).toEqual([expect.stringContaining("billing/models.py:53")]),
    );
    await userEvent.keyboard("{Enter}");

    expect(runJumpFromPalette()).toBe(true);
    expect(mocks.navigateToCodeLocation).toHaveBeenCalledWith(threadRef, invoiceLine.location);
  });

  it("keeps focus in the code it was opened from once the pick closes the palette", async () => {
    setup();
    const href = window.location.href;
    using _url = { [Symbol.dispose]: () => window.history.replaceState(null, "", href) };
    // Opening the file changes the URL, as the right panel's openFile does.
    mocks.navigateToCodeLocation.mockImplementation(() =>
      window.history.replaceState(null, "", "#billing-models"),
    );
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    using editor = mountCodeEditor();
    editor.focus();

    dispatchCommandPalette({ _tag: "ToggleMode", mode: "classes" });
    await userEvent.type(page.getByPlaceholder("Search classes…"), "InvoiceL");
    await expect
      .element(page.getByRole("option", { name: /billing\/models\.py:53/ }))
      .toBeVisible();
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() =>
      expect(mocks.navigateToCodeLocation).toHaveBeenCalledWith(threadRef, invoiceLine.location),
    );
    await expect.element(page.elementLocator(editor)).toHaveFocus();
  });
});
