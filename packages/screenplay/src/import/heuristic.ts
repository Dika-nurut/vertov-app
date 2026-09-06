import type { FidelityIssue, ImportResult } from '../model.js';
import { SCENE_HEADING_RE, isAllUpper } from '../fountain/rules.js';
import { needsActionForce, needsCharacterForce, needsTransitionForce } from './forcing.js';

/**
 * Best-effort screenplay reconstruction from layout-flattened sources
 * (PDF text layer, DOCX). The screenplay page IS its layout: element roles
 * are encoded in indentation columns (action at the left margin, dialogue
 * ≈ +10 chars, parenthetical ≈ +16, character ≈ +22, transitions at the
 * right edge). We classify by explicit style hints when the source has
 * them, then by indent + text shape, and always return a fidelity report
 * marked lossy — this path guesses structure by design.
 */

export interface RawLine {
  text: string;
  /** Approximate character column of the line start (monospace units). */
  indent: number;
  /** A vertical gap (or empty paragraph) separates this line from the previous. */
  blankBefore: boolean;
  centered?: boolean;
  /** Lowercased source style name, when the format carries one (docx). */
  styleHint?: string;
}

type Role =
  | 'scene_heading'
  | 'action'
  | 'character'
  | 'parenthetical'
  | 'dialogue'
  | 'transition'
  | 'centered';

const STYLE_ROLES: Array<[RegExp, Role]> = [
  [/scene|heading|слаглайн|заголовок/, 'scene_heading'],
  [/character|персонаж|герой/, 'character'],
  [/paren|ремарка/, 'parenthetical'],
  [/dialog|диалог|реплика/, 'dialogue'],
  [/transition|переход/, 'transition'],
  [/action|действие|описание/, 'action'],
];

// Relative indents (chars from the action margin) that mark dialogue-block
// columns in the standard Courier layout; generous tolerances on purpose.
const DIALOGUE_MIN = 6;
const CHARACTER_MIN = 15;

export function reconstructScreenplay(rawLines: RawLine[], sourceLabel: string): ImportResult {
  const lines = rawLines.filter((l) => l.text.trim() !== '' || l.blankBefore);
  const issues: FidelityIssue[] = [
    {
      code: 'structure-guessed',
      message: `Импорт из ${sourceLabel}: структура сценария восстановлена по вёрстке (эвристика). Проверьте результат.`,
    },
  ];

  // Baseline = the most common indent column (the action/left margin in a
  // typeset screenplay; dialogue-heavy pages still keep action leftmost, so
  // take the SMALLEST column that is common).
  const freq = new Map<number, number>();
  for (const l of lines) {
    if (l.text.trim() === '') continue;
    const col = Math.round(l.indent / 2) * 2;
    freq.set(col, (freq.get(col) ?? 0) + 1);
  }
  const total = [...freq.values()].reduce((a, b) => a + b, 0);
  const common = [...freq.entries()]
    .filter(([, n]) => n >= Math.max(2, total * 0.05))
    .map(([col]) => col)
    .sort((a, b) => a - b);
  const baseline = common[0] ?? 0;
  const indentsMeaningful = common.length > 1;

  // ---- classify ----
  const roles: Array<{ role: Role | 'blank'; line: RawLine }> = [];
  const prevRole = (): Role | 'blank' | undefined => roles[roles.length - 1]?.role;

  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx]!;
    const t = l.text.trim();
    if (l.blankBefore && roles.length > 0) roles.push({ role: 'blank', line: l });
    if (t === '') continue;
    const rel = l.indent - baseline;
    const next = lines[idx + 1];
    const nextAttached = next !== undefined && !next.blankBefore && next.text.trim() !== '';

    let role: Role | undefined;
    if (l.styleHint) {
      role = STYLE_ROLES.find(([re]) => re.test(l.styleHint!))?.[1];
    }
    if (!role) {
      const inDialogueBlock =
        prevRole() === 'character' || prevRole() === 'parenthetical' || prevRole() === 'dialogue';
      if (SCENE_HEADING_RE.test(t)) role = 'scene_heading';
      else if (isAllUpper(t) && /(TO|ИЗ):$/.test(t)) role = 'transition';
      else if (isAllUpper(t) && nextAttached && (indentsMeaningful ? rel >= CHARACTER_MIN : true))
        role = 'character';
      // Mixed-case name AT the character column (e.g. «МакСИМ», McCLANE).
      else if (indentsMeaningful && rel >= CHARACTER_MIN && nextAttached && !t.startsWith('('))
        role = 'character';
      else if (inDialogueBlock && t.startsWith('(')) role = 'parenthetical';
      else if (inDialogueBlock && (!indentsMeaningful || rel >= DIALOGUE_MIN)) role = 'dialogue';
      else if (l.centered) role = 'centered';
      else role = 'action';
    }
    roles.push({ role, line: l });
  }

  // ---- emit fountain ----
  const out: string[] = [];
  const emitBlock = (blockLines: string[]) => {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    out.push(...blockLines);
  };

  for (let idx = 0; idx < roles.length; idx++) {
    const { role, line } = roles[idx]!;
    const t = line.text.trim();
    const prev = roles[idx - 1]?.role;
    switch (role) {
      case 'blank':
        break;
      case 'scene_heading':
        emitBlock([`${SCENE_HEADING_RE.test(t) ? '' : '.'}${t}`]);
        break;
      case 'transition':
        emitBlock([`${needsTransitionForce(t) ? '> ' : ''}${t}`]);
        break;
      case 'character':
        emitBlock([`${needsCharacterForce(t) ? '@' : ''}${t}`]);
        break;
      case 'parenthetical': {
        const wrapped = t.startsWith('(') ? t : `(${t})`;
        if (prev === 'character' || prev === 'dialogue' || prev === 'parenthetical')
          out.push(wrapped);
        else emitBlock([wrapped]);
        break;
      }
      case 'dialogue': {
        // Dialogue must stay attached to its block; wrapped PDF lines just
        // continue. A dialogue line the classifier orphaned becomes action.
        if (prev === 'character' || prev === 'dialogue' || prev === 'parenthetical') out.push(t);
        else emitBlock([`${needsActionForce(t) ? '!' : ''}${t}`]);
        break;
      }
      case 'centered':
        emitBlock([`> ${t} <`]);
        break;
      case 'action': {
        // Consecutive action lines with no gap merge into one paragraph.
        if (prev === 'action') out.push(t);
        else emitBlock([`${needsActionForce(t) ? '!' : ''}${t}`]);
        break;
      }
    }
  }

  return {
    fountain: out.join('\n') + (out.length > 0 ? '\n' : ''),
    report: { lossless: false, issues },
  };
}
