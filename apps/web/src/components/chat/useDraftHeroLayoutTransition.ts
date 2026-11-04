import { useStableCallback } from "../../hooks/useStableCallback";
import { useLayoutEffect, useRef } from "react";
import {
  DRAFT_HERO_TRANSITION_ANIMATION_ID,
  DRAFT_HERO_TRANSITION_EASING,
} from "./draftHeroTransition";

/**
 * Slides the composer from its old spot whenever `layout` changes (hero, inline, docked).
 * `durationFor` picks the slide length for a change; 0 skips it.
 */
export function useDraftHeroLayoutTransition(
  layout: string,
  durationFor: (from: string, to: string) => number,
) {
  const durationForStable = useStableCallback(durationFor);
  const transitionGroupRef = useRef<HTMLDivElement | null>(null);
  const composerAnchorRef = useRef<HTMLDivElement | null>(null);
  const previousStateRef = useRef(layout);
  const previousComposerRectRef = useRef<DOMRect | null>(null);
  const animationRef = useRef<Animation | null>(null);
  const captureComposerRect = useStableCallback(() => {
    previousComposerRectRef.current = composerAnchorRef.current?.getBoundingClientRect() ?? null;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the committed composer rect and starts a FLIP Web Animation before paint
  useLayoutEffect(() => {
    const transitionGroup = transitionGroupRef.current;
    const nextComposerRect = composerAnchorRef.current?.getBoundingClientRect() ?? null;
    const stateChanged = previousStateRef.current !== layout;
    const animationDurationMs = stateChanged
      ? durationForStable(previousStateRef.current, layout)
      : 0;
    const mobileComposerTransitionActive =
      typeof document !== "undefined" &&
      document.documentElement.dataset.mobileComposerRouteTransition === "true";

    animationRef.current?.cancel();
    animationRef.current = null;
    const previousComposerRect = previousComposerRectRef.current;
    if (
      animationDurationMs > 0 &&
      !mobileComposerTransitionActive &&
      transitionGroup &&
      previousComposerRect &&
      nextComposerRect &&
      typeof transitionGroup.animate === "function"
    ) {
      const translateX = previousComposerRect.left - nextComposerRect.left;
      const translateY = previousComposerRect.top - nextComposerRect.top;
      if (Math.abs(translateX) >= 0.5 || Math.abs(translateY) >= 0.5) {
        const animation = transitionGroup.animate(
          [
            { transform: `translate3d(${translateX}px, ${translateY}px, 0)` },
            { transform: "translate3d(0, 0, 0)" },
          ],
          {
            duration: animationDurationMs,
            easing: DRAFT_HERO_TRANSITION_EASING,
          },
        );
        animation.id = DRAFT_HERO_TRANSITION_ANIMATION_ID;
        animationRef.current = animation;
        void animation.finished
          .catch(() => undefined)
          .then(() => {
            if (animationRef.current === animation) animationRef.current = null;
          });
      }
    }
    previousStateRef.current = layout;
    previousComposerRectRef.current = nextComposerRect;
  }, [durationForStable, layout]);

  return { transitionGroupRef, composerAnchorRef, captureComposerRect } as const;
}
