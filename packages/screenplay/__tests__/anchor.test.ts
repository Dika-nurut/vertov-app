import { describe, expect, it } from 'vitest';
import { relocateAnchor, type AnchorSpan } from '../src/anchor.js';

const BASE = [
  'ИНТ. КИНОБУДКА - НОЧЬ',
  '',
  'Тесная будка киномеханика.',
  '',
  'МИХАЛЫЧ',
  'Сеанс окончен, Лида. Иди домой.',
  '',
  'ЛИДА (ЗК)',
  'А если я скажу, что плёнка не кончилась?',
  '',
].join('\n');

const quoteOf = (text: string, quote: string): AnchorSpan => ({
  from: text.indexOf(quote),
  to: text.indexOf(quote) + quote.length,
  rev: 3,
  quote,
});

describe('relocateAnchor', () => {
  it('same rev + valid bounds → offsets are authoritative', () => {
    const a = quoteOf(BASE, 'Сеанс окончен, Лида. Иди домой.');
    expect(relocateAnchor(a, BASE, 3)).toEqual({ status: 'exact', from: a.from, to: a.to });
  });

  it('rev drift with unchanged quote → re-found by exact match', () => {
    const a = quoteOf(BASE, 'Сеанс окончен, Лида. Иди домой.');
    const edited = 'НОВАЯ ПЕРВАЯ СЦЕНА.\n\n' + BASE; // everything shifted right
    const r = relocateAnchor(a, edited, 4);
    expect(r.status).toBe('moved');
    if (r.status === 'moved') {
      expect(edited.slice(r.from, r.to)).toBe(a.quote);
    }
  });

  it('picks the occurrence nearest the original offset when the quote repeats', () => {
    const quote = 'Пауза.';
    const text = `Пауза.\n\nМного текста между ними.\n\nПауза.\n`;
    const nearSecond: AnchorSpan = { from: 30, to: 36, rev: 1, quote };
    const r = relocateAnchor(nearSecond, text, 2);
    expect(r.status).toBe('moved');
    if (r.status === 'moved') expect(r.from).toBe(text.lastIndexOf(quote));
  });

  it('survives whitespace reflow (line re-wrapped)', () => {
    const a = quoteOf(BASE, 'А если я скажу, что плёнка не кончилась?');
    const reflowed = BASE.replace(
      'А если я скажу, что плёнка не кончилась?',
      'А если я скажу,\nчто плёнка   не кончилась?',
    );
    const r = relocateAnchor(a, reflowed, 4);
    expect(r.status).toBe('moved');
    if (r.status === 'moved') {
      expect(reflowed.slice(r.from, r.to)).toContain('плёнка   не кончилась');
    }
  });

  it('degrades to detached when the quoted text is gone — never throws, never lies', () => {
    const a = quoteOf(BASE, 'Сеанс окончен, Лида. Иди домой.');
    const rewritten = BASE.replace('Сеанс окончен, Лида. Иди домой.', 'Всё. Домой.');
    expect(relocateAnchor(a, rewritten, 4)).toEqual({ status: 'detached' });
  });

  it('same rev but corrupt out-of-bounds offsets → falls back to quote search', () => {
    const a: AnchorSpan = { from: 9_999, to: 10_050, rev: 3, quote: 'МИХАЛЫЧ' };
    const r = relocateAnchor(a, BASE, 3);
    expect(r.status).toBe('moved');
    if (r.status === 'moved') expect(BASE.slice(r.from, r.to)).toBe('МИХАЛЫЧ');
  });

  it('empty quote → detached', () => {
    const a: AnchorSpan = { from: 0, to: 0, rev: 1, quote: '' };
    expect(relocateAnchor(a, BASE, 2)).toEqual({ status: 'detached' });
  });

  it('regex-hostile quotes are treated literally', () => {
    const text = 'Он пишет: ИНТ. (ЭТО НЕ СКОБКИ?) [проверка].\nКонец.';
    const a: AnchorSpan = { from: 0, to: 1, rev: 1, quote: '(ЭТО НЕ СКОБКИ?) [проверка]' };
    const r = relocateAnchor(a, text, 2);
    expect(r.status).toBe('moved');
  });
});
