import { describe, expect, it } from 'vitest';
import { clampNodePosition, findFreePosition } from './spawn-position';

describe('findFreePosition', () => {
  it('returns the desired point on an empty canvas', () => {
    expect(findFreePosition({ x: 100, y: 100 }, [])).toEqual({ x: 100, y: 100 });
  });

  it('steps right when the desired cell is taken', () => {
    const p = findFreePosition({ x: 100, y: 100 }, [{ x: 100, y: 100 }]);
    expect(p).toEqual({ x: 440, y: 100 });
  });

  it('wraps to the next row when the whole row is taken', () => {
    const taken = [
      { x: 100, y: 100 },
      { x: 440, y: 100 },
      { x: 780, y: 100 },
    ];
    expect(findFreePosition({ x: 100, y: 100 }, taken)).toEqual({ x: 100, y: 396 });
  });

  it('a nearby (not exact) node blocks its cell and the adjacent one it bleeds into', () => {
    // a node at x=140 spans ~300px wide, so it also overlaps the cell at x=440
    const p = findFreePosition({ x: 100, y: 100 }, [{ x: 140, y: 130 }]);
    expect(p).toEqual({ x: 780, y: 100 });
  });

  it('far-away nodes do not block', () => {
    const p = findFreePosition({ x: 100, y: 100 }, [{ x: 2000, y: 2000 }]);
    expect(p).toEqual({ x: 100, y: 100 });
  });
});

describe('clampNodePosition', () => {
  const size = { width: 320, height: 280 };
  const bounds = { left: 20, top: 70, right: 1420, bottom: 770 };

  it('keeps a point that already leaves the whole node visible', () => {
    expect(clampNodePosition({ x: 400, y: 300 }, size, bounds)).toEqual({ x: 400, y: 300 });
  });

  it('moves a dropped node above the fixed bottom controls', () => {
    expect(clampNodePosition({ x: 240, y: 620 }, size, bounds)).toEqual({ x: 240, y: 490 });
  });

  it('also protects the top and horizontal canvas edges', () => {
    expect(clampNodePosition({ x: -100, y: -40 }, size, bounds)).toEqual({ x: 20, y: 70 });
    expect(clampNodePosition({ x: 1400, y: 200 }, size, bounds)).toEqual({ x: 1100, y: 200 });
  });
});
