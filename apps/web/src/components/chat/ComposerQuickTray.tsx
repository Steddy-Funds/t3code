import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { observeResize } from "~/lib/observeResize";

import { ComposerSurface } from "./ComposerSurface";

/** How much of the resting quick composer stays on screen. */
const QUICK_COMPOSER_LIP_PX = 44;

/**
 * Holds the quick composer below the timeline while the main composer is docked. It rests
 * mostly off-screen and floats in while the pointer is in the thread's column or it has focus.
 */
export function ComposerQuickTray(props: {
  children: ReactNode;
  /** The tray's resting height, which the timeline reserves so the risen composer covers nothing. */
  onHeightChange: (height: number) => void;
}) {
  const { onHeightChange } = props;
  const trayRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [inThreadColumn, setInThreadColumn] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the tray before paint so the timeline reserves its height
  useLayoutEffect(() => {
    const tray = trayRef.current;
    if (!tray) return;
    const report = () => onHeightChange(Math.ceil(tray.getBoundingClientRect().height));
    report();
    return observeResize(tray, report);
  }, [onHeightChange]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the pointer across the conversation column
  useEffect(() => {
    const body = bodyRef.current;
    const column = body?.parentElement?.parentElement;
    if (!body || !column) return;
    // The body shares the thread lane's horizontal bounds, so it marks the thread's column.
    const onPointerMove = (event: PointerEvent) => {
      const { left, right } = body.getBoundingClientRect();
      setInThreadColumn(event.clientX >= left && event.clientX <= right);
    };
    const onPointerLeave = () => setInThreadColumn(false);
    column.addEventListener("pointermove", onPointerMove, { passive: true });
    column.addEventListener("pointerleave", onPointerLeave);
    return () => {
      column.removeEventListener("pointermove", onPointerMove);
      column.removeEventListener("pointerleave", onPointerLeave);
    };
  }, []);

  return (
    <div
      ref={trayRef}
      data-composer-quick-tray="true"
      data-pointer-in-thread={inThreadColumn ? "true" : undefined}
      className="chat-composer-lane pointer-events-none absolute inset-x-0 bottom-0 z-20 w-full overflow-hidden pt-4"
      style={{ "--quick-composer-lip": `${QUICK_COMPOSER_LIP_PX}px` } as CSSProperties}
    >
      <div
        ref={bodyRef}
        data-composer-quick-tray-body="true"
        className="pointer-events-auto mx-auto w-full max-w-(--chat-content-max-width) pb-3"
      >
        <ComposerSurface.Shell>
          <ComposerSurface.Host>
            <div className="relative z-10">{props.children}</div>
          </ComposerSurface.Host>
        </ComposerSurface.Shell>
      </div>
    </div>
  );
}
