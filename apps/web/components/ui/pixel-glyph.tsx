import * as React from 'react';
import { cn } from '@/lib/utils';
import { PIXEL_GLYPHS, type PixelGlyphName } from '@/lib/pixel-glyph-data';

// PixelGlyph — the Vertov icon primitive (SPEC 06-05, docket D6). Renders one of
// the approved 7×7 glyphs from its exact workbook coordinates in `currentColor`,
// with `shape-rendering:crispEdges` so the pixels stay hard at any size. lucide is
// banned; where the family lacks a symbol, call sites use Phosphor **bold**, not
// this component.
//
// Icon-only controls MUST pass an accessible label via `aria-label` (or set
// `aria-hidden` when the glyph is decorative next to a text label).

export interface PixelGlyphProps extends React.SVGAttributes<SVGSVGElement> {
  name: PixelGlyphName;
  /** Rendered box in px (the glyph grid is 7×7). Defaults to 16. */
  size?: number;
}

export function PixelGlyph({ name, size = 16, className, ...props }: PixelGlyphProps) {
  const cells = PIXEL_GLYPHS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 7 7"
      fill="currentColor"
      shapeRendering="crispEdges"
      className={cn('inline-block shrink-0', className)}
      {...props}
    >
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />
      ))}
    </svg>
  );
}
