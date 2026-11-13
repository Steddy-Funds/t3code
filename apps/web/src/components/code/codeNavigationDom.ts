import type { CodePosition, CodeRange } from "@t3tools/contracts";

import { wordAt } from "./codeNavigationModel";

/** A word in the rendered code: where it is in the document and on screen. */
export interface CodeWordHit {
  readonly token: HTMLElement;
  readonly range: CodeRange;
  readonly text: string;
}

export type CodeHighlightName =
  | "t3-code-link"
  | "t3-code-target"
  | "t3-code-usage-text"
  | "t3-code-usage-read"
  | "t3-code-usage-write";

interface TextPiece {
  readonly node: Text;
  readonly start: number;
}

/** Pierre marks each rendered token with `data-char`, its UTF-16 column in the line. */
function tokenStart(token: Element): number | null {
  const value = Number.parseInt(token.getAttribute("data-char") ?? "", 10);
  return Number.isNaN(value) ? null : value;
}

function textPieces(token: Element): TextPiece[] {
  const pieces: TextPiece[] = [];
  const walker = document.createTreeWalker(token, NodeFilter.SHOW_TEXT);
  let start = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    pieces.push({ node: text, start });
    start += text.data.length;
  }
  return pieces;
}

function pointInPieces(pieces: ReadonlyArray<TextPiece>, offset: number) {
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    const piece = pieces[index]!;
    if (offset >= piece.start) {
      return { node: piece.node, offset: Math.min(offset - piece.start, piece.node.data.length) };
    }
  }
  return null;
}

function characterAtPoint(token: Element, x: number, y: number): number | null {
  const pieces = textPieces(token);
  const range = document.createRange();
  for (const piece of pieces) {
    for (let offset = 0; offset < piece.node.data.length; offset += 1) {
      range.setStart(piece.node, offset);
      range.setEnd(piece.node, offset + 1);
      const rect = range.getBoundingClientRect();
      if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
        return piece.start + offset;
      }
    }
  }
  return null;
}

/** The token under the pointer, read while the event dispatches: its path is gone afterwards. */
export interface CodePointerTarget {
  readonly token: HTMLElement;
  readonly line: number;
  readonly x: number;
  readonly y: number;
}

export function pointerTarget(event: MouseEvent): CodePointerTarget | null {
  let token: HTMLElement | null = null;
  for (const target of event.composedPath()) {
    if (!(target instanceof HTMLElement)) continue;
    if (token === null) {
      if (target.hasAttribute("data-char")) token = target;
      continue;
    }
    const line = Number.parseInt(target.getAttribute("data-line") ?? "", 10);
    if (!Number.isNaN(line)) return { token, line: line - 1, x: event.clientX, y: event.clientY };
  }
  return null;
}

/** Where a pointer target is in the document; measures the token, so call it on demand. */
export function positionAtTarget(target: CodePointerTarget): CodePosition | null {
  if (!target.token.isConnected) return null;
  const start = tokenStart(target.token);
  if (start === null) return null;
  const index = characterAtPoint(target.token, target.x, target.y);
  return { line: target.line, character: start + (index ?? 0) };
}

/** The word at a pointer target; measures the token's characters, so call it on demand. */
export function wordAtTarget(target: CodePointerTarget): CodeWordHit | null {
  if (!target.token.isConnected) return null;
  const start = tokenStart(target.token);
  const text = target.token.textContent ?? "";
  if (start === null || text.length === 0) return null;
  const index = characterAtPoint(target.token, target.x, target.y);
  const word = index === null ? null : wordAt(text, index);
  if (word === null) return null;
  return {
    token: target.token,
    text: text.slice(word.start, word.end),
    range: {
      start: { line: target.line, character: start + word.start },
      end: { line: target.line, character: start + word.end },
    },
  };
}

/** A DOM range over a word hit, inside its token: rows can repeat a line number (a diff's sides). */
export function wordHitRange(hit: CodeWordHit): Range | null {
  const start = tokenStart(hit.token);
  if (start === null) return null;
  const pieces = textPieces(hit.token);
  const from = pointInPieces(pieces, hit.range.start.character - start);
  const to = pointInPieces(pieces, hit.range.end.character - start);
  if (from === null || to === null) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

function rowElement(root: ParentNode, line: number): Element | null {
  return root.querySelector(`[data-line="${line + 1}"]`);
}

function tokensOf(row: Element): Array<{ element: Element; start: number; length: number }> {
  return Array.from(row.querySelectorAll("[data-char]"), (element) => ({
    element,
    start: tokenStart(element) ?? 0,
    length: element.textContent?.length ?? 0,
  }));
}

function domPoint(row: Element, character: number) {
  const tokens = tokensOf(row);
  const token =
    tokens.findLast((candidate) => candidate.start <= character) ?? tokens.at(0) ?? null;
  if (token === null) return null;
  return pointInPieces(textPieces(token.element), character - token.start);
}

/** A DOM range over one line of a rendered range; rows outside the viewport give null. */
export function domRangeFor(root: ParentNode, range: CodeRange): Range | null {
  const row = rowElement(root, range.start.line);
  if (row === null) return null;
  const endCharacter =
    range.end.line === range.start.line ? range.end.character : Number.MAX_SAFE_INTEGER;
  const start = domPoint(row, range.start.character);
  const end = domPoint(row, endCharacter);
  if (start === null || end === null) return null;
  const domRange = document.createRange();
  domRange.setStart(start.node, start.offset);
  domRange.setEnd(end.node, end.offset);
  return domRange;
}

/** Where a position is on screen, for anchoring a popup; null when its row is not rendered. */
export function positionRect(root: ParentNode, position: CodePosition): DOMRect | null {
  const range = domRangeFor(root, { start: position, end: position });
  const rect = range?.getBoundingClientRect();
  if (rect && (rect.width > 0 || rect.height > 0)) return rect;
  return rowElement(root, position.line)?.getBoundingClientRect() ?? null;
}

const supportsHighlights = () =>
  typeof Highlight !== "undefined" && typeof CSS !== "undefined" && "highlights" in CSS;

/** Paints ranges through the CSS Custom Highlight API; Pierre's rows stay untouched. */
export function setCodeHighlight(name: CodeHighlightName, ranges: ReadonlyArray<Range>): void {
  if (!supportsHighlights()) return;
  if (ranges.length === 0) CSS.highlights.delete(name);
  else CSS.highlights.set(name, new Highlight(...ranges));
}

/** Marks a view whose words are links under a held Cmd, outside a `code` focus scope (a diff). */
export const CODE_LINKS_ATTRIBUTE = "data-code-links";

export const CODE_NAVIGATION_UNSAFE_CSS = `
  ::highlight(t3-code-link) {
    color: var(--color-blue-500, #3b82f6);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  [data-code-nav-link] {
    cursor: pointer;
  }
  ::highlight(t3-code-target),
  ::highlight(t3-code-usage-text),
  ::highlight(t3-code-usage-read) {
    background-color: light-dark(rgb(59 130 246 / 0.18), rgb(96 165 250 / 0.24));
  }
  ::highlight(t3-code-usage-write) {
    background-color: light-dark(rgb(234 88 12 / 0.2), rgb(251 146 60 / 0.26));
  }
`;
