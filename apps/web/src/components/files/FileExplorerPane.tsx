import { type CSSProperties, type ReactNode, useState } from "react";

import { RightPanelResizeHandle } from "~/components/preview/RightPanelResizeHandle";
import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "~/hooks/useResizableWidth";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

const MIN_WIDTH = 160;
const MAX_WIDTH = 560;
const FILE_CONTENT_MIN_WIDTH = 256;

/** A persisted, resizable file-tree column; fills the row when resizing is disabled.
 * Callers can retain a responsive initial width via defaultWidthFraction (a fraction of the row),
 * and use a separate saved width, minimum and resize label. A chosen width overrides the default.
 */
export function FileExplorerPane({
  side = "right",
  resizable,
  children,
  storageKey = "t3code.fileExplorerWidth",
  defaultWidth = 256,
  defaultWidthFraction,
  minWidth = MIN_WIDTH,
  resizeLabel = "Resize file explorer",
}: {
  side?: "left" | "right";
  resizable: boolean;
  children: ReactNode;
  storageKey?: string;
  defaultWidth?: number;
  defaultWidthFraction?: number;
  minWidth?: number;
  resizeLabel?: string;
}) {
  const [maxWidth, setMaxWidth] = useState(MAX_WIDTH);
  const [responsiveDefaultWidth, setResponsiveDefaultWidth] = useState(defaultWidth);
  const { width, setWidth, handlers } = useResizableWidth({
    storageKey,
    defaultWidth: responsiveDefaultWidth,
    minWidth,
    maxWidth,
    edge: side === "right" ? "left" : "right",
  });
  const growKey = side === "right" ? "ArrowLeft" : "ArrowRight";

  return (
    <aside
      ref={(host) => {
        const row = host?.parentElement;
        if (!row || !resizable) return;
        const measure = () => {
          const initialWidth = Math.max(
            minWidth,
            Math.min(defaultWidth, row.clientWidth * (defaultWidthFraction ?? 1)),
          );
          // A responsive default must not shrink to make room for the content reserve.
          const availableWidth = Math.max(
            row.clientWidth - FILE_CONTENT_MIN_WIDTH,
            defaultWidthFraction === undefined ? minWidth : initialWidth,
          );
          setMaxWidth(Math.max(minWidth, Math.min(MAX_WIDTH, availableWidth)));
          setResponsiveDefaultWidth(initialWidth);
        };
        measure();
        return observeResize(row, measure);
      }}
      aria-label="File explorer"
      className={cn(
        "relative flex min-h-0 min-w-0 shrink-0 bg-background",
        !resizable
          ? "flex-1"
          : side === "right"
            ? "border-l border-border/60"
            : "border-r border-border/60",
      )}
      style={
        resizable
          ? ({
              [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
              width: `var(${RESIZABLE_WIDTH_PROPERTY})`,
            } as CSSProperties)
          : undefined
      }
    >
      {resizable ? (
        <RightPanelResizeHandle
          handlers={handlers}
          label={resizeLabel}
          {...(side === "left"
            ? {
                className:
                  "left-auto -right-1 any-pointer-coarse:left-auto any-pointer-coarse:-right-2",
              }
            : {})}
          tabIndex={0}
          aria-valuenow={width}
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            let nextWidth: number;
            switch (event.key) {
              case "ArrowLeft":
              case "ArrowRight":
                nextWidth = event.key === growKey ? width + 16 : width - 16;
                break;
              case "Home":
                nextWidth = minWidth;
                break;
              case "End":
                nextWidth = maxWidth;
                break;
              default:
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            setWidth(nextWidth);
          }}
        />
      ) : null}
      {children}
    </aside>
  );
}
