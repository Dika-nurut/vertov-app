import type { ElementType } from './model.js';
import { SCENE_HEADING_RE, isAllUpper } from './fountain/rules.js';

/**
 * Tab element cycling for the canvas: retype the current line's Fountain
 * syntax to the next element type, preserving its semantic text verbatim.
 *
 * Fidelity note: because the parser is line-lossless, ANY line this produces
 * round-trips through serialize(parse(x)) unchanged — byte-fidelity is free.
 * What matters, and what the tests guard, is CLASSIFICATION: the produced
 * line must actually parse as the intended type. Fountain gives us forced
 * markers for scene / character / transition (`.` `@` `>`), so those are
 * context-independent and always land. Dialogue, parenthetical and action
 * have no forced marker — they are contextual — so cycling to them is a
 * best-effort that lands inside the appropriate block (dialogue/parenthetical
 * under a character cue) and degrades to action outside one. That is the
 * honest behaviour of the format, not a bug.
 */

/** The visible Tab cycle (spec §3): действие → персонаж → реплика → ремарка → переход → сцена → … */
export const ELEMENT_CYCLE: ElementType[] = [
  'action',
  'character',
  'dialogue',
  'parenthetical',
  'transition',
  'scene_heading',
];

/** Short RU labels for the element ribbon chip. */
export const ELEMENT_LABEL_RU: Partial<Record<ElementType, string>> = {
  scene_heading: 'СЦЕНА',
  action: 'ДЕЙСТВИЕ',
  character: 'ПЕРСОНАЖ',
  dialogue: 'РЕПЛИКА',
  parenthetical: 'РЕМАРКА',
  transition: 'ПЕРЕХОД',
  section: 'РАЗДЕЛ',
  synopsis: 'СИНОПСИС',
  lyrics: 'ЛИРИКА',
  centered: 'ПО ЦЕНТРУ',
};

/** The element that follows `type` in the Tab cycle (wraps; off-cycle → action). */
export function nextElement(type: ElementType): ElementType {
  const i = ELEMENT_CYCLE.indexOf(type);
  if (i === -1) return 'action';
  return ELEMENT_CYCLE[(i + 1) % ELEMENT_CYCLE.length]!;
}

/**
 * Strip any forced marker / wrapping syntax from a line, leaving the bare
 * semantic text. The inverse used by `setLineElement`, so a full cycle
 * preserves the writer's words through every step.
 */
export function bareLineText(line: string): string {
  let t = line.trim();
  // Parenthetical wrapper.
  if (t.startsWith('(') && t.endsWith(')') && t.length >= 2) t = t.slice(1, -1).trim();
  // Leading forced markers (one only — they are mutually exclusive).
  if (t.startsWith('@')) t = t.slice(1);
  else if (t.startsWith('!')) t = t.slice(1);
  else if (t.startsWith('~')) t = t.slice(1);
  else if (t.startsWith('>')) t = t.replace(/^>\s?/, '').replace(/\s?<$/, '');
  else if (t.startsWith('.') && !t.startsWith('..')) t = t.slice(1);
  // Trailing dual-dialogue caret on a character cue.
  t = t.replace(/\s*\^$/, '');
  return t.trim();
}

/** Would this bare text auto-classify as something other than plain action? */
function bareAutoClassifies(bare: string): boolean {
  if (bare === '') return false;
  if (/^[.!@~>#=([]/.test(bare)) return true;
  if (SCENE_HEADING_RE.test(bare)) return true;
  if (isAllUpper(bare)) return true; // would read as a character cue / transition
  if (/\bTO:$/.test(bare)) return true;
  return false;
}

/**
 * Rewrite `line` so it parses as `target`, keeping its bare text. Uses forced
 * markers for the deterministic types; leaves the contextual types bare
 * (dialogue) or wrapped (parenthetical); forces action only when the bare
 * text would otherwise auto-classify.
 */
export function setLineElement(line: string, target: ElementType): string {
  const bare = bareLineText(line);
  switch (target) {
    case 'scene_heading':
      return `.${bare}`;
    case 'character':
      return `@${bare}`;
    case 'transition':
      return `> ${bare}`;
    case 'parenthetical':
      return `(${bare})`;
    case 'dialogue':
      return bare;
    case 'action':
    default:
      return bareAutoClassifies(bare) ? `!${bare}` : bare;
  }
}

/** Advance the current line to the next element type in the Tab cycle. */
export function cycleLineElement(
  line: string,
  currentType: ElementType,
): { type: ElementType; line: string } {
  const type = nextElement(currentType);
  return { type, line: setLineElement(line, type) };
}
