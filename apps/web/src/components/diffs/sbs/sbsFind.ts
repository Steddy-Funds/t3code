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

/** Every occurrence of the query in the lines, without regard to case, in reading order. */
export function sbsFindMatches(lines: ReadonlyArray<string>, query: string): SbsFindResult {
  if (query.length === 0) return NO_MATCHES;
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
