import { create } from "zustand";

import { useResizeDrag } from "~/hooks/useResizeDrag";

// ChatCanvas renders the committed width into this property; a drag writes it directly.
const COMPOSER_DOCK_SIZE_PROPERTY = "--chat-composer-dock-size";

/** The docked composer width chosen this session; null keeps the default. */
export const useComposerDockWidthStore = create<{
  width: number | null;
  setWidth: (width: number | null) => void;
}>()((set) => ({ width: null, setWidth: (width) => set({ width }) }));

/** Drags the docked composer's left edge; double-click returns it to the default width. */
export function ComposerDockResizeHandle() {
  const setWidth = useComposerDockWidthStore((state) => state.setWidth);
  const {
    ref: dragRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
  } = useResizeDrag<HTMLDivElement>((event) => {
    const overlay = event.currentTarget.parentElement;
    const canvas = overlay?.parentElement;
    if (!overlay || !canvas) return null;
    const previous = canvas.style.getPropertyValue(COMPOSER_DOCK_SIZE_PROPERTY);
    // The CSS clamp on --chat-composer-dock-width owns the bounds; read them back from layout.
    const widthAt = (size: string) => {
      canvas.style.setProperty(COMPOSER_DOCK_SIZE_PROPERTY, size);
      return overlay.getBoundingClientRect().width;
    };
    const bounds = { min: widthAt("0px"), max: widthAt("100000px") };
    canvas.style.setProperty(COMPOSER_DOCK_SIZE_PROPERTY, previous);
    return {
      width: overlay.getBoundingClientRect().width,
      edge: "left",
      bounds,
      resize(width) {
        canvas.style.setProperty(COMPOSER_DOCK_SIZE_PROPERTY, `${width}px`);
        return width;
      },
      finish(width, moved) {
        if (moved) setWidth(Math.round(width));
      },
      cleanup(committed) {
        if (!committed) canvas.style.setProperty(COMPOSER_DOCK_SIZE_PROPERTY, previous);
      },
    };
  });
  return (
    <div
      ref={dragRef}
      role="separator"
      aria-label="Resize composer"
      aria-orientation="vertical"
      className="group pointer-events-auto absolute inset-y-0 left-0.5 z-30 w-2 cursor-col-resize select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
      onDoubleClick={() => setWidth(null)}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-3 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"
      />
    </div>
  );
}
