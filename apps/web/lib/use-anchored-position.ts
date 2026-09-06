'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface RectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface FloatingSize {
  width: number;
  height: number;
}

export interface AnchoredPlacement {
  top: number;
  left: number;
  side: 'top' | 'bottom' | 'center';
  arrowX: number | null;
  anchor: RectLike | null;
}

const VIEWPORT_PADDING = 12;
const ANCHOR_GAP = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function viewportRect(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

function elementRect(target: string | null): RectLike | null {
  if (!target) return null;
  const element = Array.from(document.querySelectorAll<HTMLElement>('[data-tour-target]')).find(
    (candidate) => candidate.dataset.tourTarget === target,
  );
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

/** Pure placement rule: prefer below, flip above when the lower viewport is too short. */
export function placeAnchoredPanel(
  anchor: RectLike | null,
  panel: FloatingSize,
  viewport: { width: number; height: number },
  preferred: 'top' | 'bottom' = 'bottom',
): AnchoredPlacement {
  const width = Math.min(panel.width, Math.max(0, viewport.width - VIEWPORT_PADDING * 2));
  const height = Math.min(panel.height, Math.max(0, viewport.height - VIEWPORT_PADDING * 2));

  if (!anchor) {
    return {
      top: Math.max(VIEWPORT_PADDING, (viewport.height - height) / 2),
      left: Math.max(VIEWPORT_PADDING, (viewport.width - width) / 2),
      side: 'center',
      arrowX: null,
      anchor: null,
    };
  }

  const belowSpace = viewport.height - VIEWPORT_PADDING - anchor.bottom - ANCHOR_GAP;
  const aboveSpace = anchor.top - VIEWPORT_PADDING - ANCHOR_GAP;
  const side: 'top' | 'bottom' =
    preferred === 'bottom'
      ? belowSpace >= height || belowSpace >= aboveSpace
        ? 'bottom'
        : 'top'
      : aboveSpace >= height || aboveSpace >= belowSpace
        ? 'top'
        : 'bottom';
  const rawTop = side === 'bottom' ? anchor.bottom + ANCHOR_GAP : anchor.top - height - ANCHOR_GAP;
  const top = clamp(rawTop, VIEWPORT_PADDING, viewport.height - height - VIEWPORT_PADDING);
  const left = clamp(
    anchor.left + anchor.width / 2 - width / 2,
    VIEWPORT_PADDING,
    viewport.width - width - VIEWPORT_PADDING,
  );

  return {
    top,
    left,
    side,
    arrowX: clamp(anchor.left + anchor.width / 2 - left, 14, width - 14),
    anchor,
  };
}

/** Position a fixed surface against a `data-tour-target`, with a centered fallback. */
export function useAnchoredPosition(target: string | null, active: boolean) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<AnchoredPlacement | null>(null);

  const measure = useCallback(() => {
    const panel = panelRef.current;
    if (!panel || !active) return;
    const rect = panel.getBoundingClientRect();
    setPlacement(
      placeAnchoredPanel(
        elementRect(target),
        { width: rect.width, height: rect.height },
        viewportRect(),
      ),
    );
  }, [active, target]);

  useEffect(() => {
    if (!active) {
      setPlacement(null);
      return;
    }
    measure();
    const frame = window.requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const observed = Array.from(document.querySelectorAll<HTMLElement>('[data-tour-target]')).find(
      (candidate) => candidate.dataset.tourTarget === target,
    );
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (observer) {
      observer.observe(panelRef.current!);
      if (observed) observer.observe(observed);
    }
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      observer?.disconnect();
    };
  }, [active, measure, target]);

  return { panelRef, placement };
}
