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
const MAX_SEED_CANDIDATES = 64;
/** Past this many changed lines the diff is a rewrite or generated code; matching it says little. */
export const MAX_MOVE_DETECTION_LINES = 20_000;

interface FlatLine {
  readonly key: string;
  readonly weight: number;
  readonly file: number;
  /** Unique across the diff: a match never runs from one run into the next. */
  readonly run: number;
  readonly block: number;
  readonly lineNumber: number;
}

function flatten(files: ReadonlyArray<DiffMoveFile>, side: "removed" | "added"): FlatLine[] {
  const lines: FlatLine[] = [];
  let run = 0;
  files.forEach((file, fileIndex) => {
    for (const lineRun of file[side]) {
      lineRun.lines.forEach((text, offset) => {
        const key = text.trim();
        lines.push({
          key,
          weight: key.replace(/\s/g, "").length,
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
  const addedByKey = new Map<string, number[]>();
  added.forEach((line, index) => {
    if (line.key.length === 0) return;
    const indices = addedByKey.get(line.key);
    if (indices) indices.push(index);
    else addedByKey.set(line.key, [index]);
  });
  const covered = new Set<number>();
  const pair = (r: number, a: number) => r * added.length + a;
  const segments: Segment[] = [];
  removed.forEach((line, seed) => {
    const candidates = addedByKey.get(line.key);
    if (!candidates || candidates.length > MAX_SEED_CANDIDATES) return;
    for (const candidate of candidates) {
      if (covered.has(pair(seed, candidate))) continue;
      let r = seed;
      let a = candidate;
      while (continues(removed, added, r, a, -1)) {
        r -= 1;
        a -= 1;
      }
      let length = 0;
      let weight = 0;
      for (;;) {
        covered.add(pair(r + length, a + length));
        weight += removed[r + length]!.weight;
        length += 1;
        if (!continues(removed, added, r + length - 1, a + length - 1, 1)) break;
      }
      const inPlace = removed[r]!.file === added[a]!.file && removed[r]!.block === added[a]!.block;
      if (length >= MIN_MOVE_LINES && weight >= MIN_MOVE_CHARACTERS && !inPlace) {
        segments.push({ removed: r, added: a, length, weight });
      }
    }
  });
  return segments;
}

function overlaps(taken: Uint8Array, start: number, length: number): boolean {
  for (let index = start; index < start + length; index += 1) if (taken[index]) return true;
  return false;
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
  const removed = flatten(files, "removed");
  const added = flatten(files, "added");
  if (removed.length + added.length > MAX_MOVE_DETECTION_LINES) return [];
  const segments = matchingSegments(removed, added).toSorted(
    (left, right) => right.weight - left.weight || left.removed - right.removed,
  );
  const takenRemoved = new Uint8Array(removed.length);
  const takenAdded = new Uint8Array(added.length);
  const moves: DiffMove[] = [];
  const isRival = (segment: Segment, other: Segment | undefined) =>
    other !== undefined &&
    other.weight === segment.weight &&
    (other.removed === segment.removed || other.added === segment.added) &&
    !overlaps(takenRemoved, other.removed, other.length) &&
    !overlaps(takenAdded, other.added, other.length);
  segments.forEach((segment, index) => {
    if (overlaps(takenRemoved, segment.removed, segment.length)) return;
    if (overlaps(takenAdded, segment.added, segment.length)) return;
    // Sorted by weight, so a rival sits among the neighbours of equal weight.
    let rival = false;
    for (let other = index + 1; !rival && segments[other]?.weight === segment.weight; other += 1) {
      rival = isRival(segment, segments[other]);
    }
    take(takenRemoved, segment.removed, segment.length);
    take(takenAdded, segment.added, segment.length);
    if (rival) return;
    const end = (lines: FlatLine[], start: number): DiffMoveEnd => ({
      path: files[lines[start]!.file]!.path,
      startLine: lines[start]!.lineNumber,
      endLine: lines[start + segment.length - 1]!.lineNumber,
    });
    moves.push({ from: end(removed, segment.removed), to: end(added, segment.added) });
  });
  return moves.toSorted(
    (left, right) =>
      left.from.path.localeCompare(right.from.path) || left.from.startLine - right.from.startLine,
  );
}
