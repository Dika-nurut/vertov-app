// Vertov pixel-glyph geometry — the single source of truth for the icon system.
//
// The coordinates below are copied verbatim from the design-workbook (SPEC 06-05
// pixel-glyph family, SPEC 04-02 token star, SPEC 11-04 final mark). Per the Bible
// they are scaled, never redrawn, never substituted from an icon pack — `lucide`
// is banned (docket D6). Where a control needs a symbol the family does not yet
// carry, call sites fall back to Phosphor **bold**, never lucide.
//
// A glyph is a list of filled 1×1 cells [x, y] on a 7×7 grid (0..6).

export type Cell = readonly [x: number, y: number];

// SPEC 06-05 — the 13 approved glyphs, keyed by a stable English name.
// (Russian label from the workbook in the trailing comment.)
export const PIXEL_GLYPHS = {
  image: [
    [0, 0],
    [0, 6],
    [1, 0],
    [1, 6],
    [2, 0],
    [2, 6],
    [3, 0],
    [3, 6],
    [4, 0],
    [4, 6],
    [5, 0],
    [5, 6],
    [6, 0],
    [6, 6],
    [0, 1],
    [6, 1],
    [0, 2],
    [6, 2],
    [0, 3],
    [6, 3],
    [0, 4],
    [6, 4],
    [0, 5],
    [6, 5],
    [2, 2],
    [4, 3],
    [3, 4],
    [4, 4],
  ], // изображение
  video: [
    [3, 1],
    [3, 2],
    [3, 3],
    [3, 4],
    [3, 5],
    [4, 2],
    [4, 3],
    [4, 4],
    [5, 3],
  ], // видео
  upload: [
    [3, 0],
    [2, 1],
    [4, 1],
    [1, 2],
    [5, 2],
    [3, 1],
    [3, 2],
    [3, 3],
    [3, 4],
    [0, 5],
    [0, 6],
    [1, 6],
    [2, 6],
    [3, 6],
    [4, 6],
    [5, 6],
    [6, 6],
    [6, 5],
  ], // загрузить
  add: [
    [3, 1],
    [3, 2],
    [3, 3],
    [3, 4],
    [3, 5],
    [1, 3],
    [2, 3],
    [4, 3],
    [5, 3],
  ], // добавить
  remove: [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [5, 5],
    [5, 1],
    [4, 2],
    [2, 4],
    [1, 5],
  ], // убрать
  expand: [
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 3],
    [5, 2],
  ], // раскрыть
  catalog: [
    [2, 1],
    [3, 2],
    [4, 3],
    [3, 4],
    [2, 5],
  ], // каталог
  create: [
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
    [4, 3],
    [4, 1],
    [5, 2],
    [6, 3],
    [5, 4],
    [4, 5],
  ], // создать
  random: [
    [0, 0],
    [0, 6],
    [1, 0],
    [1, 6],
    [2, 0],
    [2, 6],
    [3, 0],
    [3, 6],
    [4, 0],
    [4, 6],
    [5, 0],
    [5, 6],
    [6, 0],
    [6, 6],
    [0, 1],
    [6, 1],
    [0, 2],
    [6, 2],
    [0, 3],
    [6, 3],
    [0, 4],
    [6, 4],
    [0, 5],
    [6, 5],
    [2, 2],
    [3, 3],
    [4, 4],
  ], // случайно
  length: [
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
    [5, 0],
    [2, 1],
    [3, 1],
    [4, 1],
    [3, 2],
    [3, 3],
    [2, 4],
    [3, 4],
    [4, 4],
    [1, 5],
    [2, 5],
    [3, 5],
    [4, 5],
    [5, 5],
  ], // длина
  draft: [
    [1, 1],
    [2, 2],
    [3, 3],
    [2, 4],
    [1, 5],
    [3, 1],
    [4, 2],
    [5, 3],
    [4, 4],
    [3, 5],
  ], // черновик
  sound: [
    [1, 3],
    [1, 4],
    [1, 5],
    [3, 1],
    [3, 2],
    [3, 3],
    [3, 4],
    [3, 5],
    [5, 2],
    [5, 3],
    [5, 4],
    [5, 5],
  ], // звук
  effect: [
    [1, 5],
    [2, 4],
    [3, 3],
    [4, 2],
    [5, 1],
    [6, 0],
    [5, 3],
    [3, 5],
  ], // эффект
} as const satisfies Record<string, readonly Cell[]>;

export type PixelGlyphName = keyof typeof PIXEL_GLYPHS;

export const PIXEL_GLYPH_NAMES = Object.keys(PIXEL_GLYPHS) as PixelGlyphName[];

// SPEC 04-02 — the token star, the ONE currency glyph. 5×5 grid; a 3×3 core with
// four single-cell points (a filled diamond). Cells are [x, y, w, h].
export type Rect = readonly [x: number, y: number, w: number, h: number];
export const TOKEN_STAR_RECTS: readonly Rect[] = [
  [1, 1, 3, 3],
  [2, 0, 1, 1],
  [2, 4, 1, 1],
  [0, 2, 1, 1],
  [4, 2, 1, 1],
];

// SPEC 11-04 mark geometry moved to @seed/shared/pixel-mark (single source
// for web header AND the worker watermark) — re-exported here so existing
// imports keep working.
export {
  MARK_COMPANION,
  MARK_HOLE,
  MARK_PLATE,
  MARK_RECTS,
  markSvg,
} from '@seed/shared/pixel-mark';
export type { MarkRect } from '@seed/shared/pixel-mark';
