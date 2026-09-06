import { strToU8, zipSync } from 'fflate';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { importHighland } from '../src/index.js';

const ruSample = readFileSync(
  new URL('../fixtures/fountain/ru-sample.fountain', import.meta.url),
  'utf-8',
);

describe('importHighland', () => {
  it('extracts the fountain text from a Highland bundle, losslessly', () => {
    const bundle = zipSync({
      'ru-sample.highland/text.fountain': strToU8(ruSample),
      'ru-sample.highland/assets/.keep': strToU8(''),
    });
    const { fountain, report } = importHighland(bundle);
    expect(fountain).toBe(ruSample);
    expect(report.lossless).toBe(true);
  });

  it('prefers .fountain over other text entries and ignores __MACOSX', () => {
    const bundle = zipSync({
      '__MACOSX/text.fountain': strToU8('junk'),
      'notes.md': strToU8('# notes'),
      'text.fountain': strToU8(ruSample),
    });
    expect(importHighland(bundle).fountain).toBe(ruSample);
  });

  it('rejects a zip without any script text', () => {
    const bundle = zipSync({ 'image.png': strToU8('binary') });
    expect(() => importHighland(bundle)).toThrow(/нет текста/);
  });

  it('rejects a non-zip file', () => {
    expect(() => importHighland(strToU8('plain text'))).toThrow(/zip/);
  });
});
