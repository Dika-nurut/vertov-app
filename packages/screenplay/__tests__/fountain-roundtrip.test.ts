import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFountain, serializeFountain } from '../src/index.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/fountain/${name}`, import.meta.url), 'utf-8');

const CORPUS = [
  'big-fish.fountain', // official fountain.io sample (John August)
  'brick-and-steel.fountain', // official fountain.io sample (Stu Maschwitz)
  'ru-sample.fountain', // RU: ИНТ./НАТ./ПАВ. headings, Cyrillic names
  'edge-cases.fountain', // forced elements, dual dialogue, notes, boneyard
];

describe('fountain → model → fountain is byte-faithful', () => {
  for (const name of CORPUS) {
    it(`round-trips ${name} exactly`, () => {
      const source = fixture(name);
      const doc = parseFountain(source);
      expect(serializeFountain(doc)).toBe(source);
    });

    it(`never drops or duplicates a line of ${name}`, () => {
      const source = fixture(name);
      const doc = parseFountain(source);
      const emitted =
        doc.titlePage.reduce((n, e) => n + e.raw.length, 0) +
        doc.elements.reduce((n, e) => n + e.raw.length, 0);
      expect(emitted).toBe(source.split('\n').length);
    });
  }

  it('round-trips CRLF input exactly', () => {
    const source = fixture('edge-cases.fountain').replace(/\n/g, '\r\n');
    expect(serializeFountain(parseFountain(source))).toBe(source);
  });

  it('round-trips input without a trailing newline', () => {
    const source = 'INT. ДОМ - ДЕНЬ\n\nПоследняя строка без перевода.';
    expect(serializeFountain(parseFountain(source))).toBe(source);
  });

  it('round-trips the empty document', () => {
    expect(serializeFountain(parseFountain(''))).toBe('');
  });
});
