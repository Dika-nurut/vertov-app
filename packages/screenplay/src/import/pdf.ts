import { getDocumentProxy } from 'unpdf';
import type { FidelityIssue, ImportResult } from '../model.js';
import { SCENE_HEADING_RE } from '../fountain/rules.js';
import { reconstructScreenplay, type RawLine } from './heuristic.js';

/**
 * `.pdf` → Fountain, best-effort and fidelity-flagged.
 *
 * Reads the text layer per page (string + x/y from pdf.js), groups items
 * into lines by y, detects blank lines from vertical gaps, converts x into
 * monospace columns, and hands the result to the shared layout heuristic.
 * Scanned PDFs (no text layer) are rejected with a clear message — OCR is
 * out of scope.
 */

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
}

interface VisualLine {
  text: string;
  x0: number;
  width: number;
  gapBefore: number; // pt from the previous line on the same page; -1 = first
}

const TITLE_KEY_RE = /^([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё ]*):\s*(.+)$/;

export async function importPdf(data: Uint8Array): Promise<ImportResult> {
  const pdf = await getDocumentProxy(data);
  const pages: VisualLine[][] = [];
  const charWSamples: number[] = [];
  let pageWidth = 595;

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const items = (content.items as PdfTextItem[]).filter((it) => it.str.trim() !== '');
    if (items.length === 0) continue;
    pageWidth = (page.view?.[2] ?? 595) - (page.view?.[0] ?? 0);

    for (const it of items) {
      if (it.str.length >= 4) charWSamples.push(it.width / it.str.length);
    }

    // Group items into visual lines by y (2pt tolerance).
    const lineMap = new Map<number, PdfTextItem[]>();
    for (const it of items) {
      const y = it.transform[5]!;
      const key = [...lineMap.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
      const bucket = lineMap.get(key) ?? [];
      bucket.push(it);
      lineMap.set(key, bucket);
    }
    const ys = [...lineMap.keys()].sort((a, b) => b - a); // top → bottom

    const charW0 = median(charWSamples) || 7.2;
    const lines: VisualLine[] = ys.map((y, i) => {
      const bucket = lineMap.get(y)!.sort((a, b) => a.transform[4]! - b.transform[4]!);
      let text = '';
      let cursor: number | null = null;
      for (const it of bucket) {
        const x = it.transform[4]!;
        if (cursor !== null && x - cursor > charW0 * 0.6) text += ' ';
        text += it.str;
        cursor = x + it.width;
      }
      const x0 = bucket[0]!.transform[4]!;
      return {
        text,
        x0,
        width: cursor! - x0,
        gapBefore: i === 0 ? -1 : ys[i - 1]! - y,
      };
    });
    pages.push(lines);
  }

  if (pages.length === 0) {
    throw new Error(
      'В PDF нет текстового слоя (похоже на скан). Распознавание сканов не поддерживается — экспортируйте сценарий из редактора в PDF с текстом, .fdx или .fountain.',
    );
  }

  const charW = median(charWSamples) || 7.2;

  // ---- Title page: a first page with few lines and no scene heading. ----
  const extraIssues: FidelityIssue[] = [];
  let titleBlock = '';
  if (pages.length > 1) {
    const first = pages[0]!;
    const isTitlePage =
      first.length <= 12 && !first.some((l) => SCENE_HEADING_RE.test(l.text.trim()));
    if (isTitlePage) {
      const titleLines: string[] = [];
      for (const [i, l] of first.entries()) {
        const t = l.text.trim();
        const kv = TITLE_KEY_RE.exec(t);
        if (i === 0 && !kv) titleLines.push(`Title: ${t}`);
        else if (kv) titleLines.push(`${kv[1]}: ${kv[2]}`);
        else
          extraIssues.push({
            code: 'metadata-lost',
            message: 'Строка титульной страницы без ключа не перенесена',
            detail: t.slice(0, 80),
          });
      }
      if (titleLines.length > 0) titleBlock = titleLines.join('\n') + '\n\n';
      pages.shift();
    }
  }

  // ---- Global line advance + left margin, then RawLines. ----
  const allGaps = pages.flatMap((lines) =>
    lines.filter((l) => l.gapBefore > 0).map((l) => Math.round(l.gapBefore)),
  );
  const lineAdvance = smallestRecurring(allGaps) ?? 12;
  const minX = Math.min(...pages.flat().map((l) => l.x0));

  const rawLines: RawLine[] = pages.flatMap((lines, p) =>
    lines.map((l, i) => {
      const centerOffset = Math.abs(l.x0 + l.width / 2 - pageWidth / 2);
      return {
        text: l.text,
        indent: Math.round((l.x0 - minX) / charW),
        blankBefore: (i === 0 && p > 0) || l.gapBefore > lineAdvance * 1.6,
        centered: centerOffset < charW && l.x0 - minX > charW * 4,
      };
    }),
  );

  const result = reconstructScreenplay(rawLines, 'PDF');
  return {
    fountain: titleBlock + result.fountain,
    report: {
      lossless: false,
      issues: [...result.report.issues, ...extraIssues],
    },
  };
}

function median(nums: number[]): number | undefined {
  if (nums.length === 0) return undefined;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function smallestRecurring(nums: number[]): number | undefined {
  const freq = new Map<number, number>();
  for (const n of nums) freq.set(n, (freq.get(n) ?? 0) + 1);
  const recurring = [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .map(([n]) => n)
    .sort((a, b) => a - b);
  return recurring[0] ?? [...nums].sort((a, b) => a - b)[0];
}
