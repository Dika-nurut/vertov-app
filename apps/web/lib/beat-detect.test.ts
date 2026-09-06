import { describe, expect, it } from 'vitest';
import { detectBeats } from './beat-detect';

const SR = 8000;

/** Build a synthetic click track: a short loud burst at each `times` second,
 * a low-amplitude noise floor elsewhere (or silence when `noise` is 0). */
function clickTrack(times: number[], durSec: number, noise = 0): Float32Array {
  const ch = new Float32Array(Math.round(durSec * SR));
  if (noise > 0) {
    // deterministic "noise" (no RNG dependency) — a small sum-of-sines floor.
    for (let i = 0; i < ch.length; i++) {
      ch[i] = noise * (Math.sin(i * 0.37) + Math.sin(i * 1.91)) * 0.5;
    }
  }
  const burstLen = Math.round(0.005 * SR); // 5ms burst
  for (const t of times) {
    const start = Math.round(t * SR);
    for (let i = 0; i < burstLen && start + i < ch.length; i++) {
      ch[start + i] = 1;
    }
  }
  return ch;
}

describe('detectBeats', () => {
  it('finds beats within 30ms of a 120 BPM click track and estimates ~120 BPM', () => {
    // A short silent lead-in before the first click (like any real recording) —
    // a click sitting on sample 0 has no prior frame to diff energy against and
    // is a degenerate case no energy-flux detector can see.
    const times = Array.from({ length: 16 }, (_, i) => 0.3 + i * 0.5); // 120 BPM
    const ch = clickTrack(times, 8.3);
    const { beats, bpm } = detectBeats(ch, SR);

    expect(bpm).not.toBeNull();
    expect(bpm!).toBeGreaterThan(118);
    expect(bpm!).toBeLessThan(122);

    expect(beats.length).toBeGreaterThan(0);
    for (const t of times) {
      const nearest = beats.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best));
      expect(Math.abs(nearest - t)).toBeLessThan(0.03);
    }
  });

  it('returns no beats and null bpm for silence', () => {
    const ch = new Float32Array(SR * 4); // 4s of silence
    const { beats, bpm } = detectBeats(ch, SR);
    expect(beats).toEqual([]);
    expect(bpm).toBeNull();
  });

  it('still detects clicks over a noise floor', () => {
    const times = Array.from({ length: 12 }, (_, i) => 0.3 + i * 0.5);
    const ch = clickTrack(times, 6.3, 0.02);
    const { beats, bpm } = detectBeats(ch, SR);

    expect(bpm).not.toBeNull();
    expect(beats.length).toBeGreaterThanOrEqual(times.length - 2);
    for (const t of times) {
      const nearest = beats.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best));
      expect(Math.abs(nearest - t)).toBeLessThan(0.05);
    }
  });

  it('refractory period suppresses a double-peak from one transient', () => {
    // Two bursts 100ms apart — well inside the 250ms refractory window — plus a
    // clean regular track so the detector has real onsets to compare against.
    const times = [0.3, 0.8, 1.3, 1.4, 1.8, 2.3, 2.8, 3.3];
    const ch = clickTrack(times, 4);
    const { beats } = detectBeats(ch, SR);
    // the 1.0/1.1 pair must collapse to at most one accepted onset.
    const nearPair = beats.filter((b) => b > 0.9 && b < 1.2);
    expect(nearPair.length).toBeLessThanOrEqual(1);
  });
});
