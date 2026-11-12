import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type CodeSymbol, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { CommandHandlers } from "~/shortcuts/dispatcher";

import { render } from "../../../../test/render";
import { CommandDialog, CommandDialogPopup } from "../../ui/command";

const mocks = vi.hoisted(() => ({
  handlers: [] as Array<CommandHandlers>,
  // The language server's answer; null is still loading.
  outline: null as Promise<unknown> | null,
}));

vi.mock(import("~/shortcuts/dispatcher"), async (original) => ({
  ...(await original()),
  registerCommands: ((commands: CommandHandlers) => {
    mocks.handlers.push(commands);
    return () => undefined;
  }) as never,
}));
vi.mock(import("~/state/codeIntel"), () => ({
  codeIntelEnvironment: {
    status: (request: unknown) => ({ rpc: "status", request }),
  } as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    error: null,
    failure: null,
    isPending: true,
    dataUpdatedAt: 0,
  })) as never,
}));
// Unless a test answers, the outline is still loading: the popup renders on the document read at the key.
vi.mock(import("./documentSymbols"), () => ({
  documentSymbolsFor: (() => mocks.outline ?? new Promise(() => undefined)) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make([]) as never };
});

import { type CodeViewerDocument, registerCodeViewer } from "../navigation";
import { useCodeSymbolCommands } from "./codeSymbolCommands";
import { FileStructurePicker } from "./FileStructurePicker";

const threadRef = scopeThreadRef(EnvironmentId.make("env-structure"), ThreadId.make("thread-1"));

const DOCUMENT: CodeViewerDocument = {
  environmentId: threadRef.environmentId,
  cwd: "/work/shop",
  path: "billing/models.py",
  text: "class Invoice:\n    pass\n",
  unsaved: false,
  position: { line: 0, character: 6 },
};

function setup() {
  mocks.handlers.length = 0;
  mocks.outline = null;
}

function symbol(
  name: string,
  kind: CodeSymbol["kind"],
  lines: readonly [start: number, end: number],
  children: ReadonlyArray<CodeSymbol> = [],
): CodeSymbol {
  return {
    name,
    kind,
    range: { start: { line: lines[0], character: 0 }, end: { line: lines[1], character: 1 } },
    selectionRange: {
      start: { line: lines[0], character: 6 },
      end: { line: lines[0], character: 6 + name.length },
    },
    children,
  };
}

// The file viewer registers itself with its document as an effect event, as useCodeNavigation does.
function CodeViewerHarness(props: { readonly element: HTMLElement }) {
  const document = useEffectEvent(() => DOCUMENT);
  useCodeSymbolCommands(null);
  useEffect(
    () => registerCodeViewer({ element: props.element, threadRef, location: () => null, document }),
    [props.element],
  );
  return null;
}

function mountCodeSurface() {
  const surface = document.createElement("div");
  surface.tabIndex = -1;
  document.body.append(surface);
  return Object.assign(surface, { [Symbol.dispose]: () => surface.remove() });
}

describe("File structure", () => {
  it("opens over the focused code without reading the viewer while it renders", async () => {
    setup();
    using surface = mountCodeSurface();
    await using screen = await render(<CodeViewerHarness element={surface} />);
    surface.focus();

    const open = mocks.handlers.findLast((handlers) => handlers["code.fileStructure"]);
    open?.["code.fileStructure"]?.(new KeyboardEvent("keydown", { key: "F12", ctrlKey: true }));
    await screen.rerender(
      <>
        <CodeViewerHarness element={surface} />
        <CommandDialog open>
          <CommandDialogPopup aria-label="File structure">
            <FileStructurePicker setOpen={vi.fn()} />
          </CommandDialogPopup>
        </CommandDialog>
      </>,
    );

    await expect.element(page.getByTestId("code-structure-picker")).toBeVisible();
  });

  async function openStructure(screen: Awaited<ReturnType<typeof render>>, surface: HTMLElement) {
    surface.focus();
    const open = mocks.handlers.findLast((handlers) => handlers["code.fileStructure"]);
    open?.["code.fileStructure"]?.(new KeyboardEvent("keydown", { key: "F12", ctrlKey: true }));
    await screen.rerender(
      <>
        <CodeViewerHarness element={surface} />
        <CommandDialog open>
          <CommandDialogPopup aria-label="File structure">
            <FileStructurePicker setOpen={vi.fn()} />
          </CommandDialogPopup>
        </CommandDialog>
      </>,
    );
  }

  const footerHint = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[data-slot="kbd-group"]')].find((group) =>
      group.textContent?.startsWith(label),
    )!;
  const enterShown = () => {
    const hint = footerHint("Enter");
    return !hint.classList.contains("invisible") && !hint.hasAttribute("aria-hidden");
  };

  it.each([
    ["the outline is loading", null, "Loading structure…"],
    [
      "there is no language server",
      Promise.resolve({ _tag: "message", message: "No language server for this file" }),
      "No language server for this file",
    ],
    ["no file is shown", Promise.resolve({ _tag: "none" }), "Open a file to see its structure."],
    [
      "the file has no symbols",
      Promise.resolve({ _tag: "symbols", symbols: [], document: DOCUMENT }),
      "No symbols in this file",
    ],
  ])("keeps the Enter hint hidden, in its place, while %s", async (_name, answer, message) => {
    setup();
    mocks.outline = answer;
    using surface = mountCodeSurface();
    await using screen = await render(<CodeViewerHarness element={surface} />);
    await openStructure(screen, surface);

    await expect.element(page.getByText(message)).toBeVisible();
    expect(footerHint("Enter").textContent).toBe("EnterGo to");
    expect(enterShown()).toBe(false);
  });

  it("shows the Enter hint on a match, also when only a member matches, and hides it on none", async () => {
    setup();
    mocks.outline = Promise.resolve({
      _tag: "symbols",
      document: DOCUMENT,
      symbols: [symbol("Invoice", "class", [0, 9], [symbol("total", "method", [2, 4])])],
    });
    using surface = mountCodeSurface();
    await using screen = await render(<CodeViewerHarness element={surface} />);
    await openStructure(screen, surface);
    const input = page.getByPlaceholder("Filter models.py…");

    await expect.element(page.getByRole("option", { name: /Invoice/ })).toBeVisible();
    expect(enterShown()).toBe(true);
    const escLeft = footerHint("Esc").getBoundingClientRect().left;

    // "Invoice" is only context here, which Enter cannot open; the member is what it opens.
    await userEvent.type(input, "total");
    await vi.waitFor(() => expect(page.getByRole("option").elements()).toHaveLength(1));
    expect(enterShown()).toBe(true);

    await userEvent.type(input, "zz");
    await expect.element(page.getByText("No symbols match")).toBeVisible();
    expect(enterShown()).toBe(false);
    expect(footerHint("Esc").getBoundingClientRect().left).toBe(escLeft);

    await userEvent.clear(input);
    await vi.waitFor(() => expect(enterShown()).toBe(true));
  });
});
