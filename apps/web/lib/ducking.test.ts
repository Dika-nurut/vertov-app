import { describe, expect, it } from 'vitest';
import {
  DUCK_ATTACK_SEC,
  DUCK_RELEASE_SEC,
  buildDuckEnvelope,
  detectSpeechSegments,
  duckGainDbAt,
  type DuckSegment,
} from './ducking';

/** Build a mono channel: `spans` are [fromSec, toSec] loud (speech) regions
 * filled with a tone; everything else is silence. */
function speechChannel(
  totalSec: number,
  spans: [number, number][],
  sampleRate = 8000,
  amp = 0.5,
): Float32Array {
  const ch = new Float32Array(Math.round(totalSec * sampleRate));
  for (const [from, to] of spans) {
    const a = Math.round(from * sampleRate);
    const b = Math.round(to * sampleRate);
    for (let i = a; i < b && i < ch.length; i++) {
      ch[i] = amp * Math.sin((2 * Math.PI * 220 * i) / sampleRate);
    }
  }
  return ch;
}

describe('detectSpeechSegments', () => {
  it('finds a single loud region and ignores the surrounding silence', () => {
    const ch = speechChannel(4, [[1, 2.5]]);
    const segs = detectSpeechSegments(ch, 8000);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.fromSec).toBeCloseTo(1, 1);
    expect(segs[0]!.toSec).toBeCloseTo(2.5, 1);
  });

  it('separates two regions split by a long gap', () => {
    const ch = speechChannel(6, [
      [0.5, 1.5],
      [4, 5],
    ]);
    const segs = detectSpeechSegments(ch, 8000);
    expect(segs).toHaveLength(2);
    expect(segs[1]!.fromSec).toBeCloseTo(4, 1);
  });

  it('bridges regions separated by less than the merge gap', () => {
    // 0.15s gap < the 0.3s default → one merged run.
    const ch = speechChannel(3, [
      [0.5, 1.2],
      [1.35, 2.2],
    ]);
    const segs = detectSpeechSegments(ch, 8000);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.fromSec).toBeCloseTo(0.5, 1);
    expect(segs[0]!.toSec).toBeCloseTo(2.2, 1);
  });

  it('drops a blip shorter than the minimum segment length', () => {
    const ch = speechChannel(3, [[1.0, 1.1]]); // 0.1s < 0.25s min
    expect(detectSpeechSegments(ch, 8000)).toEqual([]);
  });

  it('pure silence yields no segments', () => {
    expect(detectSpeechSegments(new Float32Array(8000), 8000)).toEqual([]);
    expect(detectSpeechSegments(new Float32Array(0), 8000)).toEqual([]);
  });
});

describe('buildDuckEnvelope', () => {
  it('passes a well-spaced window through, sorted and non-overlapping', () => {
    const env = buildDuckEnvelope([
      { fromSec: 5, toSec: 6 },
      { fromSec: 1, toSec: 2 },
    ]);
    expect(env).toEqual([
      { fromSec: 1, toSec: 2 },
      { fromSec: 5, toSec: 6 },
    ]);
  });

  it('merges overlapping windows', () => {
    const env = buildDuckEnvelope([
      { fromSec: 1, toSec: 3 },
      { fromSec: 2, toSec: 4 },
    ]);
    expect(env).toEqual([{ fromSec: 1, toSec: 4 }]);
  });

  it('bridges windows closer than attack+release so music does not pop up', () => {
    // gap 0.5s < attack(0.25)+release(0.4)=0.65 → merged.
    const env = buildDuckEnvelope([
      { fromSec: 1, toSec: 2 },
      { fromSec: 2.5, toSec: 3 },
    ]);
    expect(env).toEqual([{ fromSec: 1, toSec: 3 }]);
  });

  it('keeps windows apart when the gap exceeds attack+release', () => {
    const env = buildDuckEnvelope([
      { fromSec: 1, toSec: 2 },
      { fromSec: 3, toSec: 4 }, // gap 1s > 0.65
    ]);
    expect(env).toHaveLength(2);
  });

  it('drops degenerate (zero/negative-length) windows', () => {
    expect(buildDuckEnvelope([{ fromSec: 2, toSec: 2 }])).toEqual([]);
    expect(buildDuckEnvelope([])).toEqual([]);
  });
});

describe('duckGainDbAt — the parity contract', () => {
  const opts = { duckDb: -12, attackSec: DUCK_ATTACK_SEC, releaseSec: DUCK_RELEASE_SEC };
  const seg: DuckSegment[] = [{ fromSec: 2, toSec: 4 }];

  it('is 0 outside the ramps and full duck across the hold', () => {
    expect(duckGainDbAt(0, seg, opts)).toBe(0);
    expect(duckGainDbAt(2, seg, opts)).toBe(-12); // ramp STARTS at from-attack, hits duckDb at from
    expect(duckGainDbAt(3, seg, opts)).toBe(-12);
    expect(duckGainDbAt(4, seg, opts)).toBe(-12); // release STARTS at to
    expect(duckGainDbAt(5, seg, opts)).toBe(0);
  });

  it('ramps linearly in dB over the attack window (from-attack → from)', () => {
    // attack spans [1.75, 2]; halfway (1.875) → half the duck.
    expect(duckGainDbAt(1.75, seg, opts)).toBeCloseTo(0, 6);
    expect(duckGainDbAt(1.875, seg, opts)).toBeCloseTo(-6, 6);
    expect(duckGainDbAt(2, seg, opts)).toBeCloseTo(-12, 6);
  });

  it('ramps linearly in dB over the release window (to → to+release)', () => {
    // release spans [4, 4.4]; halfway (4.2) → half the duck.
    expect(duckGainDbAt(4, seg, opts)).toBeCloseTo(-12, 6);
    expect(duckGainDbAt(4.2, seg, opts)).toBeCloseTo(-6, 6);
    expect(duckGainDbAt(4.4, seg, opts)).toBeCloseTo(0, 6);
  });

  it('takes the most-ducked contribution where two ramps overlap', () => {
    const two: DuckSegment[] = [
      { fromSec: 1, toSec: 2 },
      { fromSec: 2.3, toSec: 3 },
    ];
    // At 2.15 the first is releasing (still ducked) and the second is attacking;
    // min() keeps whichever is more negative — never a gap up toward 0.
    const g = duckGainDbAt(2.15, two, opts);
    expect(g).toBeLessThan(0);
  });

  it('empty segments → no ducking anywhere', () => {
    expect(duckGainDbAt(1, [], opts)).toBe(0);
  });
});
