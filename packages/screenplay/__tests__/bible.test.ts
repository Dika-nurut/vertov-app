import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractBible } from '../src/bible.js';

const ruSample = readFileSync(
  new URL('../fixtures/fountain/ru-sample.fountain', import.meta.url),
  'utf-8',
);

describe('extractBible', () => {
  it('collects the character roster, merging (ЗК)-style extensions and dual carets', () => {
    const { characters } = extractBible(ruSample);
    const names = characters.map((c) => c.name);
    expect(names).toContain('МИХАЛЫЧ');
    expect(names).toContain('ЛИДА'); // «ЛИДА (ЗК)» and «ЛИДА ^» merged
    expect(names).toContain('СТОРОЖ');
    expect(names.filter((n) => n.startsWith('ЛИДА'))).toEqual(['ЛИДА']);
  });

  it('pulls the introduction sentence as the description', () => {
    const { characters } = extractBible(ruSample);
    const mihalych = characters.find((c) => c.name === 'МИХАЛЫЧ')!;
    expect(mihalych.description).toContain('киномеханик в потёртом свитере');
  });

  it('orders by how much the character speaks', () => {
    const { characters } = extractBible(ruSample);
    expect(characters[0]!.name).toBe('МИХАЛЫЧ');
    expect(characters[0]!.lines).toBeGreaterThanOrEqual(characters[1]!.lines);
  });

  it('returns an empty roster for a script with no dialogue', () => {
    expect(extractBible('Просто описание.\n').characters).toEqual([]);
  });
});
