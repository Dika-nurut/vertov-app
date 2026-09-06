import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exportPdf, importPdf, parseFountain, type FountainElement } from '../src/index.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/fountain/${name}`, import.meta.url), 'utf-8');

const byType = (els: FountainElement[], type: string) => els.filter((e) => e.type === type);

describe('exportPdf — typeset Courier layout', () => {
  it('produces a valid PDF with embedded Cyrillic text', async () => {
    const doc = parseFountain(fixture('ru-sample.fountain'));
    const bytes = await exportPdf(doc);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(5_000);
  });

  it('supports LETTER as well as A4', async () => {
    const doc = parseFountain(fixture('brick-and-steel.fountain'));
    const [a4, letter] = await Promise.all([
      exportPdf(doc, { pageSize: 'A4' }),
      exportPdf(doc, { pageSize: 'LETTER' }),
    ]);
    expect(a4.length).toBeGreaterThan(1_000);
    expect(letter.length).toBeGreaterThan(1_000);
  });
});

describe('pdf → fountain (import recovers the structure our export typeset)', () => {
  it('recovers RU scene headings, characters, dialogue and transitions', async () => {
    const original = parseFountain(fixture('ru-sample.fountain'));
    const bytes = await exportPdf(original);
    const { fountain, report } = await importPdf(bytes);
    const doc = parseFountain(fountain);

    expect(report.lossless).toBe(false); // heuristic path is honest about itself
    expect(report.issues.map((i) => i.code)).toContain('structure-guessed');

    const headings = byType(doc.elements, 'scene_heading').map((h) => h.text);
    // The export prints "HEADING  N"; extraction normalizes runs of spaces.
    expect(headings).toContain('ИНТ. КИНОБУДКА - НОЧЬ 1');
    expect(headings.some((h) => h.startsWith('НАТ. КРЫША'))).toBe(true);

    const characters = byType(doc.elements, 'character').map((c) => c.text);
    expect(characters).toContain('МИХАЛЫЧ');
    expect(characters).toContain('ЛИДА (ЗК)');

    const dialogue = byType(doc.elements, 'dialogue').map((d) => d.text);
    expect(dialogue).toContain('Сеанс окончен, Лида. Иди домой.');
    expect(byType(doc.elements, 'parenthetical').map((p) => p.text)).toContain('(не оборачиваясь)');
  });

  it('recovers an EN sample across page boundaries', async () => {
    const original = parseFountain(fixture('brick-and-steel.fountain'));
    const bytes = await exportPdf(original);
    const { fountain } = await importPdf(bytes);
    const doc = parseFountain(fountain);

    const characters = new Set(byType(doc.elements, 'character').map((c) => c.text));
    expect(characters.has('BRICK')).toBe(true);
    expect(characters.has('STEEL')).toBe(true);
    expect(byType(doc.elements, 'scene_heading').length).toBeGreaterThanOrEqual(5);
  });

  it('rejects a PDF without a text layer with a clear RU message', async () => {
    // A structurally valid PDF whose only content is a vector rectangle.
    const { default: PDFDocument } = await import('pdfkit');
    const pdf = new PDFDocument({ size: 'A4' });
    const chunks: Buffer[] = [];
    pdf.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((r) => pdf.on('end', () => r(Buffer.concat(chunks))));
    pdf.rect(100, 100, 200, 200).stroke();
    pdf.end();
    const bytes = new Uint8Array(await done);
    await expect(importPdf(bytes)).rejects.toThrow(/скан/);
  });
});
