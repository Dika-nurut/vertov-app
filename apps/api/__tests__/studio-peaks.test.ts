import { describe, expect, it } from 'vitest';
import { bucketPeaks, PEAK_BUCKETS } from '../src/studio';

/**
 * Server-side waveform peaks (review #1): the API decodes an asset's audio ONCE
 * with ffmpeg and caches a peaks sidecar, so the browser no longer downloads
 * whole media just to draw a timeline waveform. `bucketPeaks` is the pure core
 * of that pipeline (PCM → normalized buckets); the ffmpeg/MinIO I/O around it is
 * exercised by the live e2e harness. This pins the maths so a refactor can't
 * silently break the waveform shape.
 */
describe('bucketPeaks', () => {
  it('returns [] for an empty buffer', () => {
    expect(bucketPeaks(new Float32Array(0))).toEqual([]);
  });

  it('emits all-zero peaks for digital silence (no divide-by-zero)', () => {
    const p = bucketPeaks(new Float32Array(1000));
    expect(p.length).toBe(PEAK_BUCKETS);
    expect(p.every((v) => v === 0)).toBe(true);
  });

  it('normalizes so the loudest bucket is 1 and quieter buckets scale down', () => {
    const s = new Float32Array(PEAK_BUCKETS * 2); // 2 samples / bucket
    s[0] = 0.25; // bucket 0
    s[2] = 0.5; // bucket 1 — global max
    const p = bucketPeaks(s);
    expect(p.length).toBe(PEAK_BUCKETS);
    expect(p[1]).toBe(1); // loudest → 1.0
    expect(p[0]).toBe(0.5); // 0.25 / 0.5
    expect(p[2]).toBe(0); // silent bucket
  });

  it('uses absolute amplitude (negative samples count)', () => {
    const s = new Float32Array(PEAK_BUCKETS * 2);
    s[0] = -1;
    expect(bucketPeaks(s)[0]).toBe(1);
  });

  it('honours a custom bucket count', () => {
    const s = new Float32Array(100).fill(0.3);
    expect(bucketPeaks(s, 10).length).toBe(10);
  });

  it('rounds peaks to 3 decimal places to keep the sidecar small', () => {
    const s = new Float32Array(PEAK_BUCKETS * 2);
    s[0] = 1; // max
    s[2] = 1 / 3; // 0.3333… → 0.333 after normalize + round
    expect(bucketPeaks(s)[1]).toBe(0.333);
  });
});
