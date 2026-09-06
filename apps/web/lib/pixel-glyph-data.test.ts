import { describe, expect, it } from 'vitest';
import {
  MARK_RECTS,
  markSvg,
  PIXEL_GLYPH_NAMES,
  PIXEL_GLYPHS,
  TOKEN_STAR_RECTS,
} from './pixel-glyph-data';

// These are golden assertions against the design-workbook coordinates (SPEC 06-05
// / 04-02 / 11-04). Per the Bible glyphs are "scaled, never redrawn" — so if a
// coordinate here ever changes, that is a drift against the source of truth and
// this test is the tripwire.

describe('pixel-glyph family (SPEC 06-05)', () => {
  it('ships exactly the 13 approved glyphs', () => {
    expect(PIXEL_GLYPH_NAMES).toEqual([
      'image',
      'video',
      'upload',
      'add',
      'remove',
      'expand',
      'catalog',
      'create',
      'random',
      'length',
      'draft',
      'sound',
      'effect',
    ]);
  });

  it('every cell sits on the 7×7 grid (0..6)', () => {
    for (const [name, cells] of Object.entries(PIXEL_GLYPHS)) {
      for (const [x, y] of cells) {
        expect(x, `${name} x`).toBeGreaterThanOrEqual(0);
        expect(x, `${name} x`).toBeLessThanOrEqual(6);
        expect(y, `${name} y`).toBeGreaterThanOrEqual(0);
        expect(y, `${name} y`).toBeLessThanOrEqual(6);
      }
    }
  });

  it('the video glyph is the play triangle from the workbook', () => {
    expect(PIXEL_GLYPHS.video).toEqual([
      [3, 1],
      [3, 2],
      [3, 3],
      [3, 4],
      [3, 5],
      [4, 2],
      [4, 3],
      [4, 4],
      [5, 3],
    ]);
  });

  it('add is a plus, remove is an ×', () => {
    // plus: full vertical + full horizontal through the centre
    expect(PIXEL_GLYPHS.add).toContainEqual([3, 3]);
    expect(PIXEL_GLYPHS.add.filter(([x]) => x === 3)).toHaveLength(5);
    // × has no centre-row/col fill except the shared diagonal crossing at (3,3)
    expect(PIXEL_GLYPHS.remove).toContainEqual([3, 3]);
    expect(PIXEL_GLYPHS.remove).toHaveLength(9);
  });
});

describe('token star (SPEC 04-02)', () => {
  it('is a 3×3 core with four single-cell points', () => {
    expect(TOKEN_STAR_RECTS).toEqual([
      [1, 1, 3, 3],
      [2, 0, 1, 1],
      [2, 4, 1, 1],
      [0, 2, 1, 1],
      [4, 2, 1, 1],
    ]);
  });
});

describe('final mark (SPEC 11-04)', () => {
  it('has the plate, the punched asterism, and the bone companion', () => {
    expect(MARK_RECTS[0]).toEqual({ x: 0, y: 0, w: 12, h: 12, fill: '#8d76f6' });
    // exactly two bone companion rects
    expect(MARK_RECTS.filter((r) => r.fill === '#eceef3')).toHaveLength(2);
    // five holes carved in bg colour
    expect(MARK_RECTS.filter((r) => r.fill === '#0c0e12')).toHaveLength(5);
  });

  it('serialises to a crisp 12×12-viewBox svg', () => {
    const svg = markSvg(48);
    expect(svg).toContain('viewBox="0 0 12 12"');
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('width="48"');
    expect(svg.match(/<rect /g) ?? []).toHaveLength(MARK_RECTS.length);
  });
});
