import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import type { ImportResult } from '../model.js';
import { reconstructScreenplay, type RawLine } from './heuristic.js';

/**
 * `.docx` → Fountain, best-effort and fidelity-flagged.
 *
 * A docx is a zip with the document at word/document.xml. We read each
 * paragraph's text, indentation (w:ind, twips), alignment and style name,
 * then run the same layout heuristic as the PDF path. Empty paragraphs
 * separate blocks the way blank lines do in Fountain.
 */

const TWIPS_PER_CHAR = 144; // 1440 twips/inch ÷ 10 chars/inch (12pt Courier)

export function importDocx(data: Uint8Array): ImportResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    throw new Error('Не удалось прочитать DOCX: файл не является zip-архивом Word.');
  }
  const docXml = files['word/document.xml'];
  if (!docXml) {
    throw new Error('Не удалось прочитать DOCX: в архиве нет word/document.xml.');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    isArray: (name) => name === 'w:p' || name === 'w:r' || name === 'w:t' || name === 'w:br',
  });
  const root = parser.parse(Buffer.from(docXml).toString('utf-8')) as Record<string, unknown>;
  const body = (root['w:document'] as Record<string, unknown> | undefined)?.['w:body'] as
    | Record<string, unknown>
    | undefined;
  if (!body) {
    throw new Error('Не удалось прочитать DOCX: пустое или нестандартное тело документа.');
  }

  const paras = (body['w:p'] as unknown[] | undefined) ?? [];
  const rawLines: RawLine[] = [];
  let pendingBlank = false;

  for (const raw of paras) {
    const p = raw as Record<string, unknown>;
    const pPr = p['w:pPr'] as Record<string, unknown> | undefined;
    const text = paragraphText(p);

    if (text.trim() === '') {
      pendingBlank = true;
      continue;
    }

    const ind = pPr?.['w:ind'] as Record<string, unknown> | undefined;
    const twips = Number((ind?.['@_w:left'] as string | undefined) ?? '0') || 0;
    const jc = (pPr?.['w:jc'] as Record<string, unknown> | undefined)?.['@_w:val'];
    const style = (pPr?.['w:pStyle'] as Record<string, unknown> | undefined)?.['@_w:val'];
    const spacing = pPr?.['w:spacing'] as Record<string, unknown> | undefined;
    const before = Number((spacing?.['@_w:before'] as string | undefined) ?? '0') || 0;

    for (const [i, line] of text.split('\n').entries()) {
      rawLines.push({
        text: line,
        indent: Math.round(twips / TWIPS_PER_CHAR),
        blankBefore: i === 0 && (pendingBlank || before >= 240),
        ...(jc === 'center' ? { centered: true } : {}),
        ...(typeof style === 'string' ? { styleHint: style.toLowerCase() } : {}),
      });
    }
    pendingBlank = false;
  }

  if (rawLines.length === 0) {
    throw new Error('Не удалось прочитать DOCX: документ не содержит текста.');
  }

  return reconstructScreenplay(rawLines, 'DOCX');
}

function paragraphText(p: Record<string, unknown>): string {
  const runs = (p['w:r'] as unknown[] | undefined) ?? [];
  let text = '';
  for (const raw of runs) {
    const r = raw as Record<string, unknown>;
    if (r['w:br'] !== undefined) text += '\n';
    const ts = (r['w:t'] as unknown[] | undefined) ?? [];
    for (const t of ts) {
      if (typeof t === 'string') text += t;
      else if (t && typeof t === 'object') {
        const inner = (t as Record<string, unknown>)['#text'];
        if (typeof inner === 'string') text += inner;
      }
    }
  }
  return text;
}
