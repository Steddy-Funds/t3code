import type { CodeRange, CodeSemanticTokensLegend } from "@t3tools/contracts";
import { semanticTokenStyle, type ThemeEditorColors } from "@t3tools/shared/themePalettes";

/** One token of a line: its UTF-16 columns and its indexes into the server's legend. */
export interface SemanticToken {
  readonly start: number;
  readonly length: number;
  readonly type: number;
  readonly modifiers: number;
}

/** Tokens by zero-based line, each line's in column order. */
export type SemanticTokenLines = Map<number, SemanticToken[]>;

/** Decodes LSP's packed relative encoding: five integers a token, positioned from the one before. */
export function decodeSemanticTokens(data: ReadonlyArray<number>): SemanticTokenLines {
  const lines: SemanticTokenLines = new Map();
  let line = 0;
  let start = 0;
  for (let index = 0; index + 4 < data.length; index += 5) {
    const deltaLine = data[index]!;
    line += deltaLine;
    start = deltaLine === 0 ? start + data[index + 1]! : data[index + 1]!;
    const token = {
      start,
      length: data[index + 2]!,
      type: data[index + 3]!,
      modifiers: data[index + 4]!,
    };
    const tokens = lines.get(line);
    if (tokens) tokens.push(token);
    else lines.set(line, [token]);
  }
  return lines;
}

/** Adds `more` to `into`; a line answered twice keeps its newer tokens. */
export function mergeSemanticTokens(into: SemanticTokenLines, more: SemanticTokenLines): void {
  for (const [line, tokens] of more) into.set(line, tokens);
}

// ty says `definition` where TypeScript says `declaration`, and marks no builtins; TypeScript's
// `defaultLibrary` is the theme's `builtin`.
const MODIFIER_ALIASES: Readonly<Record<string, string>> = {
  definition: "declaration",
  defaultLibrary: "builtin",
};

function modifierNames(legend: CodeSemanticTokensLegend, bits: number): string[] {
  const names: string[] = [];
  legend.tokenModifiers.forEach((name, bit) => {
    if (bits & (1 << bit)) names.push(MODIFIER_ALIASES[name] ?? name);
  });
  return names;
}

export function hasSemanticColors(theme: ThemeEditorColors | null): theme is ThemeEditorColors {
  return theme !== null && Object.keys(theme.semantic).length > 0;
}

export function supportsSemanticHighlighting(): boolean {
  return (
    typeof Highlight !== "undefined" &&
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof ShadowRoot !== "undefined" &&
    "adoptedStyleSheets" in ShadowRoot.prototype
  );
}

/** Under D1's link, target and usage highlights (0) and Pierre's in-file find (0 and 1). */
export const SEMANTIC_HIGHLIGHT_PRIORITY = -1;

interface HighlightRegistry {
  readonly sheet: CSSStyleSheet;
  readonly byColor: Map<string, Highlight>;
}

let registry: HighlightRegistry | null = null;

function highlightRegistry(): HighlightRegistry {
  registry ??= { sheet: new CSSStyleSheet(), byColor: new Map() };
  return registry;
}

/**
 * One document-wide highlight per colour, shared by every viewer, and its `::highlight()` rule.
 * Highlights paint only colour and decorations, so a theme's italic and bold are not drawn.
 */
function highlightForColor(color: string): Highlight | null {
  const { sheet, byColor } = highlightRegistry();
  const existing = byColor.get(color);
  if (existing) return existing;
  if (!CSS.supports("color", color)) return null;
  const name = `t3-semantic-${byColor.size}`;
  const highlight = new Highlight();
  highlight.priority = SEMANTIC_HIGHLIGHT_PRIORITY;
  sheet.insertRule(`::highlight(${name}) { color: ${color}; }`, sheet.cssRules.length);
  CSS.highlights.set(name, highlight);
  byColor.set(color, highlight);
  return highlight;
}

/** Puts the semantic `::highlight()` rules into a viewer's shadow root, once. */
export function adoptSemanticHighlightStyles(root: ShadowRoot): void {
  const { sheet } = highlightRegistry();
  if (!root.adoptedStyleSheets.includes(sheet)) {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
  }
}

export type SemanticHighlightOf = (token: SemanticToken) => Highlight | null;

