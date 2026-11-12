import type { CSSProperties } from "react";

/** One syntax token of a line: its columns and the inline style the highlighter gave it. */
export interface SbsToken {
  readonly start: number;
  readonly end: number;
  readonly style: string | undefined;
}

/** A column range of a line. `end` is exclusive. */
export type SbsColumnRange = readonly [start: number, end: number];

export interface SbsTextPiece {
  readonly start: number;
  readonly text: string;
  readonly style: string | undefined;
  /** Inside a word-level change. */
  readonly changed: boolean;
  /** Inside a find match: 1, or 2 for the match the find bar is on. */
  readonly match: 0 | 1 | 2;
}

export interface SbsLineMarks {
  readonly changed: ReadonlyArray<SbsColumnRange>;
  readonly matches: ReadonlyArray<SbsColumnRange>;
  readonly currentMatch: SbsColumnRange | null;
}

export const NO_LINE_MARKS: SbsLineMarks = { changed: [], matches: [], currentMatch: null };

function covers(ranges: ReadonlyArray<SbsColumnRange>, column: number): boolean {
  return ranges.some(([start, end]) => start <= column && column < end);
}

/** The line cut wherever a token or a mark starts or ends, so each piece renders as one span. */
export function sbsTextPieces(
  text: string,
  tokens: ReadonlyArray<SbsToken> | null,
  marks: SbsLineMarks,
): ReadonlyArray<SbsTextPiece> {
  const cuts = new Set<number>([0, text.length]);
  const addRange = ([start, end]: SbsColumnRange) => {
    cuts.add(Math.min(Math.max(start, 0), text.length));
    cuts.add(Math.min(Math.max(end, 0), text.length));
  };
  const lineTokens = tokens ?? [];
  for (const token of lineTokens) addRange([token.start, token.end]);
  marks.changed.forEach(addRange);
  marks.matches.forEach(addRange);
  if (marks.currentMatch) addRange(marks.currentMatch);

  const columns = [...cuts].toSorted((left, right) => left - right);
  const pieces: SbsTextPiece[] = [];
  let tokenIndex = 0;
  for (let index = 0; index + 1 < columns.length; index += 1) {
    const start = columns[index]!;
    const end = columns[index + 1]!;
    while (tokenIndex < lineTokens.length && lineTokens[tokenIndex]!.end <= start) tokenIndex += 1;
    const token = lineTokens[tokenIndex];
    pieces.push({
      start,
      text: text.slice(start, end),
      style: token && token.start <= start ? token.style : undefined,
      changed: covers(marks.changed, start),
      match:
        marks.currentMatch && covers([marks.currentMatch], start)
          ? 2
          : covers(marks.matches, start)
            ? 1
            : 0,
    });
  }
  return pieces;
}

interface HastNode {
  readonly type?: unknown;
  readonly tagName?: unknown;
  readonly value?: unknown;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly children?: ReadonlyArray<HastNode>;
}

function hastText(node: HastNode): string {
  if (node.type === "text") return typeof node.value === "string" ? node.value : "";
  return (node.children ?? []).map(hastText).join("");
}

/**
 * The tokens of one row Pierre's worker rendered, one span each; null when it does not spell
 * `text`, so the line falls back to plain text. Whitespace and same-styled neighbours merge into
 * one token: each token is an element to style, which is most of what a scroll costs.
 */
export function sbsTokensFromHast(row: unknown, text: string): ReadonlyArray<SbsToken> | null {
  if (typeof row !== "object" || row === null) return null;
  const tokens: SbsToken[] = [];
  let column = 0;
  for (const child of (row as HastNode).children ?? []) {
    const content = hastText(child);
    if (content.length === 0) continue;
    const raw = child.properties?.style;
    const style = typeof raw === "string" && raw.length > 0 ? raw : undefined;
    const end = column + content.length;
    const previous = tokens.at(-1);
    if (
      previous &&
      (previous.style === style ||
        (content.trim() === "" && !previous.style?.includes("decoration")))
    ) {
      tokens[tokens.length - 1] = { ...previous, end };
    } else {
      tokens.push({ start: column, end, style });
    }
    column = end;
  }
  return column === text.length ? tokens : null;
}

const styleCache = new Map<string, CSSProperties>();

/** An inline style string as React wants it. The highlighter reuses a few dozen strings. */
export function sbsTokenStyle(style: string | undefined): CSSProperties | undefined {
  if (style === undefined) return undefined;
  const cached = styleCache.get(style);
  if (cached) return cached;
  const parsed: Record<string, string> = {};
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator <= 0) continue;
    const name = declaration.slice(0, separator).trim();
    const value = declaration.slice(separator + 1).trim();
    if (!value) continue;
    parsed[
      name.startsWith("--")
        ? name
        : name.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())
    ] = value;
  }
  styleCache.set(style, parsed);
  return parsed;
}
