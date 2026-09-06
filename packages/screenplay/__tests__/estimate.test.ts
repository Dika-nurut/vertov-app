import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatTiming, sceneTimings, scriptStats } from '../src/estimate.js';

const ruSample = readFileSync(
  new URL('../fixtures/fountain/ru-sample.fountain', import.meta.url),
  'utf-8',
);

describe('formatTiming', () => {
  it('renders page fractions as M:SS at one page ≈ one minute', () => {
    expect(formatTiming(0)).toBe('0:00');
    expect(formatTiming(1)).toBe('1:00');
    expect(formatTiming(0.5)).toBe('0:30');
    expect(formatTiming(1.1667)).toBe('1:10');
  });
});

describe('scriptStats', () => {
  it('is all-zero for an empty script', () => {
    expect(scriptStats('')).toEqual({ pages: 0, scenes: 0, firstScene: null, lastScene: null });
  });

  it('counts scenes and names the first + last heading', () => {
    const s = scriptStats(ruSample);
    expect(s.scenes).toBe(4);
    expect(s.firstScene).toBe('ИНТ. КИНОБУДКА - НОЧЬ');
    expect(s.lastScene).toBe('ПАВ. ДЕКОРАЦИЯ «КВАРТИРА» - ДЕНЬ');
    expect(s.pages).toBeGreaterThanOrEqual(1);
  });

  it('a script with text but no headings still estimates ≥1 page and 0 scenes', () => {
    const s = scriptStats('Просто длинное действие без единой сцены.\n');
    expect(s.scenes).toBe(0);
    expect(s.firstScene).toBeNull();
    expect(s.lastScene).toBeNull();
    expect(s.pages).toBe(1);
  });
});

describe('sceneTimings', () => {
  it('produces one timing per scene, in order, each with a duration', () => {
    const t = sceneTimings(ruSample);
    expect(t.map((x) => x.index)).toEqual([1, 2, 3, 4]);
    expect(t[0]!.heading).toBe('ИНТ. КИНОБУДКА - НОЧЬ');
    for (const scene of t) {
      expect(scene.pages).toBeGreaterThan(0);
      expect(scene.duration).toMatch(/^\d+:\d{2}$/);
    }
  });

  it('gives a longer scene a longer running time', () => {
    const short = sceneTimings('ИНТ. А - ДЕНЬ\n\nКоротко.\n')[0]!;
    const long = sceneTimings(
      'ИНТ. Б - ДЕНЬ\n\n' +
        Array.from({ length: 40 }, () => 'Длинная строка действия.').join('\n') +
        '\n',
    )[0]!;
    expect(long.pages).toBeGreaterThan(short.pages);
  });
});
