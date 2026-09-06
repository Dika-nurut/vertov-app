import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sceneList, spanContext } from '../src/context.js';

const ruSample = readFileSync(
  new URL('../fixtures/fountain/ru-sample.fountain', import.meta.url),
  'utf-8',
);

describe('sceneList', () => {
  it('lists scenes with correct offsets (slice(from,to) starts at the heading)', () => {
    const scenes = sceneList(ruSample);
    expect(scenes.map((s) => s.heading)).toEqual([
      'ИНТ. КИНОБУДКА - НОЧЬ',
      'НАТ. КРЫША КИНОТЕАТРА - НОЧЬ',
      'ИНТ./НАТ. ПРОХОДНАЯ КИНОТЕАТРА - УТРО',
      'ПАВ. ДЕКОРАЦИЯ «КВАРТИРА» - ДЕНЬ',
    ]);
    for (const s of scenes) {
      expect(ruSample.slice(s.from, s.to).trimStart().startsWith(s.heading.slice(0, 8))).toBe(true);
    }
  });

  it('returns an empty list for a script with no headings', () => {
    expect(sceneList('Просто текст.\nБез сцен.\n')).toEqual([]);
  });
});

describe('spanContext', () => {
  it('returns the span, its enclosing scene and a scene index — not the whole script', () => {
    const needle = 'Сеанс окончен, Лида. Иди домой.';
    const from = ruSample.indexOf(needle);
    const ctx = spanContext(ruSample, from, from + needle.length);
    expect(ctx.span).toBe(needle);
    expect(ctx.sceneHeadings).toEqual(['ИНТ. КИНОБУДКА - НОЧЬ']);
    expect(ctx.scene).toContain('МИХАЛЫЧ');
    expect(ctx.scene).not.toContain('КРЫША КИНОТЕАТРА'); // next scene excluded
    expect(ctx.sceneIndex).toContain('2. НАТ. КРЫША КИНОТЕАТРА - НОЧЬ');
  });

  it('covers spans that straddle two scenes', () => {
    const a = ruSample.indexOf('Этого не может быть.');
    const b = ruSample.indexOf('у самого края');
    const ctx = spanContext(ruSample, a, b);
    expect(ctx.sceneHeadings).toEqual(['ИНТ. КИНОБУДКА - НОЧЬ', 'НАТ. КРЫША КИНОТЕАТРА - НОЧЬ']);
  });

  it('degrades to a bounded window when there are no scene headings', () => {
    const text = 'Строка.\n'.repeat(2_000);
    const ctx = spanContext(text, 8_000, 8_100);
    expect(ctx.span.length).toBe(100);
    expect(ctx.scene.length).toBeLessThanOrEqual(100 + 3_001);
    expect(ctx.sceneIndex).toBe('');
  });

  it('clamps a giant scene to the budget, keeping the span inside the window', () => {
    const giant = 'ИНТ. ЗАЛ - ДЕНЬ\n\n' + 'Очень длинное действие. '.repeat(2_000) + '\nКОНЕЦ\n';
    const from = giant.indexOf('КОНЕЦ');
    const ctx = spanContext(giant, from, from + 5);
    expect(ctx.scene.length).toBeLessThanOrEqual(12_000);
    expect(ctx.scene).toContain('КОНЕЦ');
  });

  it('tolerates out-of-bounds offsets without throwing', () => {
    const ctx = spanContext('короткий текст', 5_000, 6_000);
    expect(ctx.span).toBe('');
  });

  it('clamps the scene index so a huge multi-scene script cannot blow the token budget', () => {
    // A script with thousands of scenes: the index lists every heading and
    // rides on every call, so it must be bounded (~5k chars ≈ 170 scenes) with
    // a «… ещё N сцен» tail — otherwise a 2 MB script loses money per call.
    const many = Array.from(
      { length: 2_000 },
      (_, i) => `ИНТ. ЛОКАЦИЯ ${i} - ДЕНЬ\n\nДействие.\n`,
    ).join('\n');
    const ctx = spanContext(many, 0, 5);
    expect(ctx.sceneIndex.length).toBeLessThanOrEqual(5_100);
    expect(ctx.sceneIndex).toMatch(/… ещё \d+ сцен/);
  });

  it('clamps the selected fragment so a whole-script selection cannot ride the span price', () => {
    // Selecting (almost) the entire script and asking on the cheap span tier
    // must NOT send the whole script as the "fragment": the span is capped at
    // 4k chars (a fragment this big is a whole-script question — chat scope).
    const huge = 'ИНТ. ЗАЛ - ДЕНЬ\n\n' + 'Реплика за репликой. '.repeat(3_000);
    const ctx = spanContext(huge, 0, huge.length);
    expect(ctx.span.length).toBe(4_000);
    expect(ctx.span).toBe(huge.slice(0, 4_000));
  });
});
