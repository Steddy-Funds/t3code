import { isCodeIntelUnsupportedError } from "@t3tools/client-runtime/state/code-intel";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  CodeIntelError,
  type CodeIntelErrorReason,
  type CodeLocation,
  type CodePosition,
  type CodeRange,
} from "@t3tools/contracts";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { fileExtension } from "./codeLanguages";

const WORD_CHARACTER = /[\p{L}\p{N}_$]/u;

/** The word around `index`, or null when `index` is not on a word character. */
export function wordAt(text: string, index: number): { start: number; end: number } | null {
  if (index < 0 || index >= text.length || !WORD_CHARACTER.test(text[index]!)) return null;
  let start = index;
  while (start > 0 && WORD_CHARACTER.test(text[start - 1]!)) start -= 1;
  let end = index + 1;
  while (end < text.length && WORD_CHARACTER.test(text[end]!)) end += 1;
  return { start, end };
}

function lineOf(text: string, line: number): string | null {
  let start = 0;
  for (let current = 0; current < line; current += 1) {
    const next = text.indexOf("\n", start);
    if (next === -1) return null;
    start = next + 1;
  }
  const end = text.indexOf("\n", start);
  return text.slice(start, end === -1 ? text.length : end).replace(/\r$/, "");
}

/** Whether a position asked against `before` still means the same line in `after`. */
export function isLineUnchanged(before: string, after: string, line: number): boolean {
  const kept = lineOf(before, line);
  return kept !== null && kept === lineOf(after, line);
}

/** The word at a caret, which may sit just after it. */
export function wordAtPosition(text: string, position: CodePosition): string | null {
  const line = lineOf(text, position.line);
  if (line === null) return null;
  const word = wordAt(line, position.character) ?? wordAt(line, position.character - 1);
  return word === null ? null : line.slice(word.start, word.end);
}

function comparePositions(a: CodePosition, b: CodePosition): number {
  return a.line === b.line ? a.character - b.character : a.line - b.line;
}

/** Inclusive of the end, so a caret just after a name is on it. */
function rangeContains(range: CodeRange, position: CodePosition): boolean {
  return comparePositions(range.start, position) <= 0 && comparePositions(position, range.end) <= 0;
}

export function isSameFile(a: string, b: string, cwd: string): boolean {
  return resolvePathLinkTarget(a, cwd) === resolvePathLinkTarget(b, cwd);
}

/** Go to declaration on the declaration itself shows its usages instead. */
export function isOwnDeclaration(
  locations: ReadonlyArray<CodeLocation>,
  path: string,
  cwd: string,
  position: CodePosition,
): boolean {
  return locations.some(
    (location) => isSameFile(location.path, path, cwd) && rangeContains(location.range, position),
  );
}

export interface CodeLocationGroup {
  readonly path: string;
  readonly locations: ReadonlyArray<CodeLocation>;
}

/** Groups by file in first-seen order, which is the server's ranking. */
export function groupLocationsByFile(
  locations: ReadonlyArray<CodeLocation>,
): ReadonlyArray<CodeLocationGroup> {
  const groups = new Map<string, CodeLocation[]>();
  for (const location of locations) {
    const group = groups.get(location.path);
    if (group) group.push(location);
    else groups.set(location.path, [location]);
  }
  return Array.from(groups, ([path, grouped]) => ({ path, locations: grouped }));
}

export function filterLocations(
  locations: ReadonlyArray<CodeLocation>,
  query: string,
): ReadonlyArray<CodeLocation> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return locations;
  return locations.filter(
    (location) =>
      location.path.toLowerCase().includes(needle) ||
      (location.lineText?.toLowerCase().includes(needle) ?? false),
  );
}

interface TextSearchMatch {
  readonly path: string;
  readonly lineNumber: number;
  readonly lineContent: string;
  readonly matchRanges: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

/** Project text matches, shown as usages when no language server covers the file. */
export function textMatchLocations(
  matches: ReadonlyArray<TextSearchMatch>,
): ReadonlyArray<CodeLocation> {
  return matches.flatMap((match) =>
    match.matchRanges.map((range) => ({
      path: match.path,
      external: false,
      lineText: match.lineContent,
      range: {
        start: { line: match.lineNumber - 1, character: range.start },
        end: { line: match.lineNumber - 1, character: range.end },
      },
    })),
  );
}

const DEFINITION_EXCERPT_LINES = 20;

/** The lines a quick definition shows, from the declaration down. */
export function definitionExcerpt(contents: string, range: CodeRange): string {
  const lines = contents.split(/\r?\n/);
  const excerpt = lines.slice(range.start.line, range.start.line + DEFINITION_EXCERPT_LINES);
  while (excerpt.length > 1 && excerpt.at(-1)!.trim() === "") excerpt.pop();
  return excerpt.join("\n");
}

const FENCE_LANGUAGE: Record<string, string> = {
  py: "python",
  pyi: "python",
  mjs: "js",
  cjs: "js",
  mts: "ts",
  cts: "ts",
};

function fenceLanguage(path: string): string {
  const extension = fileExtension(path);
  return FENCE_LANGUAGE[extension] ?? extension;
}

/** Markdown for a code excerpt; the fence outgrows any backtick run inside it. */
export function fencedCode(code: string, path: string): string {
  const longestRun = Math.max(0, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${fenceLanguage(path)}\n${code}\n${fence}`;
}

/** `line` or `line:column`, one-based as typed; null when it is not a line in the file. */
export function parseGoToLine(input: string, lineCount: number): CodePosition | null {
  const match = /^\s*(\d+)\s*(?:[:,]\s*(\d+)\s*)?$/.exec(input);
  if (!match) return null;
  const line = Number(match[1]);
  if (line < 1 || line > lineCount) return null;
  const column = match[2] === undefined ? 1 : Math.max(1, Number(match[2]));
  return { line: line - 1, character: column - 1 };
}

export type CodeIntelOutcome<A> =
  | { readonly _tag: "answer"; readonly value: A }
  | { readonly _tag: "interrupted" }
  | { readonly _tag: "unsupported" }
  | { readonly _tag: "failed"; readonly reason: CodeIntelErrorReason; readonly message: string }
  | { readonly _tag: "defect"; readonly message: string };

const isCodeIntelError = Schema.is(CodeIntelError);

export function codeIntelOutcome<A>(result: AtomCommandResult<A, unknown>): CodeIntelOutcome<A> {
  if (result._tag === "Success") return { _tag: "answer", value: result.value };
  if (Cause.hasInterruptsOnly(result.cause)) return { _tag: "interrupted" };
  const error = Option.getOrNull(Cause.findErrorOption(result.cause));
  if (isCodeIntelUnsupportedError(error)) return { _tag: "unsupported" };
  if (isCodeIntelError(error)) {
    return { _tag: "failed", reason: error.reason, message: error.message };
  }
  const squashed = Cause.squash(result.cause);
  return {
    _tag: "defect",
    message:
      squashed instanceof Error && squashed.message.trim() !== ""
        ? squashed.message
        : "The language server request failed",
  };
}
