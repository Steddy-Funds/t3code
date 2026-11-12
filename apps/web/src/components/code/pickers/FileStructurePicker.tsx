import { useEffect, useState } from "react";

import type { CodeServerStatus } from "@t3tools/contracts";

import { codeIntelEnvironment } from "~/state/codeIntel";
import { useEnvironmentQuery } from "~/state/query";

import type { CommandPaletteActionItem } from "../../CommandPalette.logic";
import { serverForPath } from "../codeLanguages";
import { waitingMessage } from "../codeNavigationMessages";
import { navigateToCodeLocation } from "../navigation";
import { CodePicker } from "./CodePicker";
import { fileStructureTarget, jumpWhenPaletteCloses } from "./codeSymbolCommands";
import {
  fileName,
  isServerBusy,
  rowAtPosition,
  structureRows,
  type StructureRow,
} from "./codePickers.logic";
import { type DocumentSymbolsAnswer, documentSymbolsFor } from "./documentSymbols";
import { HighlightedName } from "./HighlightedName";
import { SymbolKindIcon } from "./SymbolKindIcon";

const INDENT_REM = 1;

function rowValue(row: StructureRow): string {
  return `structure:${row.id}`;
}

function emptyMessage(
  answer: DocumentSymbolsAnswer | null,
  query: string,
  server: CodeServerStatus | null,
): string {
  if (answer === null) return isServerBusy(server) ? waitingMessage(server) : "Loading structure…";
  switch (answer._tag) {
    case "none":
      return "Open a file to see its structure.";
    case "message":
      return answer.message;
    case "symbols":
      return query.trim() === "" ? "No symbols in this file" : "No symbols match";
  }
}

/** The outline of the file the focused viewer shows: type to filter, Enter jumps. */
export function FileStructurePicker(props: { readonly setOpen: (open: boolean) => void }) {
  const [target] = useState(fileStructureTarget);
  const viewer = target?.viewer ?? null;
  const opened = target?.document ?? null;
  const [answer, setAnswer] = useState<DocumentSymbolsAnswer | null>(
    viewer === null ? { _tag: "none" } : null,
  );
  const [query, setQuery] = useState("");
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);
  const status = useEnvironmentQuery(
    opened === null
      ? null
      : codeIntelEnvironment.status({
          environmentId: opened.environmentId,
          input: { cwd: opened.cwd },
        }),
  );
  const server = opened === null ? null : serverForPath(status.data?.servers ?? [], opened.path);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the language server for the outline once the popup opens, and drops the answer if it closes first
  useEffect(() => {
    if (viewer === null) return;
    const controller = new AbortController();
    void documentSymbolsFor(viewer, controller.signal).then((next) => {
      if (!controller.signal.aborted) setAnswer(next);
    });
    return () => controller.abort();
  }, [viewer]);

  const symbols = answer?._tag === "symbols" ? answer.symbols : [];
  const document = answer?._tag === "symbols" ? answer.document : null;
  const rows = structureRows(symbols, query);
  const caretRow = rowAtPosition(structureRows(symbols, ""), document?.position ?? null);
  const items: CommandPaletteActionItem[] = rows.map((row) => ({
    kind: "action",
    value: rowValue(row),
    searchTerms: [row.symbol.name],
    title: <HighlightedName name={row.symbol.name} query={row.matches === null ? "" : query} />,
    icon: (
      <span className="flex" style={{ paddingInlineStart: `${row.depth * INDENT_REM}rem` }}>
        <SymbolKindIcon kind={row.symbol.kind} />
      </span>
    ),
    ...(row.symbol.detail
      ? {
          titleTrailingContent: (
            <span className="ms-2 min-w-0 max-w-[50%] truncate text-muted-foreground/70 text-xs">
              {row.symbol.detail}
            </span>
          ),
        }
      : {}),
    disabled: row.matches === null,
    run: async () => {
      if (viewer === null || document === null) return;
      jumpWhenPaletteCloses(() =>
        navigateToCodeLocation(viewer.threadRef, {
          path: document.path,
          external: false,
          range: row.symbol.selectionRange,
        }),
      );
    },
  }));

  return (
    <CodePicker
      label="File structure"
      testId="code-structure-picker"
      placeholder={document === null ? "Filter symbols…" : `Filter ${fileName(document.path)}…`}
      footerActionLabel={answer?._tag === "none" || answer?._tag === "message" ? null : "Go to"}
      escapeLabel="Close"
      query={query}
      onQueryChange={(value) => {
        setQuery(value);
        setHighlightedValue(null);
      }}
      groups={items.length === 0 ? [] : [{ value: "structure", label: "", items }]}
      highlightedValue={highlightedValue}
      initialValue={caretRow === null ? null : rowValue(caretRow)}
      onHighlight={setHighlightedValue}
      emptyStateMessage={emptyMessage(answer, query, server)}
      onExecute={(item) => {
        props.setOpen(false);
        void item.run();
      }}
    />
  );
}
