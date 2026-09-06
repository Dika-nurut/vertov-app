import * as React from 'react';
import { cn } from '@/lib/utils';
import { MARK_RECTS } from '@/lib/pixel-glyph-data';

// Mark — the final Vertov logo symbol «Инверсия · барвинковая плита» (SPEC 11-04,
// owner pick 2026-07-10). Geometry is the exact 12×12 rect set; it is scaled,
// never redrawn. Replaces the retired orchid `/brand/logo.png`.
//
//  • `plate`  (default) — periwinkle plate, asterism punched out, bone companion.
//    Use on dark chrome as a standalone symbol.
//  • `quiet`  — no plate; just the constellation drawn in `currentColor`. Use it
//    next to the outline wordmark in-app so the plate doesn't double up.

export interface MarkProps extends React.SVGAttributes<SVGSVGElement> {
  variant?: 'plate' | 'quiet';
  /** Rendered box in px. Defaults to 24. */
  size?: number;
}

export function Mark({ variant = 'plate', size = 24, className, ...props }: MarkProps) {
  // The plate is the first rect; the constellation is everything drawn on top of it.
  const constellation = MARK_RECTS.slice(1);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      shapeRendering="crispEdges"
      className={cn('inline-block shrink-0', className)}
      {...props}
    >
      {variant === 'plate'
        ? MARK_RECTS.map((r, i) => (
            <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />
          ))
        : constellation.map((r, i) => (
            <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill="currentColor" />
          ))}
    </svg>
  );
}
