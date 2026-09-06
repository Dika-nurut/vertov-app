'use client';

// Anchored popover rendered in a PORTAL to document.body with fixed positioning,
// so menus opened from inside the editor's `overflow-hidden`/`overflow-auto`
// zones (canvas, header) never clip or jitter. Distilled from the canonical
// generate/PillControl pattern: flip up when the trigger sits low, flip to the
// right edge when it sits right, cap height to the viewport, close on outside
// click / Escape, and reposition on scroll/resize (capture phase catches nested
// scrollers).
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

type Pos = { top?: number; bottom?: number; left?: number; right?: number; maxHeight: number };

export function PortalMenu({
  anchorRef,
  open,
  onClose,
  children,
  width = 'w-52',
  testid,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  testid?: string;
}) {
  const [pos, setPos] = useState<Pos | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

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
      const next: Pos = {
        maxHeight: openUp ? Math.round(r.top - gap - 8) : Math.round(vh - r.bottom - gap - 8),
      };
      if (openUp) next.bottom = Math.round(vh - r.top + gap);
      else next.top = Math.round(r.bottom + gap);
      if (alignRight) next.right = Math.round(vw - r.right);
      else next.left = Math.round(r.left);
      setPos(next);
    };
    place();
    const onMove = () => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !pos || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={popRef}
      role="menu"
      data-testid={testid}
      style={{
        position: 'fixed',
        top: pos.top,
        bottom: pos.bottom,
        left: pos.left,
        right: pos.right,
        maxHeight: pos.maxHeight,
      }}
      className={`ui-pop seed-pop-in z-[81] ${width} max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-popover p-1.5 text-popover-foreground shadow-[var(--shadow-pop)]`}
    >
      {children}
    </div>,
    document.body,
  );
}
