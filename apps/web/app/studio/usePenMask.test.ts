import { describe, expect, it } from 'vitest';
import { shouldCancelDraw } from './usePenMask';

// Regression for: drawing on clip A, then selecting clip B mid-draw, used to
// commit A's polygon onto B (selectedClip was read at commit time, and the
// only cancel effect fired on selection→null, not selection→a-different-uid).
describe('shouldCancelDraw', () => {
  it('does not cancel while not drawing', () => {
    expect(shouldCancelDraw(false, null, 'a')).toBe(false);
    expect(shouldCancelDraw(false, 'a', null)).toBe(false);
  });

  it('does not cancel while drawing and the selection is unchanged', () => {
    expect(shouldCancelDraw(true, 'a', 'a')).toBe(false);
  });

  it('cancels when the selection is cleared mid-draw', () => {
    expect(shouldCancelDraw(true, 'a', null)).toBe(true);
    expect(shouldCancelDraw(true, 'a', undefined)).toBe(true);
  });

  it('cancels when the selection changes to a DIFFERENT clip mid-draw (the bug)', () => {
    expect(shouldCancelDraw(true, 'a', 'b')).toBe(true);
  });
});
