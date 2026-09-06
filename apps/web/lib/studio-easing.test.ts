import { describe, expect, it } from 'vitest';
import { buildAnimKeyframesEased, easeSegment } from './studio-easing';
import { ANIM_PRESETS, buildAnimKeyframes } from '../app/studio/_model';

describe('easeSegment', () => {
  it('linear returns exactly the 2 endpoint keys', () => {
    const keys = easeSegment(0, 1, 0.1, 0.6, 'linear');
    expect(keys).toEqual([
      { t: 0.1, v: 0 },
      { t: 0.6, v: 1 },
    ]);
  });

  it('smooth returns 8 monotonically-increasing t keys hitting from/to exactly at endpoints', () => {
    const keys = easeSegment(0, 1, 0, 0.5, 'smooth');
    expect(keys).toHaveLength(8);
    for (let i = 1; i < keys.length; i++) expect(keys[i]!.t).toBeGreaterThan(keys[i - 1]!.t);
    expect(keys[0]).toEqual({ t: 0, v: 0 });
    expect(keys[keys.length - 1]).toEqual({ t: 0.5, v: 1 });
  });

  it('spring overshoot is clamped for scale (never <1 or >3), unclamped for posY within range', () => {
    // from/to close to the [1,3] ceiling so the spring overshoot pushes past it
    const scaleKeys = easeSegment(2.7, 3, 0, 0.5, 'spring', { min: 1, max: 3 });
    for (const k of scaleKeys) {
      expect(k.v).toBeGreaterThanOrEqual(1);
      expect(k.v).toBeLessThanOrEqual(3);
    }
    // without clamping, spring overshoot on this segment would exceed 3 mid-curve
    const unclamped = easeSegment(2.7, 3, 0, 0.5, 'spring');
    expect(unclamped.some((k) => k.v > 3)).toBe(true);

    // posY: spring overshoots past the 'to' value (0) — clamp range [-100,100] shouldn't touch it
    const posYKeys = easeSegment(30, 0, 0, 0.5, 'spring', { min: -100, max: 100 });
    expect(posYKeys.some((k) => k.v < 0)).toBe(true);
    const posYUnclamped = easeSegment(30, 0, 0, 0.5, 'spring');
    expect(posYKeys).toEqual(posYUnclamped); // range wide enough that clamping is a no-op here
  });
});

describe('buildAnimKeyframesEased', () => {
  it('windowing matches buildAnimKeyframes for linear (same t values, same preset)', () => {
    const preset = ANIM_PRESETS.find((p) => p.id === 'in-up')!;
    const linearRef = buildAnimKeyframes(preset, 4, 0.5);
    const eased = buildAnimKeyframesEased(preset, 4, 0.5, 'linear');
    expect(eased).toEqual(linearRef);
  });

  it('combo preset (in+out) stays at or under 24 keys per channel', () => {
    const preset = ANIM_PRESETS.find((p) => p.id === 'combo-zoom')!;
    const kf = buildAnimKeyframesEased(preset, 6, 1, 'spring');
    for (const ch of Object.keys(kf) as (keyof typeof kf)[]) {
      expect(kf[ch]!.length).toBeLessThanOrEqual(24);
    }
  });

  it('opacity stays within [0,1] for a fade preset under spring easing', () => {
    const preset = ANIM_PRESETS.find((p) => p.id === 'in-fade')!;
    const kf = buildAnimKeyframesEased(preset, 4, 0.5, 'spring');
    for (const k of kf.opacity ?? []) {
      expect(k.v).toBeGreaterThanOrEqual(0);
      expect(k.v).toBeLessThanOrEqual(1);
    }
  });
});