/** The highlight a theme gives each token, cached per type and modifier set. */
export function semanticHighlightResolver(
  theme: ThemeEditorColors,
  legend: CodeSemanticTokensLegend,
): SemanticHighlightOf {
  const cache = new Map<string, Highlight | null>();
  return (token) => {
    const key = `${token.type}:${token.modifiers}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const type = legend.tokenTypes[token.type];
    const style =
      type === undefined
        ? null
        : semanticTokenStyle(theme, type, modifierNames(legend, token.modifiers));
    const highlight = style === null ? null : highlightForColor(style.color);
    cache.set(key, highlight);
    return highlight;
  };
}

/** Splits a text into lines as the viewer numbers them, without line endings. */
export function textLines(text: string): string[] {
  return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Where each line of `after` was in `before`, for the lines an edit left alone: those above the
 * first changed line and below the last. Lines in between have no counterpart (null).
 */
export function unchangedLineMap(
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): (line: number) => number | null {
  const shorter = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shorter && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const delta = after.length - before.length;
  return (line) => {
    if (line < 0 || line >= after.length) return null;
    if (line < prefix) return line;
    if (line >= after.length - suffix) return line - delta;
    return null;
  };
}

/** Files up to this many lines are asked for whole; longer ones by the chunks on screen. */
export const WHOLE_DOCUMENT_MAX_LINES = 3_000;
const CHUNK_LINES = 1_000;

export function semanticChunksFor(firstLine: number, lastLine: number): number[] {
  const chunks: number[] = [];
  for (
    let chunk = Math.floor(firstLine / CHUNK_LINES);
    chunk * CHUNK_LINES <= lastLine;
    chunk += 1
  ) {
    chunks.push(chunk);
  }
  return chunks;
}

export function semanticChunkRange(chunk: number): CodeRange {
  return {
    start: { line: chunk * CHUNK_LINES, character: 0 },
    end: { line: (chunk + 1) * CHUNK_LINES, character: 0 },
  };
}

/** A rendered row's source: the line text the tokens were computed for, and those tokens. */
export interface SemanticRowSource {
  readonly text: string;
  readonly tokens: ReadonlyArray<SemanticToken>;
}

interface TextPiece {
  readonly node: Text;
  readonly start: number;
}

function pieceAt(pieces: ReadonlyArray<TextPiece>, offset: number, isEnd: boolean) {
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index]!;
    if (isEnd ? offset > piece.start : offset >= piece.start) {
      return { node: piece.node, offset: offset - piece.start };
    }
  }
  return null;
}

/** The zero-based lines of the rows Pierre has rendered, first and last; null for none. */
export function renderedLineSpan(root: ParentNode): { first: number; last: number } | null {
  const rows = root.querySelectorAll("[data-line]");
  if (rows.length === 0) return null;
  const lineOf = (row: Element) => Number(row.getAttribute("data-line")) - 1;
  return { first: lineOf(rows[0]!), last: lineOf(rows[rows.length - 1]!) };
}

/**
 * Paints semantic colours over a viewer's rendered rows through shared highlights, and takes back
 * only its own ranges. A row whose text is not the text its tokens were computed for stays as the
 * lexer drew it, so a token is never drawn at another text's offsets.
 */
export class SemanticHighlighter {
  #painted: Array<readonly [Highlight, Range]> = [];

  clear(): void {
    for (const [highlight, range] of this.#painted) highlight.delete(range);
    this.#painted = [];
  }

  paint(
    root: ParentNode,
    sourceOf: (line: number) => SemanticRowSource | null,
    highlightOf: SemanticHighlightOf,
  ): void {
    this.clear();
    for (const row of root.querySelectorAll("[data-line]")) {
      const source = sourceOf(Number(row.getAttribute("data-line")) - 1);
      if (source !== null) this.#paintRow(row, source, highlightOf);
    }
  }

  #paintRow(row: Element, source: SemanticRowSource, highlightOf: SemanticHighlightOf): void {
    const pieces: TextPiece[] = [];
    let text = "";
    const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const piece = node as Text;
      pieces.push({ node: piece, start: text.length });
      text += piece.data;
    }
    // An empty row renders a lone newline.
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (text !== source.text) return;
    for (const token of source.tokens) {
      const highlight = highlightOf(token);
      // Tokens never span lines here (no multiline support is offered); clip one that claims to.
      const end = Math.min(token.start + token.length, text.length);
      if (highlight === null || token.start >= end) continue;
      const from = pieceAt(pieces, token.start, false);
      const to = pieceAt(pieces, end, true);
      if (from === null || to === null) continue;
      const range = row.ownerDocument.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      highlight.add(range);
      this.#painted.push([highlight, range]);
    }
  }
}
