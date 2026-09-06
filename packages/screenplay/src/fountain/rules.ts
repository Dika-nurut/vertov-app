/**
 * Shared classification rules for the Fountain dialect used across the
 * parser and the import adapters (which must emit Fountain that re-parses
 * to the intended element types).
 */

/**
 * Scene-heading prefixes, per the Fountain spec plus the RU screenwriting
 * convention (ИНТ. = интерьер, НАТ. = натура, ПАВ. = павильон).
 * Matched case-insensitively, followed by `.` or a space.
 */
export const SCENE_PREFIXES = [
  'INT./EXT',
  'INT/EXT',
  'EXT./INT',
  'EXT/INT',
  'INT',
  'EXT',
  'EST',
  'I/E',
  'ИНТ./НАТ',
  'ИНТ/НАТ',
  'НАТ./ИНТ',
  'НАТ/ИНТ',
  'ИНТ',
  'НАТ',
  'ПАВ',
  'ЭКСТ',
];

export const SCENE_HEADING_RE = new RegExp(
  `^(?:${SCENE_PREFIXES.map((p) => p.replace(/[./]/g, '\\$&')).join('|')})[. ]`,
  'i',
);

export function hasLetter(s: string): boolean {
  return /\p{L}/u.test(s);
}

/** Uppercase test that works for Cyrillic as well as Latin. */
export function isAllUpper(s: string): boolean {
  return hasLetter(s) && s === s.toUpperCase();
}
