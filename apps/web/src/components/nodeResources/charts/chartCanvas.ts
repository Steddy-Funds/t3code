import { useEffect, useEffectEvent, useRef } from "react";

import { subscribeRenderedAppearance } from "~/hooks/useTheme";
import { observeIntersection } from "~/lib/observeIntersection";
import { observeResize } from "~/lib/observeResize";

type Listener = () => void;

export interface ChartSource {
  subscribe(listener: Listener): () => void;
}

export interface ChartFrame {
  readonly context: CanvasRenderingContext2D;
  readonly width: number;
  readonly height: number;
  /** Resolves a CSS custom property (`--primary`) to a colour the canvas accepts, once per draw. */
  readonly color: (cssVariable: string) => string;
  readonly font: string;
}

const environmentListeners = new Set<Listener>();
let stopEnvironment: (() => void) | null = null;

/** Theme and device-pixel-ratio changes, one shared subscription for every chart. */
function subscribeChartEnvironment(listener: Listener): () => void {
  environmentListeners.add(listener);
  stopEnvironment ??= startEnvironment();
  return () => {
    environmentListeners.delete(listener);
    if (environmentListeners.size > 0) return;
    stopEnvironment?.();
    stopEnvironment = null;
  };
}

function startEnvironment(): () => void {
  const notify = () => {
    for (const listener of environmentListeners) listener();
  };
  const stopTheme = subscribeRenderedAppearance(notify);
  let stopRatio = () => {};
  // A resolution query matches one ratio only, so it is re-armed after each change.
  const watchRatio = () => {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const change = () => {
      stopRatio();
      watchRatio();
      notify();
    };
    query.addEventListener("change", change, { once: true });
    stopRatio = () => query.removeEventListener("change", change);
  };
  watchRatio();
  return () => {
    stopTheme();
    stopRatio();
  };
}

function frameFor(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  fittedHeight: number | undefined,
): ChartFrame {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = fittedHeight ?? canvas.clientHeight;
  if (fittedHeight !== undefined && canvas.style.height !== `${fittedHeight}px`) {
    canvas.style.height = `${fittedHeight}px`;
  }
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const style = getComputedStyle(canvas);
  const colors = new Map<string, string>();
  return {
    context,
    width,
    height,
    // Variables may hold color-mix() or var() chains; the computed `color` is always concrete.
    color: (cssVariable) => {
      let resolved = colors.get(cssVariable);
      if (resolved === undefined) {
        canvas.style.color = `var(${cssVariable})`;
        resolved = style.color;
        colors.set(cssVariable, resolved);
      }
      return resolved;
    },
    font: `500 9px ${style.getPropertyValue("--font-mono") || "ui-monospace, monospace"}`,
  };
}

/**
 * Draws a canvas imperatively on data from `source`, resize, theme or DPR change, or a render with
 * new props: coalesced into one frame and skipped while off screen. `draw` returns the aria-label.
 */
export function useChartCanvas(
  source: ChartSource,
  draw: (frame: ChartFrame) => string,
  /** For canvases whose height follows their width; omitted, CSS sizes the canvas. */
  heightFor?: (width: number) => number,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paint = useEffectEvent(draw);
  const measure = useEffectEvent((width: number) => heightFor?.(width));
  const invalidateRef = useRef<() => void>(() => {});

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the canvas to its data source, resize, visibility, theme and DPR, and paints imperatively
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let visible = true;
    let dirty = true;
    let frame = 0;

    const render = () => {
      frame = 0;
      if (!visible || canvas.clientWidth === 0) return;
      const target = frameFor(canvas, context, measure(canvas.clientWidth));
      if (target.height === 0) return;
      dirty = false;
      canvas.setAttribute("aria-label", paint(target));
    };
    const invalidate = () => {
      dirty = true;
      if (visible && frame === 0) frame = requestAnimationFrame(render);
    };

    const stops = [
      source.subscribe(invalidate),
      subscribeChartEnvironment(invalidate),
      observeResize(canvas, invalidate),
      observeIntersection(canvas, (entry) => {
        visible = entry.isIntersecting;
        if (visible && dirty) invalidate();
      }),
    ];
    invalidateRef.current = invalidate;
    return () => {
      invalidateRef.current = () => {};
      if (frame !== 0) cancelAnimationFrame(frame);
      for (const stop of stops) stop();
    };
  }, [source]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a render means new draw props (scale, colours, threshold); renders are rare, ticks never render
  useEffect(() => {
    invalidateRef.current();
  });

  return canvasRef;
}
