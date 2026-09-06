import PDFDocument from 'pdfkit';
import type { ScreenplayDoc } from '../model.js';
import { stripInline } from '../fountain/inline.js';

/**
 * Fountain → typeset screenplay PDF.
 *
 * Industry-standard Courier layout: 12pt monospace, 6 lines/inch, 1.5"
 * left margin, element-specific indents (character ≈ 2.2" from margin,
 * dialogue ≈ 1", parenthetical ≈ 1.6", transitions right-aligned).
 * PT Mono (OFL, vendored in fonts/) is the Courier-class face — chosen
 * because it carries full Cyrillic, which the PDF standard-14 Courier
 * does not.
 *
 * Default page size is A4 (RU industry); pass 'LETTER' for US delivery.
 */

const PT = 72; // points per inch

const FONT_SIZE = 12;
const LINE_HEIGHT = PT / 6; // exactly 6 lines per inch

// Indents in inches from the left text margin; widths in inches.
const LAYOUT = {
  margins: { top: 1, bottom: 1, left: 1.5, right: 1 },
  action: { indent: 0, width: 6 },
  scene_heading: { indent: 0, width: 6 },
  character: { indent: 2.2, width: 3.3 },
  parenthetical: { indent: 1.6, width: 2.4 },
  dialogue: { indent: 1, width: 3.5 },
  lyrics: { indent: 1, width: 3.5 },
  transition: { indent: 0, width: 6 },
} as const;

export interface PdfExportOptions {
  pageSize?: 'A4' | 'LETTER';
}

const FONT_URL = new URL('../../fonts/PTMono-Regular.ttf', import.meta.url);

export async function exportPdf(
  doc: ScreenplayDoc,
  options: PdfExportOptions = {},
): Promise<Uint8Array> {
  const pageSize = options.pageSize ?? 'A4';
  const pdf = new PDFDocument({
    size: pageSize,
    margins: {
      top: LAYOUT.margins.top * PT,
      bottom: LAYOUT.margins.bottom * PT,
      left: LAYOUT.margins.left * PT,
      right: LAYOUT.margins.right * PT,
    },
    bufferPages: true,
    info: titleOf(doc) ? { Title: titleOf(doc)! } : {},
  });

  const chunks: Buffer[] = [];
  pdf.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Uint8Array>((resolve, reject) => {
    pdf.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    pdf.on('error', reject);
  });

  pdf.registerFont('Screenplay', FONT_URL.pathname);
  pdf.font('Screenplay').fontSize(FONT_SIZE);

  const leftMargin = LAYOUT.margins.left * PT;
  const bottomY = pdf.page.height - LAYOUT.margins.bottom * PT;

  const ensureRoom = (lines: number) => {
    if (pdf.y + lines * LINE_HEIGHT > bottomY) pdf.addPage();
  };

  const write = (
    text: string,
    kind: keyof typeof LAYOUT & string,
    extra: PDFKit.Mixins.TextOptions = {},
  ) => {
    const l = LAYOUT[kind as 'action'];
    pdf.text(text, leftMargin + l.indent * PT, pdf.y, {
      width: l.width * PT,
      lineGap: LINE_HEIGHT - pdf.currentLineHeight(),
      ...extra,
    });
  };

  // ---- Title page ----
  if (doc.titlePage.length > 0) {
    renderTitlePage(pdf, doc);
    pdf.addPage();
  }

  // ---- Body ----
  const els = doc.elements;
  for (let i = 0; i < els.length; i++) {
    const el = els[i]!;
    const text = stripInline(el.text);
    switch (el.type) {
      case 'scene_heading': {
        // Keep the heading with at least two lines of what follows.
        ensureRoom(4);
        const label = el.sceneNumber ? `${text}  ${el.sceneNumber}` : text;
        write(label.toUpperCase(), 'scene_heading');
        break;
      }
      case 'action':
        write(text, 'action');
        break;
      case 'centered':
        pdf.text(text, leftMargin, pdf.y, {
          width: LAYOUT.action.width * PT,
          align: 'center',
          lineGap: LINE_HEIGHT - pdf.currentLineHeight(),
        });
        break;
      case 'character': {
        // Never orphan a character name at the bottom of a page.
        ensureRoom(3);
        write(text, 'character');
        break;
      }
      case 'parenthetical':
        write(text, 'parenthetical');
        break;
      case 'dialogue':
        if (text === '') pdf.moveDown(1);
        else write(text, 'dialogue');
        break;
      case 'lyrics':
        write(text, 'lyrics', { oblique: true });
        break;
      case 'transition':
        pdf.text(text, leftMargin, pdf.y, {
          width: LAYOUT.transition.width * PT,
          align: 'right',
          lineGap: LINE_HEIGHT - pdf.currentLineHeight(),
        });
        break;
      case 'page_break':
        pdf.addPage();
        break;
      case 'blank': {
        // Collapse runs of blank source lines into a single blank line,
        // and skip the blank that merely follows a block we already spaced.
        const prev = els[i - 1];
        const next = els[i + 1];
        if (
          prev &&
          next &&
          prev.type !== 'blank' &&
          next.type !== 'blank' &&
          pdf.y + LINE_HEIGHT <= bottomY
        ) {
          pdf.moveDown(1);
        }
        break;
      }
      default:
        break; // section, synopsis, note, boneyard: editorial, not typeset
    }
  }

  pdf.end();
  return done;
}

function titleOf(doc: ScreenplayDoc): string | undefined {
  const t = doc.titlePage.find((e) => /^(title|название)$/i.test(e.key));
  return t?.values.join(' ');
}

function renderTitlePage(pdf: PDFKit.PDFDocument, doc: ScreenplayDoc) {
  const width = pdf.page.width - LAYOUT.margins.left * PT - LAYOUT.margins.right * PT;
  const left = LAYOUT.margins.left * PT;
  const centered = { width, align: 'center' as const };

  const get = (re: RegExp) => doc.titlePage.find((e) => re.test(e.key))?.values ?? [];

  const title = get(/^(title|название)$/i);
  const credit = get(/^(credit)$/i);
  const author = get(/^(authors?|авторы?)$/i);
  const source = get(/^(source|источник)$/i);
  const bottomLeft = [
    ...get(/^(contact|контакт)$/i),
    ...get(/^(draft date|date|дата|черновик)$/i),
    ...get(/^(copyright|копирайт)$/i),
  ];

  pdf.y = pdf.page.height / 3;
  for (const line of title) pdf.text(stripInline(line).toUpperCase(), left, pdf.y, centered);
  pdf.moveDown(2);
  for (const line of credit) pdf.text(stripInline(line), left, pdf.y, centered);
  pdf.moveDown(1);
  for (const line of author) pdf.text(stripInline(line), left, pdf.y, centered);
  pdf.moveDown(2);
  for (const line of source) pdf.text(stripInline(line), left, pdf.y, centered);

  if (bottomLeft.length > 0) {
    // Default leading is taller than LINE_HEIGHT — leave slack so the last
    // line cannot trip pdfkit's auto-pagination.
    pdf.y =
      pdf.page.height -
      LAYOUT.margins.bottom * PT -
      (bottomLeft.length + 1) * pdf.currentLineHeight();
    for (const line of bottomLeft) pdf.text(stripInline(line), left, pdf.y);
  }
}
