import { LineDiffRangeCache, type FileContents, type FileDiffMetadata } from "@pierre/diffs";
import {
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";

import { useClientSettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import { fileContentRevision } from "../../files/fileContentRevision";
import { Button } from "../../ui/button";
import { SbsDivider } from "./SbsDivider";
import { SbsFindBar, SbsScrollMarks } from "./SbsOverlays";
import { SbsPane, type SbsPaneAnnotation, type SbsPaneFind } from "./SbsPane";
import { SbsBar, SbsToolbar } from "./SbsToolbar";
import { sbsFindMatches, sbsFindStep, type SbsFindMatch } from "./sbsFind";
import type { SbsHighlightMode } from "./sbsInline";
import { sbsKeyAction, type SbsKeyAction } from "./sbsKeymap";
import {
  buildSbsLayout,
  sbsFoldsCovering,
  sbsLineRow,
  sbsRangeRows,
  sbsRowCount,
  sbsRowTarget,
  type SbsLayout,
} from "./sbsLayout";
import {
  SBS_SIDES,
  sbsDocumentOf,
  sbsGroupRanges,
  sbsLineIndex,
  sbsLineNumber,
  type SbsLineRange,
  type SbsSide,
} from "./sbsModel";
import {
  sbsCurrentGroup,
  sbsDifferenceLabel,
  sbsStepTarget,
  type SbsNavigationDirection,
} from "./sbsNavigation";
import { changeScrollTargets, sbsScrollAnchors, syncedScrollTop } from "./sbsScroll";
import { useSbsHighlight } from "./useSbsHighlight";

/** Lines the user picked in a pane: by selecting text, or in the line-number gutter. */
export interface SbsLineSelection {
  readonly side: SbsSide;
  /** File line numbers, 1-based and inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  /** The selected text; empty when whole lines were picked in the gutter. */
  readonly selectedText: string;
}

/** A Cmd- or Ctrl-click on a token. */
export interface SbsTokenActivation {
  readonly side: SbsSide;
  /** File line number, 1-based. */
  readonly line: number;
  /** Zero-based UTF-16 column in that line. */
  readonly character: number;
  readonly modifiers: {
    readonly meta: boolean;
    readonly ctrl: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
  };
  /** The content revision of the pane's text; null when it does not show a whole file. */
  readonly revision: string | null;
}

/** Something attached to a line range of one pane: a comment, a draft, a note. */
export interface SbsAnnotation<T = unknown> {
  readonly id: string;
  readonly side: SbsSide;
  /** File line numbers, 1-based and inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  readonly data: T;
}

export interface SideBySideDiffViewProps<T = unknown> {
  /** Whole files from `parseDiffFromFile`, or a patch's hunks when the files could not be read. */
  readonly fileDiff: FileDiffMetadata;
  /** What the toolbar row shows before its controls: the file's name. */
  readonly leading?: ReactNode;
  /** Shown between the toolbar and the panes. */
  readonly notice?: ReactNode;
  readonly collapseUnchanged: boolean;
  readonly onCollapseUnchangedChange: (collapse: boolean) => void;
  readonly highlightMode: SbsHighlightMode;
  readonly onHighlightModeChange: (mode: SbsHighlightMode) => void;
  /** The difference to open on: the last one when the file was reached by stepping backwards. */
  readonly initialDifference?: "first" | "last";
  /** Which neighbouring files a step past either end of this one can go to. */
  readonly adjacentFiles?: Readonly<Record<SbsNavigationDirection, boolean>>;
  readonly onOpenAdjacentFile?: (direction: SbsNavigationDirection) => void;
  /** Opens the file itself at a line of the given side. */
  readonly onOpenSource?: (target: { readonly side: SbsSide; readonly line: number }) => void;
  /** Takes focus on opening: the file was reached from the keyboard, which goes on here. */
  readonly focusOnOpen?: boolean;

  /**
   * Line ranges that carry something. Each gets a marker in its pane's gutter and never takes
   * a row: rows are lines and folds only, which the scroll mapping and the connectors rest on.
   */
  readonly annotations?: ReadonlyArray<SbsAnnotation<T>>;
  /** The one annotation shown in the card anchored to its range. */
  readonly openAnnotationId?: string | null;
  readonly onOpenAnnotationChange?: (id: string | null) => void;
  /** The card's content. The card is the surface: return no border or shadow of your own. */
  readonly renderAnnotation?: (annotation: SbsAnnotation<T>) => ReactNode;
  /** A selection was made or, with null, given up. */
  readonly onSelectRange?: (selection: SbsLineSelection | null) => void;
  readonly onTokenActivate?: (activation: SbsTokenActivation) => void;
}

const EMPTY_FOLDS: ReadonlySet<number> = new Set();
const NO_ANNOTATIONS: ReadonlyArray<SbsAnnotation<never>> = [];
const NO_PANE_ANNOTATIONS: ReadonlyArray<SbsPaneAnnotation> = [];
const NO_MATCHES: ReadonlyArray<SbsFindMatch> = [];
const SINGLE_SIDE: Record<SbsSide, ReadonlyArray<SbsSide>> = {
  deletions: ["deletions"],
  additions: ["additions"],
};
/** Rows rendered past each edge of the viewport, so a fast scroll does not outrun them. */
const OVERSCAN_ROWS = 16;
/** The window moves in steps of this many rows, so most frames of a scroll render nothing new. */
const WINDOW_STEP_ROWS = 8;
/** Pierre's own bound: a longer line gets no word-level tint. */
const MAX_WORD_DIFF_LINE_LENGTH = 1_000;
const CARD_MARGIN = 4;
const MODIFIER_KEYS = new Set(["Shift", "Meta", "Control", "Alt"]);
const PANE_LABELS: Record<SbsSide, string> = { deletions: "Before", additions: "After" };

interface Viewport {
  readonly deletions: number;
  readonly additions: number;
  readonly height: number;
}

interface FindState {
  readonly side: SbsSide;
  readonly query: string;
  readonly index: number;
}

interface GutterSelection {
  readonly side: SbsSide;
  readonly anchor: number;
  readonly head: number;
}

function otherSide(side: SbsSide): SbsSide {
  return side === "deletions" ? "additions" : "deletions";
}

function rowWindow(scrollTop: number, height: number, lineHeight: number, rowCount: number) {
  const first = Math.max(0, Math.floor(scrollTop / lineHeight) - OVERSCAN_ROWS);
  const last = Math.ceil((scrollTop + height) / lineHeight) + OVERSCAN_ROWS;
  return {
    first: Math.floor(first / WINDOW_STEP_ROWS) * WINDOW_STEP_ROWS,
    last: Math.min(rowCount, Math.ceil(last / WINDOW_STEP_ROWS) * WINDOW_STEP_ROWS),
  };
}

const highlightFiles = new WeakMap<FileDiffMetadata, Record<SbsSide, FileContents | null>>();

/** Each side's text as a file for the highlighter. Kept per diff: the pool caches by identity. */
function highlightFilesOf(fileDiff: FileDiffMetadata): Record<SbsSide, FileContents | null> {
  const cached = highlightFiles.get(fileDiff);
  if (cached) return cached;
  const file = (name: string, lines: ReadonlyArray<string>, side: SbsSide): FileContents | null => {
    if (lines.length === 0) return null;
    const contents = lines.join("");
    return {
      name,
      contents,
      cacheKey: `sbs:${side}:${name}:${fileContentRevision(contents)}`,
      ...(fileDiff.lang ? { lang: fileDiff.lang } : {}),
    };
  };
  const files = {
    deletions: file(fileDiff.prevName ?? fileDiff.name, fileDiff.deletionLines, "deletions"),
    additions: file(fileDiff.name, fileDiff.additionLines, "additions"),
  };
  highlightFiles.set(fileDiff, files);
  return files;
}

function elementOf(node: EventTarget | Node | null): Element | null {
  if (node instanceof Element) return node;
  return node instanceof Node ? node.parentElement : null;
}

function paneSideOf(node: EventTarget | Node | null): SbsSide | null {
  const side = elementOf(node)?.closest("[data-sbs-pane]")?.getAttribute("data-sbs-pane");
  return side === "deletions" || side === "additions" ? side : null;
}

function lineIndexOf(node: EventTarget | Node | null): number | null {
  const index = elementOf(node)?.closest("[data-sbs-index]")?.getAttribute("data-sbs-index");
  return index === null || index === undefined ? null : Number(index);
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  // Safari before 18.4 has only the older call.
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

function maxScrollTop(element: HTMLElement | null): number {
  return element ? element.scrollHeight - element.clientHeight : 0;
}

/** The annotations of one side as line index ranges; one whose lines are not shown is left out. */
function paneAnnotationsOf(
  annotations: ReadonlyArray<SbsAnnotation>,
  model: ReturnType<typeof sbsDocumentOf>,
  side: SbsSide,
): ReadonlyArray<SbsPaneAnnotation> {
  const ranges = annotations.flatMap((annotation) => {
    if (annotation.side !== side) return [];
    const start = sbsLineIndex(model, side, annotation.startLine);
    const end = sbsLineIndex(model, side, annotation.endLine);
    return start < 0 || end < start ? [] : [{ id: annotation.id, start, end: end + 1 }];
  });
  return ranges.length === 0 ? NO_PANE_ANNOTATIONS : ranges;
}

function selectedLinesOf(selection: GutterSelection | null, side: SbsSide): SbsLineRange | null {
  if (selection?.side !== side) return null;
  return {
    start: Math.min(selection.anchor, selection.head),
    end: Math.max(selection.anchor, selection.head) + 1,
  };
}

export function SideBySideDiffView<T = unknown>(props: SideBySideDiffViewProps<T>) {
  const { fileDiff, collapseUnchanged, highlightMode } = props;
  const fontSize = useClientSettings((settings) => settings.fontSizeCode);
  const lineHeight = Math.round(fontSize * 1.5);
  const model = sbsDocumentOf(fileDiff);
  const [expandedFolds, setExpandedFolds] = useState(EMPTY_FOLDS);
  const layout = buildSbsLayout(model, { collapseUnchanged, expandedFolds });
  const anchors = sbsScrollAnchors(layout);
  // A new or a deleted file has one side, so it gets one pane and no divider.
  const single: SbsSide | null =
    fileDiff.type === "new" ? "additions" : fileDiff.type === "deleted" ? "deletions" : null;
  const lead: SbsSide = single ?? "additions";
  const sides: ReadonlyArray<SbsSide> = single ? SINGLE_SIDE[single] : SBS_SIDES;
  const rowCounts = {
    deletions: sbsRowCount(layout, "deletions"),
    additions: sbsRowCount(layout, "additions"),
  };
  const [wordRanges] = useState(
    () => new LineDiffRangeCache("word", MAX_WORD_DIFF_LINE_LENGTH),
  );
  const highlightedRows = useSbsHighlight(highlightFilesOf(fileDiff), {
    deletions: model.lines.deletions.length,
    additions: model.lines.additions.length,
  });

  const [viewport, setViewport] = useState<Viewport>({ deletions: 0, additions: 0, height: 0 });
  const [steppedGroup, setSteppedGroup] = useState<number | null>(null);
  const [edgeHint, setEdgeHint] = useState<SbsNavigationDirection | null>(null);
  const [gutterSelection, setGutterSelection] = useState<GutterSelection | null>(null);
  const [find, setFind] = useState<FindState | null>(null);
  const [cardHeight, setCardHeight] = useState(0);

  const scrollers = useRef<Record<SbsSide, HTMLDivElement | null>>({
    deletions: null,
    additions: null,
  });
  // The position this view last wrote to a pane: that pane's next scroll event is its echo.
  const echo = useRef<Record<SbsSide, { top: number; left: number } | null>>({
    deletions: null,
    additions: null,
  });
  const frame = useRef<number | null>(null);
  const opened = useRef(false);
  const dragSide = useRef<SbsSide | null>(null);
  const reportedTextSelection = useRef(false);
  const columnProbe = useRef<HTMLSpanElement | null>(null);

  const groupRanges = sbsGroupRanges(model);
  const groupRows = groupRanges.map((range) => sbsRangeRows(layout, lead, range[lead]));
  const anchorRow = Math.floor((viewport[lead] + Math.floor(viewport.height / 3)) / lineHeight);
  const navigation = { groupRows, anchorRow, steppedGroup };
  const currentGroup = sbsCurrentGroup(navigation);

  const readViewport = () => {
    const next: Viewport = {
      deletions: scrollers.current.deletions?.scrollTop ?? 0,
      additions: scrollers.current.additions?.scrollTop ?? 0,
      height: scrollers.current[lead]?.clientHeight ?? 0,
    };
    setViewport((current) =>
      current.deletions === next.deletions &&
      current.additions === next.additions &&
      current.height === next.height
        ? current
        : next,
    );
  };
  // One render a frame, before it paints: a scroll moves both panes and the divider together.
  const scheduleViewport = () => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      flushSync(readViewport);
    });
  };

  const writeScroll = (side: SbsSide, top: number, left?: number) => {
    const element = scrollers.current[side];
    if (!element) return;
    const beforeTop = element.scrollTop;
    const beforeLeft = element.scrollLeft;
    element.scrollTop = top;
    if (left !== undefined) element.scrollLeft = left;
    // Only a write that moved the pane comes back as a scroll event.
    if (element.scrollTop !== beforeTop || element.scrollLeft !== beforeLeft) {
      echo.current[side] = { top: element.scrollTop, left: element.scrollLeft };
    }
  };

  const handleScroll = useStableCallback((side: SbsSide) => {
    const element = scrollers.current[side];
    if (!element) return;
    const written = echo.current[side];
    echo.current[side] = null;
    const isEcho =
      written !== null &&
      Math.abs(written.top - element.scrollTop) < 1 &&
      Math.abs(written.left - element.scrollLeft) < 1;
    if (!isEcho) {
      const slave = scrollers.current[otherSide(side)];
      if (slave && single === null) {
        writeScroll(
          otherSide(side),
          syncedScrollTop({
            anchors,
            master: side,
            masterScrollTop: element.scrollTop,
            slaveScrollTop: slave.scrollTop,
            viewportHeight: element.clientHeight,
            lineHeight,
          }),
          element.scrollLeft,
        );
      }
      setSteppedGroup(null);
      setEdgeHint(null);
    }
    scheduleViewport();
  });

  const stepToIn = (targetLayout: SbsLayout, group: number) => {
    const range = groupRanges[group];
    if (!range) return;
    const rows = {
      deletions: sbsRangeRows(targetLayout, "deletions", range.deletions),
      additions: sbsRangeRows(targetLayout, "additions", range.additions),
    };
    const limits = {
      deletions: maxScrollTop(scrollers.current.deletions),
      additions: maxScrollTop(scrollers.current.additions),
    };
    const targets = changeScrollTargets({
      rows: single ? { deletions: rows[single], additions: rows[single] } : rows,
      viewportHeight: scrollers.current[lead]?.clientHeight ?? 0,
      lineHeight,
      maxScrollTop: single ? { deletions: limits[single], additions: limits[single] } : limits,
    });
    for (const side of sides) writeScroll(side, targets[side]);
    setSteppedGroup(group);
    setEdgeHint(null);
    scheduleViewport();
  };

  const step = (direction: SbsNavigationDirection) => {
    const target = sbsStepTarget(navigation, direction);
    if (target !== null) {
      stepToIn(layout, target);
      return;
    }
    if (!props.adjacentFiles?.[direction]) return;
    // JetBrains: the first press past the last difference only says so; the second one goes.
    if (edgeHint === direction) props.onOpenAdjacentFile?.(direction);
    else setEdgeHint(direction);
  };

  const jumpToSource = () => {
    const range = currentGroup === null ? undefined : groupRanges[currentGroup];
    const side: SbsSide = single ?? (range && range.additions.end === range.additions.start ? "deletions" : "additions");
    const line = range
      ? range[side].start
      : (sbsRowTarget(layout, side, anchorRow)?.line ?? 0);
    props.onOpenSource?.({ side, line: sbsLineNumber(model, side, line) });
  };

  const keyActions: Record<SbsKeyAction, () => void> = {
    nextChange: () => step("next"),
    previousChange: () => step("previous"),
    jumpToSource,
  };

  const attachScroller = (side: SbsSide, element: HTMLDivElement | null) => {
    scrollers.current[side] = element;
    if (element === null || opened.current) return;
    if (sides.some((candidate) => scrollers.current[candidate] === null)) return;
    opened.current = true;
    if (props.focusOnOpen) scrollers.current[lead]?.focus({ preventScroll: true });
    if (groupRanges.length > 0) {
      stepToIn(layout, props.initialDifference === "last" ? groupRanges.length - 1 : 0);
    }
  };
  const attachDeletions = useStableCallback((element: HTMLDivElement | null) =>
    attachScroller("deletions", element),
  );
  const attachAdditions = useStableCallback((element: HTMLDivElement | null) =>
    attachScroller("additions", element),
  );
  const observeBody = useStableCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const stop = observeResize(element, readViewport);
    return () => {
      stop();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  });
  const observeCard = useStableCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    return observeResize(element, ([entry]) => {
      if (entry) setCardHeight(entry.contentRect.height);
    });
  });

  const expandFolds = (folds: ReadonlyArray<number>) => {
    if (folds.length === 0) return expandedFolds;
    const next = new Set(expandedFolds);
    for (const fold of folds) next.add(fold);
    setExpandedFolds(next);
    return next;
  };

  const toggleCollapse = (collapse: boolean) => {
    const group =
      currentGroup ?? sbsStepTarget(navigation, "next") ?? sbsStepTarget(navigation, "previous");
    // Committed first: the scroll targets are read from the panes' new heights.
    flushSync(() => {
      setExpandedFolds(EMPTY_FOLDS);
      props.onCollapseUnchangedChange(collapse);
    });
    if (group === null) return;
    stepToIn(
      buildSbsLayout(model, { collapseUnchanged: collapse, expandedFolds: EMPTY_FOLDS }),
      group,
    );
  };

  const findResult = find ? sbsFindMatches(model.lines[find.side], find.query) : null;
  const findMatches = findResult?.matches ?? NO_MATCHES;
  const currentMatch = find && find.index >= 0 ? (findMatches[find.index] ?? null) : null;
  const findByLine = new Map<number, SbsFindMatch[]>();
  for (const match of findMatches) {
    const matches = findByLine.get(match.line);
    if (matches) matches.push(match);
    else findByLine.set(match.line, [match]);
  }
  const paneFind: SbsPaneFind | null = find ? { byLine: findByLine, current: currentMatch } : null;

  /** Scrolls a match into view as a scroll of the user's, so the other pane follows. */
  const revealMatch = (side: SbsSide, match: SbsFindMatch, folds: ReadonlySet<number>) => {
    const element = scrollers.current[side];
    if (!element) return;
    const target = buildSbsLayout(model, { collapseUnchanged, expandedFolds: folds });
    const row = sbsLineRow(target, side, match.line).row;
    const top = row * lineHeight;
    if (top < element.scrollTop || top + lineHeight > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - Math.floor(element.clientHeight / 3));
    }
    const column = columnProbe.current?.getBoundingClientRect().width ?? 0;
    const start = match.start * column;
    if (start < element.scrollLeft || match.end * column > element.scrollLeft + element.clientWidth * 0.8) {
      element.scrollLeft = Math.max(0, start - element.clientWidth / 3);
    }
  };

  const stepFind = (direction: 1 | -1, query = find?.query ?? "") => {
    if (!find) return;
    const matches = query === find.query ? findMatches : sbsFindMatches(model.lines[find.side], query).matches;
    const index = query === find.query ? sbsFindStep(find.index, matches.length, direction) : matches.length > 0 ? 0 : -1;
    const match = matches[index];
    let folds = expandedFolds;
    // Committed first, so the match's row exists where the scroll puts it.
    flushSync(() => {
      setFind({ side: find.side, query, index });
      if (match) {
        folds = expandFolds(
          sbsFoldsCovering(layout, find.side, { start: match.line, end: match.line + 1 }),
        );
      }
    });
    if (match) revealMatch(find.side, match, folds);
  };

  const closeFind = () => {
    if (!find) return;
    scrollers.current[find.side]?.focus({ preventScroll: true });
    setFind(null);
  };

  const reportTextSelection = () => {
    if (!props.onSelectRange) return;
    const selection = window.getSelection();
    const range = selection && !selection.isCollapsed ? selection.getRangeAt(0) : null;
    const side = range ? paneSideOf(range.startContainer) : null;
    const start = range ? lineIndexOf(range.startContainer) : null;
    let end = range ? lineIndexOf(range.endContainer) : null;
    if (!range || !side || side !== paneSideOf(range.endContainer) || start === null || end === null) {
      if (reportedTextSelection.current) {
        reportedTextSelection.current = false;
        props.onSelectRange(null);
      }
      return;
    }
    // A selection that stops before the first character of a line does not include that line.
    const endCode = elementOf(range.endContainer)?.closest(".sbs-code");
    if (end > start && endCode) {
      const prefix = document.createRange();
      prefix.setStart(endCode, 0);
      prefix.setEnd(range.endContainer, range.endOffset);
      if (prefix.toString().length === 0) end -= 1;
    }
    reportedTextSelection.current = true;
    setGutterSelection(null);
    props.onSelectRange({
      side,
      startLine: sbsLineNumber(model, side, start),
      endLine: sbsLineNumber(model, side, end),
      selectedText: selection?.toString() ?? "",
    });
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const gutter = elementOf(event.target)?.closest("[data-sbs-gutter]");
    const side = paneSideOf(event.target);
    const line = lineIndexOf(gutter ?? null);
    if (!gutter || !side || line === null || elementOf(event.target)?.closest("[data-sbs-annotation]")) {
      if (gutterSelection && paneSideOf(event.target)) {
        setGutterSelection(null);
        props.onSelectRange?.(null);
      }
      return;
    }
    // The gutter picks lines; it must not start a text selection.
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    scrollers.current[side]?.focus({ preventScroll: true });
    const anchor = event.shiftKey && gutterSelection?.side === side ? gutterSelection.anchor : line;
    setGutterSelection({ side, anchor, head: line });
    dragSide.current = side;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const side = dragSide.current;
    if (!side) return;
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const line = lineIndexOf(under);
    if (line === null || paneSideOf(under) !== side) return;
    setGutterSelection((current) =>
      current && current.head !== line ? { ...current, head: line } : current,
    );
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragSide.current) return;
    dragSide.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (!gutterSelection) return;
    const { side, anchor, head } = gutterSelection;
    props.onSelectRange?.({
      side,
      startLine: sbsLineNumber(model, side, Math.min(anchor, head)),
      endLine: sbsLineNumber(model, side, Math.max(anchor, head)),
      selectedText: "",
    });
  };

  const activateToken = (event: MouseEvent<HTMLDivElement>) => {
    const code = elementOf(event.target)?.closest(".sbs-code");
    const side = paneSideOf(event.target);
    const line = lineIndexOf(event.target);
    const caret = caretAt(event.clientX, event.clientY);
    if (!code || !side || line === null || !caret || !code.contains(caret.node)) return;
    const before = document.createRange();
    before.setStart(code, 0);
    before.setEnd(caret.node, caret.offset);
    const character = before.toString().length;
    const text = model.lines[side][line] ?? "";
    if (character >= text.length || /\s/u.test(text[character] ?? " ")) return;
    props.onTokenActivate?.({
      side,
      line: sbsLineNumber(model, side, line),
      character,
      modifiers: {
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
      },
      revision: model.partial
        ? null
        : fileContentRevision((side === "deletions" ? fileDiff.deletionLines : fileDiff.additionLines).join("")),
    });
  };

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = elementOf(event.target);
    const fold = target?.closest("[data-sbs-fold]")?.getAttribute("data-sbs-fold");
    if (fold !== null && fold !== undefined) {
      expandFolds([Number(fold)]);
      return;
    }
    const annotation = target
      ?.closest("[data-sbs-annotation]")
      ?.getAttribute("data-sbs-annotation");
    if (annotation !== null && annotation !== undefined) {
      props.onOpenAnnotationChange?.(props.openAnnotationId === annotation ? null : annotation);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && props.onTokenActivate) activateToken(event);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || MODIFIER_KEYS.has(event.key)) return;
    const action = sbsKeyAction(event);
    if (action) {
      event.preventDefault();
      keyActions[action]();
      return;
    }
    setEdgeHint(null);
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
      const side = paneSideOf(event.target) ?? find?.side ?? lead;
      event.preventDefault();
      setFind((current) => (current?.side === side ? current : { side, query: "", index: -1 }));
      return;
    }
    if (event.key !== "Escape") return;
    if (find) closeFind();
    else if (props.openAnnotationId != null) props.onOpenAnnotationChange?.(null);
    else if (gutterSelection) {
      setGutterSelection(null);
      props.onSelectRange?.(null);
    } else return;
    event.preventDefault();
  };

  const annotations: ReadonlyArray<SbsAnnotation> = props.annotations ?? NO_ANNOTATIONS;
  const paneAnnotations = {
    deletions: paneAnnotationsOf(annotations, model, "deletions"),
    additions: paneAnnotationsOf(annotations, model, "additions"),
  };
  const selectedLines = {
    deletions: selectedLinesOf(gutterSelection, "deletions"),
    additions: selectedLinesOf(gutterSelection, "additions"),
  };
  const openAnnotation =
    props.renderAnnotation && props.openAnnotationId != null
      ? props.annotations?.find((annotation) => annotation.id === props.openAnnotationId)
      : undefined;
  const openAnnotationRange = openAnnotation
    ? paneAnnotations[openAnnotation.side].find((range) => range.id === openAnnotation.id)
    : undefined;

  /** Where an overlay under a range of rows sits in its pane, held inside the viewport. */
  const overlayPlacement = (side: SbsSide, rows: SbsLineRange, height: number) => {
    const below = rows.end * lineHeight - viewport[side] + CARD_MARGIN;
    const limit = Math.max(CARD_MARGIN, viewport.height - height - CARD_MARGIN);
    return {
      top: Math.min(Math.max(below, CARD_MARGIN), limit),
      // Out of view: the overlay rests against the edge its range left by.
      docked:
        rows.end * lineHeight <= viewport[side] ||
        rows.start * lineHeight >= viewport[side] + viewport.height,
    };
  };

  const revealAnnotation = () => {
    if (!openAnnotation || !openAnnotationRange) return;
    let folds = expandedFolds;
    // Committed first, so the range's rows exist where the scroll puts them.
    flushSync(() => {
      folds = expandFolds(sbsFoldsCovering(layout, openAnnotation.side, openAnnotationRange));
    });
    const target = buildSbsLayout(model, { collapseUnchanged, expandedFolds: folds });
    const element = scrollers.current[openAnnotation.side];
    if (!element) return;
    const row = sbsLineRow(target, openAnnotation.side, openAnnotationRange.start).row;
    element.scrollTop = Math.max(0, row * lineHeight - Math.floor(element.clientHeight / 3));
  };

  const hintRows =
    edgeHint === null
      ? null
      : ((edgeHint === "next" ? groupRows.at(-1) : groupRows[0]) ?? {
          start: anchorRow,
          end: anchorRow + 1,
        });
  const overlayLeft = `calc(${model.lineNumberDigits}ch + 2.5rem)`;

  const renderOverlays = (side: SbsSide) => {
    const card =
      openAnnotation && openAnnotationRange && openAnnotation.side === side
        ? overlayPlacement(side, sbsRangeRows(layout, side, openAnnotationRange), cardHeight)
        : null;
    const hint = hintRows && side === lead ? overlayPlacement(side, hintRows, lineHeight + 8) : null;
    return (
      <>
        {single === null && highlightMode !== "none" && viewport.height > 0 ? (
          <SbsScrollMarks
            side={side}
            document={model}
            layout={layout}
            rowCount={rowCounts[side]}
            viewportHeight={viewport.height}
          />
        ) : null}
        {find?.side === side ? (
          <SbsFindBar
            label={`Find in ${PANE_LABELS[side].toLowerCase()}`}
            query={find.query}
            index={find.index}
            count={findMatches.length}
            truncated={findResult?.truncated ?? false}
            onQueryChange={(query) => stepFind(1, query)}
            onStep={stepFind}
            onClose={closeFind}
          />
        ) : null}
        {hint ? (
          <div
            role="status"
            className="pointer-events-none absolute z-10 rounded-md border border-border bg-popover px-2 py-1 font-sans text-xs whitespace-nowrap text-popover-foreground shadow-md"
            style={{ top: hint.top, left: overlayLeft }}
            data-sbs-edge-hint={edgeHint ?? undefined}
          >
            {edgeHint === "next"
              ? "Press again to go to the next file"
              : "Press again to go to the previous file"}
          </div>
        ) : null}
        {card && openAnnotation ? (
          <div
            ref={observeCard}
            className="absolute z-10 w-[min(30rem,calc(100%-4rem))] rounded-md border border-border bg-popover font-sans text-popover-foreground shadow-lg"
            style={{ top: card.top, left: overlayLeft }}
            data-sbs-annotation-card={openAnnotation.id}
            data-docked={card.docked ? "" : undefined}
          >
            {card.docked ? (
              <Button type="button" size="micro" variant="ghost-muted" onClick={revealAnnotation}>
                {openAnnotation.startLine === openAnnotation.endLine
                  ? `Show line ${openAnnotation.startLine}`
                  : `Show lines ${openAnnotation.startLine} to ${openAnnotation.endLine}`}
              </Button>
            ) : null}
            {props.renderAnnotation?.(openAnnotation)}
          </div>
        ) : null}
      </>
    );
  };

  const deletionsWindow = rowWindow(
    viewport.deletions,
    viewport.height,
    lineHeight,
    rowCounts.deletions,
  );
  const additionsWindow = rowWindow(
    viewport.additions,
    viewport.height,
    lineHeight,
    rowCounts.additions,
  );
  const paneProps = {
    document: model,
    layout,
    lineHeight,
    gutterDigits: model.lineNumberDigits,
    contentColumns: model.maxColumns,
    highlightMode,
    wordRanges,
    openAnnotationId: props.openAnnotationId ?? null,
    onScroll: handleScroll,
  };
  const deletionsPane =
    single === "additions" ? null : (
      <SbsPane
        {...paneProps}
        side="deletions"
        label={PANE_LABELS.deletions}
        firstRow={deletionsWindow.first}
        lastRow={deletionsWindow.last}
        highlightedRows={highlightedRows.deletions}
        find={find?.side === "deletions" ? paneFind : null}
        annotations={paneAnnotations.deletions}
        selectedLines={selectedLines.deletions}
        hideScrollbar={single === null}
        scrollerRef={attachDeletions}
      >
        {renderOverlays("deletions")}
      </SbsPane>
    );
  const additionsPane =
    single === "deletions" ? null : (
      <SbsPane
        {...paneProps}
        side="additions"
        label={PANE_LABELS.additions}
        firstRow={additionsWindow.first}
        lastRow={additionsWindow.last}
        highlightedRows={highlightedRows.additions}
        find={find?.side === "additions" ? paneFind : null}
        annotations={paneAnnotations.additions}
        selectedLines={selectedLines.additions}
        hideScrollbar={false}
        scrollerRef={attachAdditions}
      >
        {renderOverlays("additions")}
      </SbsPane>
    );

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-sbs-view=""
      // On the whole view, so the keys also work from its toolbar.
      onKeyDown={handleKeyDown}
    >
      <SbsBar leading={props.leading}>
        <SbsToolbar
          statusLabel={
            highlightMode === "none"
              ? "Highlighting is off"
              : sbsDifferenceLabel(currentGroup, model.groupCount)
          }
          canStep={
            model.groupCount > 0 ||
            props.adjacentFiles?.next === true ||
            props.adjacentFiles?.previous === true
          }
          onStep={step}
          collapseUnchanged={collapseUnchanged}
          onCollapseUnchangedChange={toggleCollapse}
          highlightMode={highlightMode}
          onHighlightModeChange={props.onHighlightModeChange}
        />
      </SbsBar>
      {props.notice}
      <div
        ref={observeBody}
        className="sbs-diff relative flex min-h-0 flex-1"
        style={
          { "--sbs-line-height": `${lineHeight}px`, fontSize: `${fontSize}px` } as CSSProperties
        }
        onClick={handleClick}
        onKeyUp={(event) => {
          if (event.shiftKey || event.key === "Shift") reportTextSelection();
        }}
        onMouseUp={reportTextSelection}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* One column wide: turns a match's column into a horizontal scroll position. */}
        <span
          ref={columnProbe}
          className="pointer-events-none invisible absolute"
          aria-hidden="true"
        >
          0
        </span>
        {deletionsPane}
        {single === null ? (
          <SbsDivider
            document={model}
            layout={layout}
            scrollTop={viewport}
            viewportHeight={viewport.height}
            lineHeight={lineHeight}
            showConnectors={highlightMode !== "none"}
          />
        ) : null}
        {additionsPane}
      </div>
    </div>
  );
}
