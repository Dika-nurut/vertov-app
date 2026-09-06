'use client';

// Viewport-anchored menu for board-canvas node dropdowns.
//
// WHY: an `absolute` menu inside a ReactFlow node is clipped by the canvas
// wrapper (`overflow-hidden`) whenever its node sits near a viewport edge or
// the canvas is zoomed, and it slides (jitters) with every pan while open.
// A body portal with fixed positioning never clips; like the canonical
// generate/PillControl popover it flips up when the trigger sits low, flips
// to the right edge when the trigger sits right, caps its height to the
// viewport (internal scroll), and dismisses on outside press (transparent
// scrim) / Escape. Canvas interaction while open dismisses first (the scrim
// takes the press), so the menu never tracks a moving node — it closes
// instead, exactly like PillControl's scrim dismissal.
//
// Contract mirrors PillControl: `anchorRef` is the trigger (or its box),
// `maxMenuHeight` is the menu's natural cap (the old fixed max-h), and the
// menu keeps its exact visual classes/testids — only the positioning moves
// from `absolute`-in-node to `fixed`-in-portal.
import {
  useEffect,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

type Pos = {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  maxHeight: number;
};

export function NodeMenu({
  anchorRef,
  open,
  onClose,
  children,
  className = 'glass-menu p-1.5',
  maxMenuHeight = null,
  widthClass = null,
  role = 'menu',
  testid,
  ariaLabel,
  divProps,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Visual classes of the menu (the old `glass-menu …` set minus the
   * `absolute … top-… z-…` positioning, which the portal owns now). */
  className?: string;
  /** Natural height cap (the old fixed `max-h-[Npx]`, in px). The rendered cap
   * is min(natural, viewport-derived) so the menu keeps its exact size until
   * the viewport forces it shorter. Null = viewport-derived only. */
  maxMenuHeight?: number | null;
  /** Fixed-width override (e.g. `w-[180px]`). Default matches the anchor
   * width (the old menus spanned their trigger box), clamped to the viewport. */
  widthClass?: string | null;
  /** ARIA role of the menu element (`menu` default; `listbox` for selects). */
  role?: string;
  /** data-testid for the menu element (kept where e2e addresses the menu). */
  testid?: string;
  /** Accessible label for the menu element. */
  ariaLabel?: string;
  /** Extra props for the menu element (e.g. the `useWheelScroll` spread —
   * harmless in a portal, kept so call-sites move verbatim). */
  divProps?: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> };
}) {
  const [pos, setPos] = useState<Pos | null>(null);
  const [anchorW, setAnchorW] = useState<number | null>(null);

  // Viewport-anchored position from the trigger rect — PillControl's rule
  // verbatim: flip up when the trigger sits low, right-align when it sits
  // right, cap height to the viewport.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const gap = 6;
      const openUp = r.bottom > vh * 0.62;
      const alignRight = r.left + r.width / 2 > vw * 0.55;
      const viewportMax = openUp
        ? Math.round(r.top - gap - 8)
        : Math.round(vh - r.bottom - gap - 8);
      const maxHeight = Math.max(
        48,
        maxMenuHeight == null ? viewportMax : Math.min(maxMenuHeight, viewportMax),
      );
      const next: Pos = { maxHeight };
      if (openUp) next.bottom = Math.round(vh - r.top + gap);
      else next.top = Math.round(r.bottom + gap);
      if (alignRight) next.right = Math.round(vw - r.right);
      else next.left = Math.round(r.left);
      setPos(next);
      setAnchorW(Math.round(r.width));
    };
    place();
    // Capture phase catches nested scrollers (the node settings panel); the
    // canvas pan itself dismisses via the scrim instead of tracking.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, anchorRef, maxMenuHeight]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [open, onClose]);

  if (!open || !pos || typeof document === 'undefined') return null;
  return createPortal(
    <>
      {/* Scrim — PillControl parity: a transparent full-viewport press-catcher
          (no dim over the canvas) so any outside press dismisses instead of
          reaching the node/canvas underneath. `data-state` is load-bearing:
          globals.css lifts `body > *:not([data-state])` to position:relative
          in UNLAYERED css, which would override Tailwind's layered `.fixed`
          and collapse this button to the page bottom (the same footgun
          already neuters PillControl's own scrim — its dismissal survives via
          its document mousedown handler; this menu relies on the scrim, so
          the attribute stays). */}
      <button
        type="button"
        aria-label="Закрыть"
        data-state="open"
        onClick={onClose}
        onContextMenu={(e) => e.preventDefault()}
        className="fixed inset-0 z-[60] cursor-default bg-transparent"
      />
      <div
        role={role}
        data-state="open"
        data-testid={testid}
        aria-label={ariaLabel}
        {...divProps}
        style={{
          position: 'fixed',
          top: pos.top,
          bottom: pos.bottom,
          left: pos.left,
          right: pos.right,
          maxHeight: pos.maxHeight,
          // Match the old full-trigger-box width unless overridden; clamp to
          // the viewport so a wide node near an edge never overflows.
          ...(widthClass
            ? undefined
            : anchorW != null
              ? { width: Math.max(160, Math.min(anchorW, window.innerWidth - 24)) }
              : undefined),
        }}
        className={`ui-pop seed-pop-in seed-scroll z-[61] max-w-[calc(100vw-1.5rem)] overflow-y-auto ${widthClass ?? ''} ${className}`}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
