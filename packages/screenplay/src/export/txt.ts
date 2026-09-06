import type { ScreenplayDoc } from '../model.js';
import { serializeFountain } from '../fountain/serialize.js';

/**
 * `.fountain` / `.txt` export: the canonical Fountain text itself —
 * Fountain is valid, readable plain text by design.
 */
export function exportFountain(doc: ScreenplayDoc): string {
  return serializeFountain(doc);
}

export const exportTxt = exportFountain;
