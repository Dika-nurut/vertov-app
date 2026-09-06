// PenMaskLayer — the on-canvas draw surface for the freeform (pen) mask.
// Renders over the preview frame while the pen tool is active: a click-capture
// surface, the in-progress dashed path / closed polygon with the approved
// evenodd darken-outside preview, square anchor handles (gizmo language), and a
// small action bar. Purely presentational — all state/logic lives in usePenMask.
'use client';

import { Check, PenNib, X } from '../_icons';
import type { PenMask } from '../usePenMask';

/** SVG path `d` for the polygon in the 0–100 viewBox (points are 0–1). */
function polyPath(points: { x: number; y: number }[]): string {
  return (
    points
      .map((p, i) => `${i ? 'L' : 'M'}${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`)
      .join(' ') + ' Z'
  );
}

export function PenMaskLayer({ pen }: { pen: PenMask }) {
  const { points, closed, canClose } = pen;
  const d = points.length >= 3 ? polyPath(points) : '';
  return (
    <div className="pointer-events-none absolute inset-0 z-[60]" data-testid="pen-mask-layer">
      {/* Click-capture surface — normalizes the pointer to frame fractions. */}
      {!closed && (
        <div
          data-testid="pen-capture"
          className="pointer-events-auto absolute inset-0 cursor-crosshair touch-none"
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            pen.addPointAt(e.clientX, e.clientY);
          }}
        />
      )}

      {/* Path + darken-outside preview (evenodd: full-frame rect minus polygon). */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        {closed && d && (
          <path
            fillRule="evenodd"
            fill="rgba(0,0,0,0.45)"
            d={`M0,0 H100 V100 H0 Z ${d}`}
            data-testid="pen-darken"
          />
        )}
        {closed && d ? (
          <path
            d={d}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          points.length >= 2 && (
            <polyline
              points={points.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={2}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          )
        )}
      </svg>

      {/* Anchor handles — mirror the gizmo's square accent handles. */}
      {points.map((p, i) => (
        <span
          key={i}
          data-testid="pen-anchor"
          className={
            'pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border-2 border-[color:var(--color-accent)] ' +
            (i === 0 && canClose ? 'bg-[color:var(--color-accent)]' : 'bg-white')
          }
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
        />
      ))}

      {/* Action bar — close / apply / cancel. */}
      <div className="pointer-events-auto absolute bottom-2 left-1/2 z-[61] flex -translate-x-1/2 items-center gap-1 rounded-[var(--radius-md)] bg-black/85 px-1.5 py-1 shadow-[var(--offset-sm)]">
        <span className="px-1.5 font-mono text-[11px] text-white/70">
          <PenNib size={12} className="mr-1 inline align-[-1px]" />
          {points.length}
        </span>
        {!closed && (
          <button
            type="button"
            data-testid="pen-close"
            disabled={!canClose}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={pen.closePath}
            className="rounded-[var(--radius-sm)] px-2 py-1 text-[13px] font-semibold text-white/85 enabled:hover:bg-white/15 disabled:opacity-40"
          >
            Замкнуть
          </button>
        )}
        {closed && (
          <button
            type="button"
            data-testid="pen-apply"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={pen.commit}
            className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] px-2 py-1 text-[13px] font-semibold text-[color:var(--color-accent)] hover:bg-white/15"
          >
            <Check size={13} /> Применить
          </button>
        )}
        <button
          type="button"
          data-testid="pen-cancel"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={pen.cancel}
          className="grid h-6 w-6 place-items-center rounded-[var(--radius-sm)] text-white/70 hover:bg-white/15 hover:text-white"
          title="Отмена (Esc)"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
