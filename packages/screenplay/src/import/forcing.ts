import { SCENE_HEADING_RE, isAllUpper } from '../fountain/rules.js';

/**
 * Import adapters generate Fountain text. These predicates decide when a
 * generated line must carry a forcing marker (`!` `@` `>` `.`) so that
 * re-parsing classifies it as the element the source format declared —
 * that is what makes fdx→fountain→fdx element-preserving.
 */

/** Leading characters that have Fountain meaning at line start. */
const SPECIAL_START = /^[.!@~>#=]|^\[\[|^\/\*|^={3,}/;

/** Would this line, emitted as action, be misread as another element? */
export function needsActionForce(line: string): boolean {
  const t = line.trim();
  if (t === '') return false;
  if (SPECIAL_START.test(t)) return true;
  if (SCENE_HEADING_RE.test(t)) return true;
  if (isAllUpper(t) && t.endsWith('TO:')) return true;
  return false;
}

/** Character lines that aren't all-caps need `@` (e.g. «МакСИМ», McCLANE). */
export function needsCharacterForce(name: string): boolean {
  return !isAllUpper(name.trim());
}

/** Transitions that don't match the spec pattern (…TO:) need `>`. */
export function needsTransitionForce(text: string): boolean {
  const t = text.trim();
  return !(isAllUpper(t) && t.endsWith('TO:'));
}
