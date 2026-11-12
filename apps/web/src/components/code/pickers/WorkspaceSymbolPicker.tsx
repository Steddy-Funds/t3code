import { isCodeIntelUnsupportedError } from "@t3tools/client-runtime/state/code-intel";
import {
  CodeIntelError,
  type CodeIntelWorkspaceSymbolsResult,
  type CodeServerStatus,
  type CodeWorkspaceSymbol,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { type ActiveProjectTarget, useActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { codeIntelEnvironment } from "~/state/codeIntel";
import { useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";

import type { CommandPaletteActionItem } from "../../CommandPalette.logic";
import { codeIntelFailureMessage, waitingMessage } from "../codeNavigationMessages";
import { navigateToCodeLocation } from "../navigation";
import { CodePicker } from "./CodePicker";
import {
  CLASS_SYMBOL_KINDS,
  WORKSPACE_SYMBOL_DEBOUNCE_MS,
  WORKSPACE_SYMBOL_LIMIT,
} from "./codePickers.logic";
import { HighlightedName } from "./HighlightedName";
import { symbolKindLabel, SymbolKindIcon } from "./SymbolKindIcon";

export type WorkspaceSymbolScope = "classes" | "symbols";

const COPY = {
  classes: { label: "Go to class", placeholder: "Search classes…", noun: "classes" },
  symbols: { label: "Go to symbol", placeholder: "Search symbols…", noun: "symbols" },
} as const;

const isCodeIntelError = Schema.is(CodeIntelError);

const BUSY_STATES: ReadonlySet<CodeServerStatus["state"]> = new Set(["starting", "indexing"]);

interface ShownAnswer {
  readonly query: string;
  readonly result: CodeIntelWorkspaceSymbolsResult;
}

function locationLabel(symbol: CodeWorkspaceSymbol): string {
  return `${symbol.location.path}:${symbol.location.range.start.line + 1}`;
}

/** Project symbols first, each part in the server's ranking. */
function projectFirst(
  symbols: ReadonlyArray<CodeWorkspaceSymbol>,
): ReadonlyArray<CodeWorkspaceSymbol> {
  return [
    ...symbols.filter((symbol) => !symbol.location.external),
    ...symbols.filter((symbol) => symbol.location.external),
  ];
}

function failureMessage(failure: unknown, error: string | null): string | null {
  if (isCodeIntelError(failure)) {
    return codeIntelFailureMessage(failure.reason, failure.message, {
      extension: "",
      server: null,
    });
  }
  return error;
}

function SymbolSearch(props: {
  readonly scope: WorkspaceSymbolScope;
  readonly target: ActiveProjectTarget;
  readonly escapeLabel: "Back" | "Close";
  readonly setOpen: (open: boolean) => void;
}) {
  const { scope, target } = props;
  const copy = COPY[scope];
  const [query, setQuery] = useState("");
  const [highlightedValue, setHighlightedValue] = useState<string | null>(null);
  const [shown, setShown] = useState<ShownAnswer | null>(null);
  const searched = useDebouncedValue(query.trim(), WORKSPACE_SYMBOL_DEBOUNCE_MS);
  const status = useEnvironmentQuery(
    codeIntelEnvironment.status({
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    }),
  );
  const search = useEnvironmentQuery(
    searched === ""
      ? null
      : codeIntelEnvironment.workspaceSymbols({
          environmentId: target.environmentId,
          input: {
            cwd: target.cwd,
            query: searched,
            limit: WORKSPACE_SYMBOL_LIMIT,
            ...(scope === "classes" ? { kinds: CLASS_SYMBOL_KINDS } : {}),
          },
        }),
  );
  // The last answer stays up while the next query runs, so the list never blanks between keys.
  if (search.data !== null && search.data !== shown?.result) {
    setShown({ query: searched, result: search.data });
  }

  const typing = query.trim() !== "";
  const failure =
    search.failure !== null && !isCodeIntelUnsupportedError(search.failure)
      ? failureMessage(search.failure, search.error)
      : null;
  const answer = typing && failure === null ? shown : null;
  const busyServer = (status.data?.servers ?? []).find((server) => BUSY_STATES.has(server.state));
  const items: CommandPaletteActionItem[] = projectFirst(answer?.result.symbols ?? []).map(
    (symbol, index) => ({
      kind: "action",
      value: `symbol:${index}:${symbol.name}:${locationLabel(symbol)}`,
      searchTerms: [symbol.name],
      title: (
        <>
          <HighlightedName name={symbol.name} query={query} />
          {symbol.containerName ? (
            <span className="ms-1.5 text-muted-foreground/70">{symbol.containerName}</span>
          ) : null}
        </>
      ),
      description: locationLabel(symbol),
      icon: <SymbolKindIcon kind={symbol.kind} />,
      titleTrailingContent: (
        <span className="shrink-0 text-muted-foreground/70 text-xs">
          {symbolKindLabel(symbol.kind)}
        </span>
      ),
      run: async () => {
        navigateToCodeLocation(target.threadRef, symbol.location);
      },
    }),
  );

  const emptyStateMessage = !typing
    ? `Type to search ${copy.noun}`
    : failure !== null
      ? failure
      : answer?.query !== query.trim() || search.isPending
        ? busyServer
          ? waitingMessage(busyServer)
          : `Searching ${copy.noun}…`
        : `No ${copy.noun} match`;

  return (
    <CodePicker
      label={copy.label}
      testId={`code-${scope}-picker`}
      placeholder={copy.placeholder}
      footerActionLabel="Open"
      escapeLabel={props.escapeLabel}
      query={query}
      onQueryChange={(value) => {
        setQuery(value);
        setHighlightedValue(null);
      }}
      groups={items.length === 0 ? [] : [{ value: scope, label: "", items }]}
      highlightedValue={highlightedValue}
      onHighlight={setHighlightedValue}
      emptyStateMessage={emptyStateMessage}
      footerTrailing={
        answer?.result.truncated ? (
          <span className="text-muted-foreground text-xs">
            First {WORKSPACE_SYMBOL_LIMIT}. Type more to narrow.
          </span>
        ) : busyServer && items.length > 0 ? (
          <span className="text-muted-foreground text-xs">{waitingMessage(busyServer)}</span>
        ) : null
      }
      onExecute={(item) => {
        props.setOpen(false);
        void item.run();
      }}
    />
  );
}

export function WorkspaceSymbolPicker(props: {
  readonly scope: WorkspaceSymbolScope;
  readonly escapeLabel: "Back" | "Close";
  readonly setOpen: (open: boolean) => void;
}) {
  const target = useActiveProjectTarget();
  if (target === null) {
    const copy = COPY[props.scope];
    return (
      <CodePicker
        label={copy.label}
        testId={`code-${props.scope}-picker`}
        placeholder={copy.placeholder}
        footerActionLabel="Open"
        escapeLabel={props.escapeLabel}
        query=""
        onQueryChange={() => undefined}
        groups={[]}
        highlightedValue={null}
        onHighlight={() => undefined}
        emptyStateMessage={`Open a project to search its ${copy.noun}.`}
        disabled
        onExecute={() => undefined}
      />
    );
  }
  return (
    <SymbolSearch
      key={`${target.environmentId}:${target.cwd}`}
      scope={props.scope}
      target={target}
      escapeLabel={props.escapeLabel}
      setOpen={props.setOpen}
    />
  );
}
