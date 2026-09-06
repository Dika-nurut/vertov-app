import { describe, expect, it } from 'vitest';
import { computePeaks } from './waveform';

describe('computePeaks', () => {
  it('returns the requested number of buckets', () => {
    expect(computePeaks(new Float32Array(1000), 32)).toHaveLength(32);
    expect(computePeaks([0.1, 0.2, 0.3], 8)).toHaveLength(8);
  });

  it('yields all-zero buckets for empty input', () => {
    expect(computePeaks([], 4)).toEqual([0, 0, 0, 0]);
  });

  it('normalizes a constant-amplitude signal to all 1s', () => {
    const peaks = computePeaks(new Array(100).fill(0.5), 10);
    expect(peaks.every((p) => Math.abs(p - 1) < 1e-9)).toBe(true);
  });

  it('captures rising amplitude — last bucket is the loudest (=1)', () => {
    const ramp = Array.from({ length: 100 }, (_, i) => i / 100);
    const peaks = computePeaks(ramp, 10);
    expect(peaks[9]).toBeCloseTo(1, 5);
    expect(peaks[0]!).toBeLessThan(peaks[9]!);
  });

  it('uses absolute magnitude (negative samples count)', () => {
    const peaks = computePeaks([-1, 0, 0, 0], 1);
    expect(peaks[0]).toBeCloseTo(1, 9);
  });

  it('all peaks stay within [0,1]', () => {
    const noise = Array.from({ length: 500 }, (_, i) => Math.sin(i) * 0.8);
    for (const p of computePeaks(noise, 40)) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});
