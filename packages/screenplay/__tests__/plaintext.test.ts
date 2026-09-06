import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extractText } from '../src/index.js';

function docxOf(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`)
    .join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return zipSync({ 'word/document.xml': strToU8(documentXml) });
}

describe('extractText — raw text, whole (no summarization)', () => {
  it('passes plain formats through verbatim (UTF-8)', async () => {
    const bytes = strToU8('Логлайн: механик.\nСинопсис: ночь.');
    expect(await extractText('txt', bytes)).toBe('Логлайн: механик.\nСинопсис: ночь.');
    expect(await extractText('md', bytes)).toBe('Логлайн: механик.\nСинопсис: ночь.');
  });

  it('extracts docx paragraph text, paragraphs separated by newlines', async () => {
    const out = await extractText('docx', docxOf(['Первый абзац.', 'Второй абзац про Марка.']));
    expect(out).toContain('Первый абзац.');
    expect(out).toContain('Второй абзац про Марка.');
    expect(out.indexOf('Первый')).toBeLessThan(out.indexOf('Второй'));
  });

  it('throws a clear RU error on an empty docx', async () => {
    await expect(extractText('docx', docxOf([]))).rejects.toThrow(/DOCX/);
  });
});
