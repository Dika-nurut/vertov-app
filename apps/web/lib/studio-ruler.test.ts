import { describe, expect, it } from 'vitest';
import { fmtRulerLabel, rulerTicks } from '../app/studio/_timeline/ruler';

describe('fmtRulerLabel', () => {
  it('formats seconds below a minute', () => {
    expect(fmtRulerLabel(5, false, false)).toBe('5s');
    expect(fmtRulerLabel(2.5, false, true)).toBe('2.5s');
  });
  it('formats clock time at/above a minute', () => {
    expect(fmtRulerLabel(0, true, false)).toBe('0:00');
    expect(fmtRulerLabel(65, true, false)).toBe('1:05');
    expect(fmtRulerLabel(125, true, false)).toBe('2:05');
  });
  it('carries a rounding artefact of 60s', () => {
    expect(fmtRulerLabel(119.8, true, false)).toBe('2:00');
  });
});

describe('rulerTicks', () => {
  it('picks a wider interval when zoomed out so labels stay readable', () => {
    // pps=8 → 1s=8px (too tight); smallest nice interval ≥66px is 10s (80px).
    const ticks = rulerTicks(60, 8);
    const majors = ticks.filter((t) => t.major).map((t) => t.sec);
    expect(majors).toContain(0);
    expect(majors).toContain(10);
    expect(majors).toContain(30);
    // no 5s major at this zoom (it would collide)
    expect(majors).not.toContain(5);
  });

  it('picks a fine interval when zoomed in', () => {
    // pps=120 → 1s=120px ≥66 → major interval 1s, minor 0.2s.
    const ticks = rulerTicks(10, 120);
    const majors = ticks.filter((t) => t.major).map((t) => t.sec);
    expect(majors).toContain(1);
    expect(majors).toContain(2);
    // minor ticks exist between majors
    expect(ticks.some((t) => !t.major && t.sec > 0 && t.sec < 1)).toBe(true);
  });

  it('labels majors as clock time once the span passes a minute', () => {
    const ticks = rulerTicks(90, 20);
    const labelled = ticks.filter((t) => t.major && t.label);
    expect(labelled.every((t) => /^\d+:\d{2}$/.test(t.label!))).toBe(true);
  });

  it('always covers at least 10 seconds for a tiny project', () => {
    const ticks = rulerTicks(2, 40);
    expect(Math.max(...ticks.map((t) => t.sec))).toBeGreaterThanOrEqual(10);
  });

  it('every major tick carries a label; minors do not', () => {
    const ticks = rulerTicks(30, 30);
    expect(ticks.filter((t) => t.major).every((t) => !!t.label)).toBe(true);
    expect(ticks.filter((t) => !t.major).every((t) => t.label === undefined)).toBe(true);
  });

  it('tolerates a zero/negative pps without dividing by zero', () => {
    expect(() => rulerTicks(10, 0)).not.toThrow();
    expect(rulerTicks(10, 0).length).toBeGreaterThan(0);
  });
});
