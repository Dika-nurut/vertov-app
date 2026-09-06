import type { ImportResult } from '../model.js';

/**
 * `.fountain` / `.spmd` / `.txt` import: Fountain IS the canonical format
 * and is designed to degrade gracefully to plain text, so this is an
 * identity mapping (minus a UTF-8 BOM, which would corrupt the first line's
 * classification). Always lossless.
 */
export function importFountain(text: string): ImportResult {
  return {
    fountain: text.replace(/^\uFEFF/, ''),
    report: { lossless: true, issues: [] },
  };
}

export const importTxt = importFountain;
