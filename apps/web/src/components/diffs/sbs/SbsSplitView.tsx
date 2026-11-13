import { ArrowLeftIcon } from "lucide-react";
import {
  useCallback,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";

import { Button } from "../../ui/button";
import { NO_LINE_MARKS } from "./sbsLineContent";
import { sbsLineNumber, type SbsDocument } from "./sbsModel";
import type { SbsMoveMark } from "./sbsMoves";
import { LineText, tokensOfRow } from "./SbsPane";
import { sbsSplitGeometry, type SbsSplit, type SbsSplitCard } from "./sbsSplit";

/** Three times the file view's divider, so a band that slants has room to. */
const SPLIT_DIVIDER_WIDTH = 72;

export interface SbsSplitCardSource {
  readonly card: SbsSplitCard | null;
  readonly document: SbsDocument | null;
  /** The card's side, highlighted, when it is a side of the file on screen. */
  readonly highlightedRows: ArrayLike<unknown> | null;
}

export interface SbsSplitViewProps {
  readonly document: SbsDocument;
  readonly split: SbsSplit;
  /** One per piece, in the same order. */
  readonly cards: ReadonlyArray<SbsSplitCardSource>;
  readonly highlightedRows: ArrayLike<unknown> | null;
  readonly lineHeight: number;
  /** The file view's colours and font, which the layer sits outside of. */
  readonly style: CSSProperties;
  readonly className?: string | undefined;
  readonly onClose: () => void;
  readonly onOpenPiece: (mark: SbsMoveMark) => void;
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function summaryOf(split: SbsSplit): string {
  const lines = plural(split.block.end - split.block.start, "line", "lines");
  const files = new Set(split.pieces.map((piece) => piece.mark.move.counterpart.filePath)).size;
  const places =
    split.pieces.length === 1
      ? split.pieces[0]!.mark.move.place
      : `${plural(split.pieces.length, "place", "places")}${files > 1 ? ` in ${files} files` : ""}`;
  return split.side === "deletions"
    ? `${lines} removed here, moved to ${places}`
    : `${lines} added here, moved from ${places}`;
}

function Row(props: {
  readonly lineNumber: number;
  readonly text: string;
  readonly tokens: ReturnType<typeof tokensOfRow>;
  readonly tint?: string | undefined;
  readonly piece?: number | undefined;
  readonly context?: boolean;
}) {
  return (
    <div
      className="sbs-row"
      data-tint={props.tint}
      data-piece={props.piece}
      data-sbs-split-context={props.context ? "" : undefined}
    >
      <span className="sbs-gutter">{props.lineNumber}</span>
      <span className="sbs-code">
        <LineText text={props.text} tokens={props.tokens} marks={NO_LINE_MARKS} />
      </span>
    </div>
  );
}

/**
 * A moved block opened over the file view: the block whole on its own side, a card for each
 * place a piece of it went (or came from) on the other, and a band from each piece to its card.
 * The shapes are drawn once, as tall as the content, and scroll with it.
 */
export function SbsSplitView(props: SbsSplitViewProps) {
  const { document, split, cards, lineHeight } = props;
  const root = useRef<HTMLDivElement | null>(null);
  const activePiece = useRef<string | null>(null);
  const focusOnMount = useCallback((element: HTMLDivElement | null) => {
    element?.focus({ preventScroll: true });
  }, []);

  const blockRows = split.block.end - split.block.start;
  const geometry = sbsSplitGeometry({
    blockRows,
    pieces: split.pieces.map((piece, index) => ({
      rows: piece.rows,
      before: cards[index]?.card?.before ?? 0,
      after: cards[index]?.card?.after ?? 0,
      level: !piece.mark.move.counterpart.sameFile,
    })),
    gaps: split.gaps,
    lineHeight,
    side: split.side,
    dividerWidth: SPLIT_DIVIDER_WIDTH,
  });

  const pieceOfRow = new Int32Array(blockRows).fill(-1);
  split.pieces.forEach((piece, index) => pieceOfRow.fill(index, piece.rows.start, piece.rows.end));
  const leftover = split.side === "deletions" ? "deleted" : "inserted";
  const blockLines: ReactNode[] = [];
  for (let row = 0; row < blockRows; row += 1) {
    const line = split.block.start + row;
    const text = document.lines[split.side][line] ?? "";
    const piece = pieceOfRow[row]!;
    blockLines.push(
      <Row
        key={line}
        lineNumber={sbsLineNumber(document, split.side, line)}
        text={text}
        tokens={tokensOfRow(props.highlightedRows, line, text)}
        tint={piece >= 0 ? "moved" : leftover}
        piece={piece >= 0 ? piece : undefined}
      />,
    );
  }
  const blockColumn = (
    <div className="relative min-w-0 flex-1">
      <div
        className="absolute inset-x-0 overflow-x-auto overflow-y-hidden"
        style={
          {
            top: geometry.blockTop,
            "--sbs-gutter-digits": document.lineNumberDigits,
          } as CSSProperties
        }
        data-sbs-split-block=""
      >
        <div className="min-w-max">{blockLines}</div>
      </div>
    </div>
  );

  const cardColumn = (
    <div className="relative min-w-0 flex-1">
      {split.pieces.map((piece, index) => {
        const source = cards[index];
        const card = source?.card ?? null;
        const placement = geometry.cards[index]!;
        const { move } = piece.mark;
        const lineCount = piece.rows.end - piece.rows.start;
        return (
          <div
            key={piece.mark.range.start}
            className="sbs-split-card absolute inset-x-0"
            style={
              {
                top: placement.top,
                minHeight: placement.height,
                "--sbs-gutter-digits": source?.document?.lineNumberDigits ?? 3,
              } as CSSProperties
            }
            data-piece={index}
            data-sbs-split-card={move.counterpart.sameFile ? "same-file" : "other-file"}
          >
            <button
              type="button"
              className="sbs-split-card-title"
              onClick={() => props.onOpenPiece(piece.mark)}
            >
              <span className="truncate">{move.place}</span>
              <span className="sbs-split-card-count">{plural(lineCount, "line", "lines")}</span>
            </button>
            {card ? (
              <div className="overflow-x-auto overflow-y-hidden">
                <div className="min-w-max">
                  {card.lines.map((line, offset) => {
                    const lineIndex = card.range.start + offset;
                    return (
                      <Row
                        key={lineIndex}
                        lineNumber={line.lineNumber}
                        text={line.text}
                        tokens={tokensOfRow(source?.highlightedRows ?? null, lineIndex, line.text)}
                        tint={line.moved ? "moved" : undefined}
                        piece={line.moved ? index : undefined}
                        context={!line.moved}
                      />
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="sbs-split-card-missing">These lines are not loaded</div>
            )}
          </div>
        );
      })}
    </div>
  );

  const divider = (
    <svg
      className="flex-none"
      width={SPLIT_DIVIDER_WIDTH}
      height={geometry.height}
      aria-hidden="true"
    >
      {geometry.gaps.map((path) => (
        <path key={path} className="sbs-split-gap" data-side={split.side} d={path} />
      ))}
      {geometry.bands.map((path, index) => (
        <path
          // oxlint-disable-next-line react/no-array-index-key -- a band is its piece, which has no other key
          key={index}
          className="sbs-split-band"
          data-piece={index}
          d={path}
        />
      ))}
    </svg>
  );

  // Delegated, and written to the DOM directly: hovering moves no row through React.
  const showPiece = (piece: string | null) => {
    if (activePiece.current === piece) return;
    activePiece.current = piece;
    for (const element of root.current?.querySelectorAll("[data-piece]") ?? []) {
      element.toggleAttribute(
        "data-dim",
        piece !== null && element.getAttribute("data-piece") !== piece,
      );
    }
  };
  const handlePointerOver = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    showPiece(target?.closest("[data-piece]")?.getAttribute("data-piece") ?? null);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // The file view underneath must not take the keys meant for this one.
    event.stopPropagation();
    if (event.key !== "Escape") return;
    event.preventDefault();
    props.onClose();
  };

  return (
    <div
      ref={root}
      role="dialog"
      aria-label="Where this block moved"
      className={cn("sbs-diff sbs-split absolute inset-0 z-30 flex flex-col", props.className)}
      style={props.style}
      data-sbs-split={split.side}
      onKeyDown={handleKeyDown}
    >
      <div className="sbs-split-bar">
        <Button type="button" size="xs" variant="ghost" onClick={props.onClose}>
          <ArrowLeftIcon />
          Back
        </Button>
        <span className="truncate">{summaryOf(split)}</span>
      </div>
      <div
        ref={focusOnMount}
        // Focusable, so the keys reach this layer and Escape closes it.
        tabIndex={0}
        className="relative min-h-0 flex-1 overflow-auto outline-none"
        onPointerOver={handlePointerOver}
        onPointerLeave={() => showPiece(null)}
      >
        <div className="relative flex" style={{ minHeight: geometry.height }}>
          {split.side === "deletions" ? blockColumn : cardColumn}
          {divider}
          {split.side === "deletions" ? cardColumn : blockColumn}
        </div>
      </div>
    </div>
  );
}
