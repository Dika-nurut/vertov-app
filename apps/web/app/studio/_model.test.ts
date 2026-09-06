import { describe, it, expect } from 'vitest';
import {
  colorCss,
  CURVE_CSS,
  CURVE_LABELS,
  DEFAULT_COLOR,
  HEART_PATH,
  mediaFadeGain,
} from './_model';
import type { CurvePreset } from './_model';

describe('HEART_PATH — preview traces the worker geq heart (preview==export)', () => {
  // The worker's implicit heart (studio-graph.ts), evaluated in the 0-100 viewBox.
  const workerInside = (X: number, Y: number): boolean => {
    const hx = (X - 50) / 35;
    const hy = -(Y - 45) / 40;
    const r2 = hx * hx + hy * hy - 1;
    return r2 * r2 * r2 - hx * hx * hy * hy * hy <= 0;
  };
  // Parse the path's vertices and run even-odd point-in-polygon (same test SVG uses).
  const verts = HEART_PATH.replace(/[MLZ]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => pair.split(',').map(Number) as [number, number]);
  const polyInside = (X: number, Y: number): boolean => {
    let inside = false;
    for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
      const [xi, yi] = verts[i]!;
      const [xj, yj] = verts[j]!;
      if (yi > Y !== yj > Y && X < ((xj - xi) * (Y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  it('agrees with the worker at the top-center cleft (the old bezier disagreed here)', () => {
    // (50,10) is inside the worker heart (its cleft only starts ~Y=5); the old
    // hand path put the cleft at Y=16 and read this as OUTSIDE.
    expect(workerInside(50, 10)).toBe(true);
    expect(polyInside(50, 10)).toBe(true);
    // Above the shared cleft is outside on both.
    expect(workerInside(50, 3)).toBe(false);
    expect(polyInside(50, 3)).toBe(false);
  });

  it('agrees with the worker across a grid of sample points', () => {
    let mismatches = 0;
    for (let X = 6; X <= 94; X += 4) {
      for (let Y = 2; Y <= 92; Y += 4) {
        if (workerInside(X, Y) !== polyInside(X, Y)) mismatches++;
      }
    }
    // Allow a thin boundary band (polyline vs smooth curve quantization).
    expect(mismatches).toBeLessThanOrEqual(4);
  });
});

describe('mediaFadeGain — preview mirror of the worker afade envelope', () => {
  // Reference = the worker's afade semantics (studio-graph.ts addTrack):
  //   fade-in  : linear 0→1 over [fromSec, fromSec+1]
  //   fade-out : linear 1→0 over [totalDur-1, totalDur]
  // Before this helper the preview played the track at full volume through both
  // ramps (el.volume = dbToLin(gain) only), diverging from the export.
  const total = 10;
  it('no fade flags → unity across the whole timeline (legacy behavior preserved)', () => {
    for (const t of [0, 2, 5, 9.5, 10]) expect(mediaFadeGain(t, 2, total, false, false)).toBe(1);
  });
  it('fade-in ramps 0→1 over the first second after fromSec', () => {
    expect(mediaFadeGain(2.0, 2, total, true, false)).toBeCloseTo(0, 6); // at start
    expect(mediaFadeGain(2.5, 2, total, true, false)).toBeCloseTo(0.5, 6); // mid-ramp
    expect(mediaFadeGain(3.0, 2, total, true, false)).toBeCloseTo(1, 6); // ramp done
    expect(mediaFadeGain(1.5, 2, total, true, false)).toBe(0); // before it starts
  });
  it('fade-out ramps 1→0 over the last second of the timeline', () => {
    expect(mediaFadeGain(9.0, 0, total, false, true)).toBeCloseTo(1, 6);
    expect(mediaFadeGain(9.5, 0, total, false, true)).toBeCloseTo(0.5, 6);
    expect(mediaFadeGain(10.0, 0, total, false, true)).toBeCloseTo(0, 6);
  });
  it('MULTIPLIES overlapping ramps (two serial afades), not min()', () => {
    // On a 1.5s timeline with both fades, the in-ramp [0,1] and out-ramp [0.5,1.5]
    // overlap. ffmpeg runs two afade filters in series → gains multiply. At t=0.75
    // that is 0.75·0.75 = 0.5625, NOT min(0.75,0.75)=0.75.
    expect(mediaFadeGain(0.75, 0, 1.5, true, true)).toBeCloseTo(0.5625, 6);
    // Non-overlapping (long timeline): only one ramp active → product == that ramp.
    expect(mediaFadeGain(0.5, 0, 10, true, true)).toBeCloseTo(0.5, 6);
    expect(mediaFadeGain(9.5, 0, 10, true, true)).toBeCloseTo(0.5, 6);
  });
});

const NEW_LOOKS: CurvePreset[] = [
  'warm-film',
  'cool-film',
  'noir',
  'teal-orange',
  'bleach-bypass',
  'faded-polaroid',
];

describe('CURVE_CSS — curated "Looks"', () => {
  it('each new preset has a Russian label and a non-empty, well-formed CSS filter string', () => {
    for (const preset of NEW_LOOKS) {
      expect(CURVE_LABELS[preset]).toBeTruthy();
      const css = CURVE_CSS[preset];
      expect(css.length).toBeGreaterThan(0);
      // well-formed: space-separated `fn(args)` tokens only
      expect(css).toMatch(/^([\w-]+\([^)]*\)\s*)+$/);
    }
  });

  it('colorCss() applies the preset filter when a clip has curve set', () => {
    for (const preset of NEW_LOOKS) {
      expect(colorCss({ ...DEFAULT_COLOR, curve: preset })).toBe(CURVE_CSS[preset]);
    }
  });
});
