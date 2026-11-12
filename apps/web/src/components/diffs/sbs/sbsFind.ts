/** A match of the find bar's query. `end` is exclusive. */
export interface SbsFindMatch {
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

/** Past this many the bar says so and stops counting: nobody steps through more. */
export const SBS_FIND_MATCH_LIMIT = 5_000;

export interface SbsFindResult {
  readonly matches: ReadonlyArray<SbsFindMatch>;
  readonly truncated: boolean;
}

const NO_MATCHES: SbsFindResult = { matches: [], truncated: false };

let lastSearch: { lines: ReadonlyArray<string>; query: string; result: SbsFindResult } | null =
  null;

/**
 * Every occurrence of the query in the lines, without regard to case, in reading order. The
 * last answer is kept: the view asks again on every render while the find bar is open.
 */
export function sbsFindMatches(lines: ReadonlyArray<string>, query: string): SbsFindResult {
  if (query.length === 0) return NO_MATCHES;
  if (lastSearch?.lines === lines && lastSearch.query === query) return lastSearch.result;
  const result = searchLines(lines, query);
  lastSearch = { lines, query, result };
  return result;
}

const matchesByLine = new WeakMap<SbsFindResult, ReadonlyMap<number, ReadonlyArray<SbsFindMatch>>>();

/** A result's matches under the line each is on. */
export function sbsFindMatchesByLine(
  result: SbsFindResult,
): ReadonlyMap<number, ReadonlyArray<SbsFindMatch>> {
  const cached = matchesByLine.get(result);
  if (cached) return cached;
  const byLine = new Map<number, SbsFindMatch[]>();
  for (const match of result.matches) {
    const matches = byLine.get(match.line);
    if (matches) matches.push(match);
    else byLine.set(match.line, [match]);
  }
  matchesByLine.set(result, byLine);
  return byLine;
}

function searchLines(lines: ReadonlyArray<string>, query: string): SbsFindResult {
  const needle = query.toLowerCase();
  const matches: SbsFindMatch[] = [];
  for (let line = 0; line < lines.length; line += 1) {
    const haystack = lines[line]!.toLowerCase();
    for (
      let start = haystack.indexOf(needle);
      start !== -1;
      start = haystack.indexOf(needle, start + needle.length)
    ) {
      if (matches.length === SBS_FIND_MATCH_LIMIT) return { matches, truncated: true };
      matches.push({ line, start, end: start + needle.length });
    }
  }
  return { matches, truncated: false };
}

/** The match a step lands on, wrapping at either end. */
export function sbsFindStep(current: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1;
  return (current + direction + count) % count;
}
