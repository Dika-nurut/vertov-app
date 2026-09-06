import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { getDocumentProxy } from 'unpdf';

/**
 * Raw-text extraction for МИР ПРОЕКТА file attachments.
 *
 * Unlike the screenplay import adapters (which parse a script into Fountain),
 * this returns the document's plain text VERBATIM — the whole file goes into
 * context, never summarized («без выжимки», spec §4b). Reuses the same
 * unzip/xml/pdf primitives as the adapters, minus the layout heuristic.
 */

export type PlainTextFormat =
  | 'txt'
  | 'md'
  | 'markdown'
  | 'fountain'
  | 'spmd'
  | 'docx'
  | 'pdf'
  | 'highland';

/** Extract the plain text of a supported file, whole. */
export async function extractText(format: string, data: Uint8Array): Promise<string> {
  switch (format.toLowerCase()) {
    case 'docx':
      return extractDocxText(data);
    case 'pdf':
      return extractPdfText(data);
    case 'highland':
      return extractHighlandText(data);
    default:
      // txt / md / markdown / fountain / spmd — already plain UTF-8.
      return Buffer.from(data).toString('utf-8');
  }
}

function collectStrings(node: unknown, tag: string, out: string[]): void {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, tag, out);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === tag) {
      if (typeof value === 'string') out.push(value);
      else if (Array.isArray(value)) for (const v of value) if (typeof v === 'string') out.push(v);
    } else if (key === 'w:p') {
      // Paragraph boundary → newline between paragraphs.
      const paras = Array.isArray(value) ? value : [value];
      for (const p of paras) {
        const before = out.length;
        collectStrings(p, tag, out);
        if (out.length > before) out.push('\n');
      }
    } else {
      collectStrings(value, tag, out);
    }
  }
}

function extractDocxText(data: Uint8Array): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    throw new Error('Не удалось прочитать DOCX: файл не является zip-архивом Word.');
  }
  const docXml = files['word/document.xml'];
  if (!docXml) throw new Error('Не удалось прочитать DOCX: в архиве нет word/document.xml.');
  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: false,
    isArray: (name) => name === 'w:p' || name === 'w:r' || name === 'w:t',
  });
  const root = parser.parse(Buffer.from(docXml).toString('utf-8'));
  const out: string[] = [];
  collectStrings(root, 'w:t', out);
  const text = out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text === '') throw new Error('Не удалось прочитать DOCX: документ не содержит текста.');
  return text;
}

async function extractPdfText(data: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(data);
  const pageTexts: string[] = [];
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const items = (content.items as Array<{ str: string; transform: number[] }>).filter(
      (it) => it.str.trim() !== '',
    );
    // Group by y (line), top→bottom, then left→right.
    const lines = new Map<number, Array<{ str: string; x: number }>>();
    for (const it of items) {
      const y = Math.round(it.transform[5]! / 2) * 2;
      const bucket = lines.get(y) ?? [];
      bucket.push({ str: it.str, x: it.transform[4]! });
      lines.set(y, bucket);
    }
    const ys = [...lines.keys()].sort((a, b) => b - a);
    const text = ys
      .map((y) =>
        lines
          .get(y)!
          .sort((a, b) => a.x - b.x)
          .map((i) => i.str)
          .join(' '),
      )
      .join('\n');
    if (text.trim()) pageTexts.push(text);
  }
  const text = pageTexts.join('\n\n').trim();
  if (text === '')
    throw new Error('Не удалось прочитать PDF: нет текстового слоя (сканы не поддерживаются).');
  return text;
}

function extractHighlandText(data: Uint8Array): string {
  // A .highland is a zip; the Fountain text lives at text.fountain.
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    return Buffer.from(data).toString('utf-8');
  }
  const key = Object.keys(files).find((k) => k.toLowerCase().endsWith('.fountain'));
  if (!key) throw new Error('Не удалось прочитать .highland: нет text.fountain в архиве.');
  return Buffer.from(files[key]!).toString('utf-8').trim();
}
