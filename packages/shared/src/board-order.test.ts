import { describe, expect, it } from 'vitest';
import { compareBoardReadingOrder } from './board-order';

describe('compareBoardReadingOrder', () => {
  it('orders rows by y, then x', () => {
    const topRight = { id: 'top-right', position: { x: 500, y: 0 } };
    const bottomLeft = { id: 'bottom-left', position: { x: 100, y: 100 } };

    expect(compareBoardReadingOrder(topRight, bottomLeft)).toBeLessThan(0);
    expect(compareBoardReadingOrder(bottomLeft, topRight)).toBeGreaterThan(0);
  });

  it('orders left to right within one row', () => {
    const left = { id: 'z-left', position: { x: 100, y: 200 } };
    const right = { id: 'a-right', position: { x: 500, y: 200 } };

    // ids are reversed on purpose: x must decide before the id tie-break.
    expect(compareBoardReadingOrder(left, right)).toBeLessThan(0);
    expect(compareBoardReadingOrder(right, left)).toBeGreaterThan(0);
  });

  it('treats missing and non-finite coordinates as exactly zero', () => {
    const origin = { id: 'origin', position: { x: 0, y: 0 } };

    // Equal to an explicit 0,0 — so only the id tie-break separates them.
    expect(compareBoardReadingOrder({ id: 'aaa' }, origin)).toBeLessThan(0);
    expect(compareBoardReadingOrder({ id: 'zzz' }, origin)).toBeGreaterThan(0);
    expect(
      compareBoardReadingOrder(
        { id: 'aaa', position: { x: Number.NaN, y: Number.POSITIVE_INFINITY } },
        origin,
      ),
    ).toBeLessThan(0);
    expect(
      compareBoardReadingOrder(
        { id: 'zzz', position: { x: Number.NaN, y: Number.POSITIVE_INFINITY } },
        origin,
      ),
    ).toBeGreaterThan(0);
  });

  it('uses id as the tie-break for identical coordinates', () => {
    const a = { id: 'a', position: { x: 10, y: 20 } };
    const b = { id: 'b', position: { x: 10, y: 20 } };

    expect(compareBoardReadingOrder(b, a)).toBeGreaterThan(0);
    expect(compareBoardReadingOrder(a, b)).toBeLessThan(0);
  });
});
