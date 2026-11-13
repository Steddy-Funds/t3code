/** A run of lines a diff removed or added together. */
export interface DiffLineRun {
  /** The file line number of the first line, 1-based. */
  readonly startLine: number;
  readonly lines: ReadonlyArray<string>;
  /**
   * The change the run belongs to. A removed and an added run of one file under the same block
   * replaced each other in place, so a match between them is an edit, not a move.
   */
  readonly block: number;
}

export interface DiffMoveFile {
  readonly path: string;
  readonly removed: ReadonlyArray<DiffLineRun>;
  readonly added: ReadonlyArray<DiffLineRun>;
}

/** Lines of one file, 1-based and inclusive. */
export interface DiffMoveEnd {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** Removed lines that reappear unchanged, apart from indentation. A split is several moves. */
export interface DiffMove {
  readonly from: DiffMoveEnd;
  readonly to: DiffMoveEnd;
}

/** Below these, braces, blank lines and one-liners would match all over a diff. */
const MIN_MOVE_LINES = 3;
const MIN_MOVE_CHARACTERS = 40;
/** A line this common in the added code ("}", "return;") starts no match, though one may cross it. */
const MAX_SEED_CANDIDATES = 16;
/** Past this many changed lines the diff is a rewrite or generated code; matching it says little. */
const MAX_MOVE_DETECTION_LINES = 20_000;

/** Blank lines share this key. One never starts a match, though a match may cross it. */
const BLANK = 0;

interface FlatLine {
  /** The trimmed text as a number: equal lines share one. */
  readonly key: number;
  readonly weight: number;
  readonly file: number;
  /** Unique across the diff: a match never runs from one run into the next. */
  readonly run: number;
  readonly block: number;
  readonly lineNumber: number;
}

function flatten(
  files: ReadonlyArray<DiffMoveFile>,
  side: "removed" | "added",
  keys: Map<string, number>,
): FlatLine[] {
  const lines: FlatLine[] = [];
  let run = 0;
  files.forEach((file, fileIndex) => {
    for (const lineRun of file[side]) {
      lineRun.lines.forEach((raw, offset) => {
        const text = raw.trim();
        let key = text.length === 0 ? BLANK : keys.get(text);
        if (key === undefined) {
          key = keys.size + 1;
          keys.set(text, key);
        }
        lines.push({
          key,
          weight: text.replace(/\s/g, "").length,
          file: fileIndex,
          run,
          block: lineRun.block,
          lineNumber: lineRun.startLine + offset,
        });
      });
      run += 1;
    }
  });
  return lines;
}

interface Segment {
  readonly removed: number;
  readonly added: number;
  readonly length: number;
  readonly weight: number;
  /** Lines one change rewrote where they stood: they claim their lines, but moved nowhere. */
  readonly inPlace: boolean;
}

function continues(removed: FlatLine[], added: FlatLine[], r: number, a: number, step: 1 | -1) {
  const nextRemoved = removed[r + step];
  const nextAdded = added[a + step];
  return (
    nextRemoved !== undefined &&
    nextAdded !== undefined &&
    nextRemoved.run === removed[r]!.run &&
    nextAdded.run === added[a]!.run &&
    nextRemoved.key === nextAdded.key
  );
}

/** Every longest run of equal lines between a removed and an added run. */
function matchingSegments(removed: FlatLine[], added: FlatLine[]): Segment[] {
  const addedByKey = new Map<number, number[]>();
  added.forEach((line, index) => {
    if (line.key === BLANK) return;
    const indices = addedByKey.get(line.key);
    if (indices) indices.push(index);
    else addedByKey.set(line.key, [index]);
  });
  const seedsOf = (r: number) => {
    const key = removed[r]?.key ?? BLANK;
    const candidates = key === BLANK ? undefined : addedByKey.get(key);
    return candidates && candidates.length <= MAX_SEED_CANDIDATES ? candidates : undefined;
  };
  const segments: Segment[] = [];
  removed.forEach((_, seed) => {
    for (const candidate of seedsOf(seed) ?? []) {
      let r = seed;
      let a = candidate;
      let walked = false;
      while (!walked && continues(removed, added, r, a, -1)) {
        r -= 1;
        a -= 1;
        // A seed further up this diagonal walks all of it.
        walked = seedsOf(r) !== undefined;
      }
      if (walked) continue;
      let length = 0;
      let weight = 0;
      do {
        weight += removed[r + length]!.weight;
        length += 1;
      } while (continues(removed, added, r + length - 1, a + length - 1, 1));
      // Blank edges carry no code; trimmed, two pieces of a split don't fight over the line between.
      while (length > 0 && removed[r]!.weight === 0) {
        r += 1;
        a += 1;
        length -= 1;
      }
      while (length > 0 && removed[r + length - 1]!.weight === 0) length -= 1;
      if (length >= MIN_MOVE_LINES && weight >= MIN_MOVE_CHARACTERS) {
        const inPlace =
          removed[r]!.file === added[a]!.file && removed[r]!.block === added[a]!.block;
        segments.push({ removed: r, added: a, length, weight, inPlace });
      }
    }
  });
  return segments;
}

function overlaps(taken: Uint8Array, start: number, length: number): boolean {
  for (let index = start; index < start + length; index += 1) if (taken[index]) return true;
  return false;
}

function spansMeet(start: number, length: number, otherStart: number, otherLength: number) {
  return start < otherStart + otherLength && otherStart < start + length;
}

function take(taken: Uint8Array, start: number, length: number) {
  taken.fill(1, start, start + length);
}

/**
 * The blocks of code a diff moved, within a file or to another one. Lines compare without their
 * indentation. The heaviest matches win; a block that fits two places equally well is left out,
 * since no pointer beats a wrong one.
 */
export function findDiffMoves(files: ReadonlyArray<DiffMoveFile>): DiffMove[] {
  let changedLines = 0;
  for (const file of files) {
    for (const lineRun of [...file.removed, ...file.added]) changedLines += lineRun.lines.length;
  }
  if (changedLines > MAX_MOVE_DETECTION_LINES) return [];
  const keys = new Map<string, number>();
  const removed = flatten(files, "removed", keys);
  const added = flatten(files, "added", keys);
  const segments = matchingSegments(removed, added).sort(
    (left, right) => right.weight - left.weight || left.removed - right.removed,
  );
  const takenRemoved = new Uint8Array(removed.length);
  const takenAdded = new Uint8Array(added.length);
  const free = (segment: Segment) =>
    !overlaps(takenRemoved, segment.removed, segment.length) &&
    !overlaps(takenAdded, segment.added, segment.length);
  const moves: DiffMove[] = [];
  segments.forEach((segment, index) => {
    if (!free(segment)) return;
    // Sorted by weight, so a rival sits among the neighbours of equal weight.
    const claimed = [segment];
    for (let other = index + 1; segments[other]?.weight === segment.weight; other += 1) {
      const rival = segments[other]!;
      const shares =
        spansMeet(rival.removed, rival.length, segment.removed, segment.length) ||
        spansMeet(rival.added, rival.length, segment.added, segment.length);
      if (shares && free(rival)) claimed.push(rival);
    }
    // A tie claims every end it touches, so no leftover pairing of them reads as unique.
    for (const { removed: r, added: a, length } of claimed) {
      take(takenRemoved, r, length);
      take(takenAdded, a, length);
    }
    if (claimed.length > 1 || segment.inPlace) return;
    const end = (lines: FlatLine[], start: number): DiffMoveEnd => ({
      path: files[lines[start]!.file]!.path,
      startLine: lines[start]!.lineNumber,
      endLine: lines[start + segment.length - 1]!.lineNumber,
    });
    moves.push({ from: end(removed, segment.removed), to: end(added, segment.added) });
  });
  return moves.sort(
    (left, right) =>
      left.from.path.localeCompare(right.from.path) || left.from.startLine - right.from.startLine,
  );
}
