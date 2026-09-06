import * as React from 'react';
import { cn } from '@/lib/utils';
import { TOKEN_STAR_RECTS } from '@/lib/pixel-glyph-data';

// TokenStar — the ONE currency glyph (SPEC 04-02, docket D13). It precedes a mono
// `tnum` token figure in chips and readouts; prose uses the full word «токенов».
// Never abbreviate to «тк»/«кр». Renders in `currentColor` (tint at the call site)
// with crisp pixels.

export interface TokenStarProps extends React.SVGAttributes<SVGSVGElement> {
  /** Rendered box in px (the star grid is 5×5). Defaults to 12. */
  size?: number;
}

export function TokenStar({ size = 12, className, ...props }: TokenStarProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 5 5"
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
      className={cn('inline-block shrink-0 align-[-0.1em]', className)}
      {...props}
    >
      {TOKEN_STAR_RECTS.map(([x, y, w, h]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} />
      ))}
    </svg>
  );
}
