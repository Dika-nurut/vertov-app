import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exportFdx, importFdx, parseFountain, type FountainElement } from '../src/index.js';

const sampleXml = readFileSync(new URL('../fixtures/fdx/sample.fdx', import.meta.url), 'utf-8');

const byType = (els: FountainElement[], type: string) => els.filter((e) => e.type === type);

describe('importFdx — element mapping', () => {
  const { fountain, report } = importFdx(sampleXml);
  const doc = parseFountain(fountain);

  it('maps scene headings with FD scene numbers (EN and RU)', () => {
    const headings = byType(doc.elements, 'scene_heading');
    expect(headings.map((h) => [h.text, h.sceneNumber])).toEqual([
      ['INT. COFFEE SHOP - DAY', '1'],
      ['НАТ. НАБЕРЕЖНАЯ - ВЕЧЕР', '2'],
    ]);
  });

  it('joins styled text runs into fountain emphasis', () => {
    const action = byType(doc.elements, 'action')[0]!;
    expect(action.text).toBe('A quiet morning. *Rain* streaks the window.');
  });

  it('maps character/parenthetical/dialogue, forcing mixed-case names', () => {
    const chars = byType(doc.elements, 'character');
    expect(chars.map((c) => c.text)).toEqual(['ВЕРА', 'McCLANE']);
    expect(chars[1]!.forced).toBe(true);
    expect(byType(doc.elements, 'parenthetical')[0]!.text).toBe('(тихо)');
    expect(byType(doc.elements, 'dialogue').map((d) => d.text)).toEqual([
      'Ты опоздал. Опять.',
      'Traffic. You know how it is.',
    ]);
  });

  it('keeps spec transitions bare and forces non-spec ones', () => {
    const transitions = byType(doc.elements, 'transition');
    expect(transitions.map((t) => [t.text, t.forced ?? false])).toEqual([
      ['CUT TO:', false],
      ['SMASH CUT', true],
    ]);
  });

  it('forces multi-line action starting with a caps line (not a character)', () => {
    const sirens = doc.elements.find((e) => e.text.startsWith('SIRENS'))!;
    expect(sirens.type).toBe('action');
    expect(sirens.forced).toBe(true);
    expect(sirens.text).toBe('SIRENS WAIL\nSomewhere a door slams.');
  });

  it('degrades Shot and General to action and reports every loss', () => {
    const shot = doc.elements.find((e) => e.text === 'CLOSE ON THE LOCKET')!;
    expect(shot.type).toBe('action');
    expect(report.lossless).toBe(false);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('formatting-lost'); // Shot
    expect(codes).toContain('metadata-lost'); // stray title-page line
  });

  it('builds a fountain title page from the FD title page', () => {
    expect(doc.titlePage.map((e) => `${e.key}: ${e.values.join(' ')}`)).toEqual([
      'Title: THE LOCKET',
      'Author: A. Writer',
      'Draft date: 2026-07-02',
    ]);
  });
});

describe('fdx → fountain → fdx preserves all mapped elements', () => {
  it('reaches a fixpoint: re-importing the export yields identical fountain', () => {
    const first = importFdx(sampleXml).fountain;
    const exported = exportFdx(parseFountain(first));
    const second = importFdx(exported).fountain;
    expect(second).toBe(first);
  });

  it('round-trips a fountain-authored script through fdx (RU)', () => {
    const fountain = [
      'ИНТ. КУХНЯ - НОЧЬ #7#',
      '',
      'Чайник свистит.',
      '',
      'МАТЬ',
      '(строго)',
      'Выключи. Сейчас же.',
      '',
      '> ЗАТЕМНЕНИЕ.',
      '',
    ].join('\n');
    const exported = exportFdx(parseFountain(fountain));
    const back = importFdx(exported);
    expect(back.report.lossless).toBe(true);
    const doc = parseFountain(back.fountain);
    const heading = doc.elements.find((e) => e.type === 'scene_heading')!;
    expect(heading.text).toBe('ИНТ. КУХНЯ - НОЧЬ');
    expect(heading.sceneNumber).toBe('7');
    expect(doc.elements.find((e) => e.type === 'parenthetical')!.text).toBe('(строго)');
    expect(doc.elements.find((e) => e.type === 'transition')!.text).toBe('ЗАТЕМНЕНИЕ.');
  });

  it('escapes XML-hostile characters', () => {
    const fountain = 'INT. R&D LAB - DAY\n\nA sign reads "x < y > z".\n';
    const exported = exportFdx(parseFountain(fountain));
    const back = importFdx(exported).fountain;
    expect(back).toContain('R&D');
    expect(back).toContain('"x < y > z"');
  });
});

describe('importFdx — failure modes', () => {
  it('rejects non-XML with a clear RU message', () => {
    expect(() => importFdx('*** not xml ***')).toThrow(/FDX/);
  });

  it('rejects XML without a FinalDraft root', () => {
    expect(() => importFdx('<Other/>')).toThrow(/FinalDraft/);
  });
});
