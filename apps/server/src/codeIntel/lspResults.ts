/** Reads language server answers as untrusted JSON and maps them to the contract's shapes. */
import type {
  CodeHighlightKind,
  CodePosition,
  CodeRange,
  CodeSymbol,
  CodeSymbolKind,
} from "@t3tools/contracts";

export interface LspLocation {
  readonly uri: string;
  readonly range: CodeRange;
}

export interface LspWorkspaceSymbol {
  readonly name: string;
  readonly kind: CodeSymbolKind;
  readonly containerName: string | undefined;
  readonly location: LspLocation;
}

const MAX_DOCUMENT_SYMBOLS = 5_000;
const MAX_SYMBOL_DEPTH = 32;
const MAX_HOVER_CHARS = 64 * 1024;

// LSP's SymbolKind, 1-based. Kinds the contract does not name are `other`.
const SYMBOL_KINDS: ReadonlyArray<CodeSymbolKind> = [
  "other",
  "file",
  "module",
  "namespace",
  "module",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "other",
  "other",
  "other",
  "other",
  "other",
  "other",
  "other",
  "enumMember",
  "struct",
  "other",
  "other",
  "typeParameter",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const toPosition = (value: unknown): CodePosition | undefined =>
  isRecord(value) && isIndex(value.line) && isIndex(value.character)
    ? { line: value.line, character: value.character }
    : undefined;

export const toRange = (value: unknown): CodeRange | undefined => {
  if (!isRecord(value)) return undefined;
  const start = toPosition(value.start);
  const end = toPosition(value.end);
  return start === undefined || end === undefined ? undefined : { start, end };
};

const toLocation = (value: unknown): LspLocation | undefined => {
  if (!isRecord(value)) return undefined;
  // A link's selection range is the name itself; its full range is the whole declaration.
  const uri = value.targetUri ?? value.uri;
  const range = toRange(value.targetSelectionRange ?? value.targetRange ?? value.range);
  return typeof uri === "string" && range !== undefined ? { uri, range } : undefined;
};

/** `Location | Location[] | LocationLink[] | null`. */
export const toLocations = (result: unknown): ReadonlyArray<LspLocation> =>
  (Array.isArray(result) ? result : [result])
    .map(toLocation)
    .filter((location) => location !== undefined);

export const toSymbolKind = (kind: unknown): CodeSymbolKind =>
  (isIndex(kind) ? SYMBOL_KINDS[kind] : undefined) ?? "other";

/**
 * `DocumentSymbol[]` (a tree) or `SymbolInformation[]` (flat), bounded in size and depth. A flat
 * symbol names its own file: one in another file has no range in this one.
 */
export const toDocumentSymbols = (
  result: unknown,
  documentUri: string,
): ReadonlyArray<CodeSymbol> => {
  let remaining = MAX_DOCUMENT_SYMBOLS;
  const convert = (values: unknown, depth: number): Array<CodeSymbol> => {
    if (!Array.isArray(values) || depth > MAX_SYMBOL_DEPTH) return [];
    const symbols: Array<CodeSymbol> = [];
    for (const value of values) {
      if (remaining <= 0) break;
      if (!isRecord(value) || typeof value.name !== "string") continue;
      const flat = toLocation(value.location);
      if (flat !== undefined && flat.uri !== documentUri) continue;
      const range = toRange(value.range) ?? flat?.range;
      if (range === undefined) continue;
      remaining -= 1;
      symbols.push({
        name: value.name,
        ...(typeof value.detail === "string" && value.detail.length > 0
          ? { detail: value.detail }
          : {}),
        kind: toSymbolKind(value.kind),
        range,
        selectionRange: toRange(value.selectionRange) ?? range,
        children: convert(value.children, depth + 1),
      });
    }
    return symbols;
  };
  return convert(result, 0);
};

const markedString = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (!isRecord(value) || typeof value.value !== "string") return undefined;
  // `MarkedString`'s code form; `MarkupContent` carries `kind` and is already text.
  return typeof value.language === "string"
    ? `\`\`\`${value.language}\n${value.value}\n\`\`\``
    : value.value;
};

/** `MarkupContent | MarkedString | MarkedString[]`, as markdown. */
export const toHoverMarkdown = (contents: unknown): string | null => {
  const parts = (Array.isArray(contents) ? contents : [contents])
    .map(markedString)
    .filter((part) => part !== undefined && part.trim().length > 0);
  return parts.length === 0 ? null : parts.join("\n\n").slice(0, MAX_HOVER_CHARS);
};

const HIGHLIGHT_KINDS: Readonly<Record<number, CodeHighlightKind>> = { 2: "read", 3: "write" };

export const toHighlights = (
  result: unknown,
): ReadonlyArray<{ readonly range: CodeRange; readonly kind: CodeHighlightKind }> => {
  if (!Array.isArray(result)) return [];
  const highlights: Array<{ range: CodeRange; kind: CodeHighlightKind }> = [];
  for (const value of result) {
    const range = isRecord(value) ? toRange(value.range) : undefined;
    if (range === undefined || !isRecord(value)) continue;
    highlights.push({
      range,
      kind: (isIndex(value.kind) ? HIGHLIGHT_KINDS[value.kind] : undefined) ?? "text",
    });
  }
  return highlights;
};

/** `SymbolInformation[] | WorkspaceSymbol[]`; a symbol without a range is left out. */
export const toWorkspaceSymbols = (result: unknown): ReadonlyArray<LspWorkspaceSymbol> => {
  if (!Array.isArray(result)) return [];
  const symbols: Array<LspWorkspaceSymbol> = [];
  for (const value of result) {
    if (!isRecord(value) || typeof value.name !== "string") continue;
    const location = toLocation(value.location);
    if (location === undefined) continue;
    symbols.push({
      name: value.name,
      kind: toSymbolKind(value.kind),
      containerName:
        typeof value.containerName === "string" && value.containerName.length > 0
          ? value.containerName
          : undefined,
      location,
    });
  }
  return symbols;
};

/** Exact name first, then names that start with the query, then the rest, each in server order. */
export const rankWorkspaceSymbols = <S extends { readonly name: string }>(
  symbols: ReadonlyArray<S>,
  query: string,
): ReadonlyArray<S> => {
  if (query.length === 0) return symbols;
  const lowerQuery = query.toLowerCase();
  const rank = (name: string) => {
    if (name === query) return 0;
    const lowerName = name.toLowerCase();
    if (lowerName === lowerQuery) return 1;
    if (name.startsWith(query)) return 2;
    return lowerName.startsWith(lowerQuery) ? 3 : 4;
  };
  return symbols
    .map((symbol, index) => ({ symbol, index, rank: rank(symbol.name) }))
    .toSorted((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ symbol }) => symbol);
};

/** `SemanticTokens.data`: five non-negative integers a token; anything else is no tokens. */
export const toSemanticTokenData = (result: unknown): ReadonlyArray<number> => {
  const data = isRecord(result) ? result.data : undefined;
  return Array.isArray(data) && data.length % 5 === 0 && data.every(isIndex) ? data : [];
};

export const toSemanticTokensLegend = (
  provider: unknown,
):
  | { readonly tokenTypes: ReadonlyArray<string>; readonly tokenModifiers: ReadonlyArray<string> }
  | undefined => {
  const legend = isRecord(provider) ? provider.legend : undefined;
  if (!isRecord(legend)) return undefined;
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  return { tokenTypes: strings(legend.tokenTypes), tokenModifiers: strings(legend.tokenModifiers) };
};

export const supportsRange = (provider: unknown): boolean =>
  isRecord(provider) && provider.range !== undefined && provider.range !== false;
