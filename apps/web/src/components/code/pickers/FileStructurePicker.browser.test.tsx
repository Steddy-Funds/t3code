import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import type { CommandHandlers } from "~/shortcuts/dispatcher";

import { render } from "../../../../test/render";
import { CommandDialog, CommandDialogPopup } from "../../ui/command";

const mocks = vi.hoisted(() => ({
  handlers: [] as Array<CommandHandlers>,
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
// The outline is still loading: the popup renders on the document read at the key.
vi.mock(import("./documentSymbols"), () => ({
  documentSymbolsFor: (() => new Promise(() => undefined)) as never,
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
});
