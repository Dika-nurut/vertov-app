'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CaretDown as ChevronDown, X } from '@phosphor-icons/react/dist/ssr';

/**
 * Compact control: an icon + value well that opens a popover. The popover is
 * rendered in a PORTAL with fixed positioning so it escapes the dock panel's
 * `overflow-hidden` (otherwise dropdowns get clipped / break). It flips up when
 * the trigger sits low, flips to the right edge when the trigger sits right, and
 * caps its height to the viewport (internal scroll) so tall content always fits.
 *
 * `children` is a render-prop receiving `close()` so an option can dismiss the
 * popover on select.
 */
type Pos = {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  maxHeight: number;
};

export function PillControl({
  icon,
  label,
  value,
  children,
  width = 'w-[16rem]',
  active = false,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  children: (close: () => void) => ReactNode;
  width?: string;
  /** Kept for source compatibility; alignment is now computed automatically. */
  align?: 'left' | 'right';
  active?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const [mobile, setMobile] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Compute a viewport-anchored position from the trigger rect: flip up if low,
  // flip right if the trigger sits in the right half, cap height to the viewport.
  function place() {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (vw < 640) {
      setMobile(true);
      setPos({ maxHeight: Math.round(vh * 0.7) });
      return;
    }
    setMobile(false);
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
  }

  function openMenu() {
    if (open) {
      setOpen(false);
      return;
    }
    place();
    setOpen(true);
  }

  // Reposition while open (scroll/resize) so the popover stays glued to the
  // trigger even if the dock or page scrolls. Capture-phase catches nested
  // scroll containers.
  useEffect(() => {
    if (!open) return;
    const onMove = () => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div className="relative">
      {/* Calm well trigger — borderless surface2 fill at rest, the one periwinkle
          fill when open/active. Icon + value only (no name label). */}
      <button
        ref={btnRef}
        type="button"
        onClick={openMenu}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={
          'press-inset flex h-9 w-full items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 text-[13px] text-foreground outline-none transition-colors duration-150 ' +
          (open || active
            ? 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
            : 'bg-[color:var(--color-surface2)] hover:bg-[color:var(--color-surface)]')
        }
      >
        <span
          className={
            'shrink-0 ' +
            (open || active
              ? 'text-[color:var(--color-primary-foreground)]'
              : 'text-[color:var(--color-muted-foreground)]')
          }
        >
          {icon}
        </span>
        <span
          className={
            'tnum flex-1 truncate text-left font-semibold ' +
            (open || active
              ? 'text-[color:var(--color-primary-foreground)]'
              : 'text-[color:var(--color-fg)]')
          }
        >
          {value}
        </span>
        <ChevronDown
          size={14}
          className={
            'shrink-0 transition-transform duration-200 ' +
            (open || active ? 'text-[color:var(--color-primary-foreground)] ' : 'opacity-60 ') +
            (open ? 'rotate-180' : '')
          }
        />
      </button>

      {open &&
        pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            {/* Scrim — catches outside clicks; dimmed on mobile behind the sheet. */}
            <button
              type="button"
              aria-label="Закрыть"
              onClick={() => setOpen(false)}
              className={
                'fixed inset-0 z-[60] ' + (mobile ? 'bg-black/60' : 'cursor-default bg-transparent')
              }
            />
            <div
              ref={popRef}
              role="menu"
              data-state="open"
              style={
                mobile
                  ? { maxHeight: pos.maxHeight }
                  : {
                      position: 'fixed',
                      top: pos.top,
                      bottom: pos.bottom,
                      left: pos.left,
                      right: pos.right,
                      maxHeight: pos.maxHeight,
                    }
              }
              className={
                mobile
                  ? 'ui-pop seed-pop-in fixed inset-x-0 bottom-0 z-[61] flex flex-col overflow-y-auto rounded-t-[var(--radius-md)] border-[2.5px] border-x-0 border-b-0 border-[color:var(--color-line)] bg-popover p-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] text-popover-foreground shadow-[var(--shadow-pop)]'
                  : `ui-pop seed-pop-in z-[61] ${width} max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-popover p-2.5 text-popover-foreground shadow-[var(--shadow-pop)]`
              }
            >
              {/* Bottom-sheet header — mobile only. */}
              {mobile && (
                <div className="mb-3 flex shrink-0 items-center justify-between">
                  <span className="flex items-center gap-2 font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-fg)]">
                    <span className="text-[color:var(--color-faint)]">{icon}</span>
                    {label}
                  </span>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="Закрыть"
                    className="press-inset grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
              {children(() => setOpen(false))}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
