import { describe, expect, it } from 'vitest';
import { placeAnchoredPanel, type RectLike } from './use-anchored-position';

const viewport = { width: 390, height: 844 };
const anchor = (top: number, bottom: number): RectLike => ({
  top,
  right: 260,
  bottom,
  left: 120,
  width: 140,
  height: bottom - top,
});

describe('useAnchoredPosition placement', () => {
  it('places a panel below a target when the lower viewport has room', () => {
    const result = placeAnchoredPanel(anchor(160, 208), { width: 300, height: 100 }, viewport);

    expect(result.side).toBe('bottom');
    expect(result.top).toBe(220);
    expect(result.anchor).toEqual(anchor(160, 208));
  });

  it('flips above a target when the target is near the bottom edge', () => {
    const result = placeAnchoredPanel(anchor(700, 748), { width: 300, height: 110 }, viewport);

    expect(result.side).toBe('top');
    expect(result.top).toBe(578);
    expect(result.top + 110).toBeLessThanOrEqual(700 - 12);
  });

  it('centers a surface when no anchor is available', () => {
    const result = placeAnchoredPanel(null, { width: 300, height: 100 }, viewport);

    expect(result.side).toBe('center');
    expect(result.top).toBe(372);
    expect(result.arrowX).toBeNull();
  });
});
