import { describe, expect, it } from 'vitest';
import {
  DESK_COLUMN_STEP,
  DESK_ROW_STEP,
  moveDeskItem,
  resolveDeskLayout,
  snapDeskPoint,
} from './desk-layout';

const bounds = { width: DESK_COLUMN_STEP * 3, height: DESK_ROW_STEP * 2 };

describe('desk layout', () => {
  it('preserves positioned objects and fills holes for new objects', () => {
    expect(
      resolveDeskLayout(
        ['new', 'old-b', 'old-a'],
        {
          'old-a': { x: DESK_COLUMN_STEP, y: 0 },
          'old-b': { x: DESK_COLUMN_STEP * 2, y: 0 },
        },
        bounds,
      ),
    ).toEqual({
      'old-a': { x: DESK_COLUMN_STEP, y: 0 },
      'old-b': { x: DESK_COLUMN_STEP * 2, y: 0 },
      new: { x: 0, y: 0 },
    });
  });

  it('resolves persisted collisions by stable identity', () => {
    const result = resolveDeskLayout(['z', 'a'], { z: { x: 0, y: 0 }, a: { x: 0, y: 0 } }, bounds);
    expect(result.a).toEqual({ x: 0, y: 0 });
    expect(result.z).toEqual({ x: DESK_COLUMN_STEP, y: 0 });
  });

  it('clamps positions after the usable bounds shrink', () => {
    expect(
      snapDeskPoint(
        { x: DESK_COLUMN_STEP * 20, y: DESK_ROW_STEP * 20 },
        { width: DESK_COLUMN_STEP * 2, height: DESK_ROW_STEP },
      ),
    ).toEqual({ x: DESK_COLUMN_STEP, y: 0 });
  });

  it('places a dragged item at its target without changing unrelated free cells', () => {
    const result = moveDeskItem(
      'b',
      { x: DESK_COLUMN_STEP * 2, y: 0 },
      {
        a: { x: 0, y: 0 },
        b: { x: DESK_COLUMN_STEP, y: 0 },
      },
      bounds,
    );
    expect(result).toEqual({
      a: { x: 0, y: 0 },
      b: { x: DESK_COLUMN_STEP * 2, y: 0 },
    });
  });

  it('moves a dragged item deterministically to the next cell when its target is occupied', () => {
    const result = moveDeskItem(
      'b',
      { x: 0, y: 0 },
      {
        a: { x: 0, y: 0 },
        b: { x: DESK_COLUMN_STEP * 2, y: 0 },
      },
      bounds,
    );
    expect(result.a).toEqual({ x: 0, y: 0 });
    expect(result.b).toEqual({ x: DESK_COLUMN_STEP, y: 0 });
  });
});
