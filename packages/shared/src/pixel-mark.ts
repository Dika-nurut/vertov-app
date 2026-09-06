// SPEC 11-04 «Инверсия · барвинковая плита» (owner pick 2026-07-10) — the final
// logo mark. A 12×12 periwinkle plate with the asterism constellation punched out
// as negative space (bg holes) + a companion bone star. Fills are literal brand
// hex (asset geometry, not themeable) and map to --color-accent / --color-bg /
// --color-line respectively.
//
// Lives in @seed/shared so every app (web header, api, the worker's free-tier
// watermark) draws from the SAME geometry — scaled, never redrawn.
export interface MarkRect {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}
export const MARK_PLATE = '#8d76f6'; // --color-accent
export const MARK_HOLE = '#0c0e12'; // --color-bg
export const MARK_COMPANION = '#eceef3'; // --color-line / bone
export const MARK_RECTS: readonly MarkRect[] = [
  { x: 0, y: 0, w: 12, h: 12, fill: MARK_PLATE },
  { x: 3, y: 1, w: 1, h: 5, fill: MARK_HOLE },
  { x: 1, y: 3, w: 5, h: 1, fill: MARK_HOLE },
  { x: 2, y: 2, w: 3, h: 3, fill: MARK_HOLE },
  { x: 9, y: 7, w: 1, h: 3, fill: MARK_COMPANION },
  { x: 8, y: 8, w: 3, h: 1, fill: MARK_COMPANION },
  { x: 9, y: 2, w: 1, h: 1, fill: MARK_HOLE },
  { x: 2, y: 9, w: 1, h: 1, fill: MARK_HOLE },
];

/** Serialise the final mark to a standalone SVG string (favicon / <img> asset). */
export function markSvg(size = 96): string {
  const rects = MARK_RECTS.map(
    (r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.fill}"/>`,
  ).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 12 12" shape-rendering="crispEdges">${rects}</svg>`
  );
}
