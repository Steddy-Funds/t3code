import type { CodePosition, CodeRange, CodeSymbol, CodeSymbolKind } from "@t3tools/contracts";

export const CLASS_SYMBOL_KINDS: ReadonlyArray<CodeSymbolKind> = [
  "class",
  "interface",
  "enum",
  "struct",
];
const METHOD_SYMBOL_KINDS: ReadonlySet<CodeSymbolKind> = new Set([
  "method",
  "function",
  "constructor",
]);

export const WORKSPACE_SYMBOL_LIMIT = 100;
export const WORKSPACE_SYMBOL_DEBOUNCE_MS = 150;

/** The query's characters in order in `value`, ignoring case: their indices, or null. */
export function matchIndices(value: string, query: string): ReadonlyArray<number> | null {
  const needle = query.replaceAll(/\s/g, "").toLowerCase();
  if (needle === "") return [];
  const haystack = value.toLowerCase();
  const indices: number[] = [];
  for (let index = 0; index < haystack.length && indices.length < needle.length; index += 1) {
    if (haystack[index] === needle[indices.length]) indices.push(index);
  }
  return indices.length === needle.length ? indices : null;
}

function comparePositions(a: CodePosition, b: CodePosition): number {
  return a.line === b.line ? a.character - b.character : a.line - b.line;
}

function containsPosition(range: CodeRange, position: CodePosition): boolean {
  return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

function bySourceOrder(symbols: ReadonlyArray<CodeSymbol>): ReadonlyArray<CodeSymbol> {
  return symbols.toSorted((a, b) => comparePositions(a.range.start, b.range.start));
}

export interface StructureRow {
  /** The symbol's index path in the tree, stable while the tree is. */
  readonly id: string;
  readonly symbol: CodeSymbol;
  readonly depth: number;
  /** Matched name indices; null for a parent shown only because a child matched. */
  readonly matches: ReadonlyArray<number> | null;
}

/**
 * The file's symbol tree as rows in source order. Filtered, a row stays when its name matches
 * or, as context, when one of its children does.
 */
export function structureRows(
  symbols: ReadonlyArray<CodeSymbol>,
  query: string,
): ReadonlyArray<StructureRow> {
  const rows: StructureRow[] = [];
  const visit = (siblings: ReadonlyArray<CodeSymbol>, depth: number, parentId: string) => {
    bySourceOrder(siblings).forEach((symbol, index) => {
      const id = parentId === "" ? String(index) : `${parentId}.${index}`;
      const at = rows.length;
      const matches = matchIndices(symbol.name, query);
      rows.push({ id, symbol, depth, matches });
      visit(symbol.children, depth + 1, id);
      if (matches === null && rows.length === at + 1) rows.pop();
    });
  };
  visit(symbols, 0, "");
  return rows;
}

/** The innermost row around the caret, else the last one before it, else the first. */
export function rowAtPosition(
  rows: ReadonlyArray<StructureRow>,
  position: CodePosition | null,
): StructureRow | null {
  const selectable = rows.filter((row) => row.matches !== null);
  if (position === null) return selectable[0] ?? null;
  return (
    selectable.findLast((row) => containsPosition(row.symbol.range, position)) ??
    selectable.findLast((row) => comparePositions(row.symbol.range.start, position) <= 0) ??
    selectable[0] ??
    null
  );
}

function methodStarts(symbols: ReadonlyArray<CodeSymbol>): ReadonlyArray<CodePosition> {
  return symbols.flatMap((symbol) => [
    ...(METHOD_SYMBOL_KINDS.has(symbol.kind) ? [symbol.selectionRange.start] : []),
    ...methodStarts(symbol.children),
  ]);
}

/** Where next or previous method moves the caret: the nearest method name past it; null at the end. */
export function methodJumpTarget(
  symbols: ReadonlyArray<CodeSymbol>,
  position: CodePosition | null,
  direction: "next" | "previous",
): CodePosition | null {
  const caret = position ?? { line: 0, character: 0 };
  const starts = methodStarts(symbols).toSorted(comparePositions);
  return direction === "next"
    ? (starts.find((start) => comparePositions(start, caret) > 0) ?? null)
    : (starts.findLast((start) => comparePositions(start, caret) < 0) ?? null);
}

/** Moves a highlight through `count` items, clamped at both ends. */
export function stepHighlight(
  index: number | null,
  count: number,
  step: "next" | "previous" | "pageDown" | "pageUp",
  pageSize = 10,
): number | null {
  if (count === 0) return null;
  if (index === null) return step === "previous" || step === "pageUp" ? count - 1 : 0;
  const delta = { next: 1, previous: -1, pageDown: pageSize, pageUp: -pageSize }[step];
  return Math.min(count - 1, Math.max(0, index + delta));
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function parentFolder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}
