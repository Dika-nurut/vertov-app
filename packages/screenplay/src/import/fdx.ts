import { XMLParser } from 'fast-xml-parser';
import type { FidelityIssue, ImportResult } from '../model.js';
import { SCENE_HEADING_RE } from '../fountain/rules.js';
import { needsActionForce, needsCharacterForce, needsTransitionForce } from './forcing.js';

/**
 * Final Draft `.fdx` → Fountain.
 *
 * FDX is the industry interchange format: a `<FinalDraft>` root with
 * `<Content><Paragraph Type="…"><Text>…</Text></Paragraph></Content>`.
 * Mapped types: Scene Heading, Action, Character, Parenthetical, Dialogue,
 * Transition, Shot (→ forced action), General (→ action). Everything else
 * degrades to action with a fidelity issue — never dropped.
 */

interface TextRun {
  text: string;
  style: string;
}

interface Para {
  type: string;
  runs: TextRun[];
  number?: string;
  alignment?: string;
}

function collectRuns(textNode: unknown): TextRun[] {
  if (textNode === undefined || textNode === null) return [];
  const nodes = Array.isArray(textNode) ? textNode : [textNode];
  const runs: TextRun[] = [];
  for (const n of nodes) {
    if (typeof n === 'string') {
      runs.push({ text: n, style: '' });
    } else if (typeof n === 'object') {
      const o = n as Record<string, unknown>;
      runs.push({
        text: typeof o['#text'] === 'string' ? (o['#text'] as string) : '',
        style: typeof o['@_Style'] === 'string' ? (o['@_Style'] as string) : '',
      });
    }
  }
  return runs;
}

/** Apply Fountain emphasis for FD style runs (Bold/Italic/Underline). */
function runToFountain(run: TextRun): string {
  let s = run.text;
  if (s.trim() === '') return s;
  if (run.style.includes('Underline')) s = `_${s}_`;
  if (run.style.includes('Italic')) s = `*${s}*`;
  if (run.style.includes('Bold')) s = `**${s}**`;
  return s;
}

function paraText(p: Para, styled: boolean): string {
  return p.runs.map((r) => (styled ? runToFountain(r) : r.text)).join('');
}

function toParas(content: unknown): Para[] {
  const c = content as Record<string, unknown> | undefined;
  const list = c?.['Paragraph'];
  if (!list) return [];
  const arr = Array.isArray(list) ? list : [list];
  return arr.map((raw) => {
    const o = raw as Record<string, unknown>;
    return {
      type: typeof o['@_Type'] === 'string' ? (o['@_Type'] as string) : 'Action',
      runs: collectRuns(o['Text']),
      ...(typeof o['@_Number'] === 'string' ? { number: o['@_Number'] as string } : {}),
      ...(typeof o['@_Alignment'] === 'string' ? { alignment: o['@_Alignment'] as string } : {}),
    };
  });
}

const TITLE_KEY_RE = /^([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё ]*):\s*(.*)$/;

