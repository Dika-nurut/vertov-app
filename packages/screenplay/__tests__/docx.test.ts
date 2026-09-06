import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { importDocx, parseFountain, type FountainElement } from '../src/index.js';

const byType = (els: FountainElement[], type: string) => els.filter((e) => e.type === type);

/** Build a minimal Word document around the given body paragraphs. */
function docxOf(paragraphsXml: string): Uint8Array {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${paragraphsXml}</w:body>
</w:document>`;
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    ),
    'word/document.xml': strToU8(documentXml),
  });
}

const p = (text: string, opts: { indent?: number; style?: string; center?: boolean } = {}) => {
  const pr =
    opts.indent || opts.style || opts.center
      ? `<w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ''}${
          opts.center ? '<w:jc w:val="center"/>' : ''
        }${opts.indent ? `<w:ind w:left="${opts.indent}"/>` : ''}</w:pPr>`
      : '';
  return `<w:p>${pr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
};
const blank = '<w:p/>';

describe('importDocx — indent-based reconstruction (Word screenplay layout)', () => {
  it('classifies by the standard Courier columns', () => {
    const bytes = docxOf(
      [
        p('ИНТ. КВАРТИРА - ДЕНЬ'),
        blank,
        p('Свет мигает. На стене — старые афиши.'),
        blank,
        p('ВЕРА', { indent: 3168 }), // 2.2" in twips
        p('(шёпотом)', { indent: 2304 }), // 1.6"
        p('Ты это слышал?', { indent: 1440 }), // 1"
        blank,
        p('CUT TO:'),
      ].join(''),
    );
    const { fountain, report } = importDocx(bytes);
    const doc = parseFountain(fountain);

    expect(report.lossless).toBe(false);
    expect(byType(doc.elements, 'scene_heading')[0]!.text).toBe('ИНТ. КВАРТИРА - ДЕНЬ');
    expect(byType(doc.elements, 'character')[0]!.text).toBe('ВЕРА');
    expect(byType(doc.elements, 'parenthetical')[0]!.text).toBe('(шёпотом)');
    expect(byType(doc.elements, 'dialogue')[0]!.text).toBe('Ты это слышал?');
    expect(byType(doc.elements, 'transition')[0]!.text).toBe('CUT TO:');
  });

  it('falls back to text-shape rules when the docx has no indents', () => {
    const bytes = docxOf(
      [
        p('НАТ. ДВОР - ВЕЧЕР'),
        blank,
        p('МИША'),
        p('Опять дождь.'),
        blank,
        p('Он поднимает воротник.'),
      ].join(''),
    );
    const doc = parseFountain(importDocx(bytes).fountain);
    expect(byType(doc.elements, 'character')[0]!.text).toBe('МИША');
    expect(byType(doc.elements, 'dialogue')[0]!.text).toBe('Опять дождь.');
    expect(byType(doc.elements, 'action').map((a) => a.text)).toContain('Он поднимает воротник.');
  });

  it('honours explicit screenplay style names over layout', () => {
    const bytes = docxOf(
      [p('MARLOWE', { style: 'Character' }), p('Nothing personal.', { style: 'Dialogue' })].join(
        '',
      ),
    );
    const doc = parseFountain(importDocx(bytes).fountain);
    expect(byType(doc.elements, 'character')[0]!.text).toBe('MARLOWE');
    expect(byType(doc.elements, 'dialogue')[0]!.text).toBe('Nothing personal.');
  });

  it('rejects a non-zip file with a clear message', () => {
    expect(() => importDocx(strToU8('not a zip'))).toThrow(/zip/);
  });

  it('rejects a zip without word/document.xml', () => {
    const bytes = zipSync({ 'hello.txt': strToU8('hi') });
    expect(() => importDocx(bytes)).toThrow(/document\.xml/);
  });
});