export function importFdx(xml: string): ImportResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    isArray: (name) => name === 'Paragraph' || name === 'Text',
  });

  let root: Record<string, unknown>;
  try {
    root = parser.parse(xml) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Не удалось прочитать FDX: файл не является корректным XML (${(err as Error).message})`,
    );
  }
  const fd = root['FinalDraft'] as Record<string, unknown> | undefined;
  if (!fd) {
    throw new Error('Не удалось прочитать FDX: нет корневого элемента FinalDraft');
  }

  const issues: FidelityIssue[] = [];
  const out: string[] = [];

  // ---- Title page: FD title pages are free-form paragraphs. Keep
  // key:value lines as Fountain title keys; treat the first other
  // non-empty line as the Title; report anything else as lost. ----
  const titlePage = fd['TitlePage'] as Record<string, unknown> | undefined;
  const titleParas = toParas(titlePage?.['Content']);
  const titleLines: string[] = [];
  let sawTitle = false;
  for (const p of titleParas) {
    const text = paraText(p, false).trim();
    if (text === '') continue;
    const kv = TITLE_KEY_RE.exec(text);
    if (kv) {
      titleLines.push(`${kv[1]}: ${kv[2]}`);
      if (kv[1]!.trim().toLowerCase() === 'title') sawTitle = true;
    } else if (!sawTitle) {
      titleLines.push(`Title: ${text}`);
      sawTitle = true;
    } else {
      issues.push({
        code: 'metadata-lost',
        message: 'Строка титульной страницы без ключа не перенесена',
        detail: text.slice(0, 80),
      });
    }
  }
  if (titleLines.length > 0) {
    // Fountain requires Title first if present.
    titleLines.sort(
      (a, b) =>
        (b.toLowerCase().startsWith('title:') ? 1 : 0) -
        (a.toLowerCase().startsWith('title:') ? 1 : 0),
    );
    out.push(...titleLines, '');
  }

  // ---- Body ----
  const paras = toParas((fd['Content'] as Record<string, unknown> | undefined) ?? {});
  let prevWasDialogueBlock = false;

  for (const p of paras) {
    const styled = paraText(p, true);
    const plain = paraText(p, false);
    const lines = styled.split('\n');
    const isDialogueType = p.type === 'Parenthetical' || p.type === 'Dialogue';

    const emitBlock = (blockLines: string[]) => {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      out.push(...blockLines);
    };

    switch (p.type) {
      case 'Scene Heading': {
        const suffix = p.number ? ` #${p.number}#` : '';
        const text = styled.trim();
        if (text === '') break;
        emitBlock([`${looksLikeHeading(text) ? '' : '.'}${text}${suffix}`]);
        break;
      }
      case 'Character': {
        const text = styled.trim();
        if (text === '') break;
        emitBlock([`${needsCharacterForce(text) ? '@' : ''}${text}`]);
        prevWasDialogueBlock = true;
        continue;
      }
      case 'Parenthetical':
      case 'Dialogue': {
        const text = styled.replace(/\s+$/, '');
        if (!prevWasDialogueBlock) {
          // Dialogue with no character above it can't exist in Fountain.
          issues.push({
            code: 'structure-guessed',
            message: 'Реплика без персонажа импортирована как ремарка',
            detail: plain.trim().slice(0, 80),
          });
          emitBlock(text.split('\n').map((l) => (l.trim() === '' ? '' : l)));
          break;
        }
        const dlgLines =
          p.type === 'Parenthetical'
            ? [text.trim().startsWith('(') ? text.trim() : `(${text.trim()})`]
            : text.split('\n').map((l) => (l.trim() === '' ? '  ' : l));
        out.push(...dlgLines);
        continue;
      }
      case 'Transition': {
        const text = styled.trim();
        if (text === '') break;
        emitBlock([`${needsTransitionForce(text) ? '> ' : ''}${text}`]);
        break;
      }
      case 'Shot': {
        const text = styled.trim();
        if (text === '') break;
        issues.push({
          code: 'formatting-lost',
          message: 'Элемент Shot импортирован как описание действия',
          detail: plain.trim().slice(0, 80),
        });
        emitBlock([`${needsActionForce(text) ? '!' : ''}${text}`]);
        break;
      }
      case 'General':
      case 'Action':
      default: {
        if (p.type !== 'Action' && p.type !== 'General') {
          issues.push({
            code: 'unsupported-element',
            message: `Тип «${p.type}» не поддерживается, импортирован как описание действия`,
            detail: plain.trim().slice(0, 80),
          });
        }
        if (plain.trim() === '') break;
        if (p.alignment === 'Center') {
          emitBlock(lines.map((l) => `> ${l.trim()} <`));
          break;
        }
        const first = lines[0]!.trim();
        const force = needsActionForce(first) || wouldMisclassify(lines);
        emitBlock(lines.map((l, idx) => (idx === 0 && force ? `!${l}` : l)));
        break;
      }
    }
    prevWasDialogueBlock = isDialogueType && prevWasDialogueBlock;
  }

  const fountain = out.join('\n') + (out.length > 0 ? '\n' : '');
  return {
    fountain,
    report: { lossless: issues.length === 0, issues },
  };
}

function looksLikeHeading(text: string): boolean {
  return SCENE_HEADING_RE.test(text);
}

/** Would a multi-line action paragraph misparse (e.g. caps first line → character)? */
function wouldMisclassify(lines: string[]): boolean {
  const first = lines[0]!.trim();
  if (lines.length > 1 && first === first.toUpperCase() && /\p{L}/u.test(first)) {
    return true; // caps line followed by text would parse as CHARACTER
  }
  return false;
}
