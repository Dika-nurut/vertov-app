import type { ScreenplayDoc } from '../model.js';

/**
 * Re-emit the document exactly as parsed. Because the parser is
 * line-lossless, `serializeFountain(parseFountain(x)) === x` for any input.
 */
export function serializeFountain(doc: ScreenplayDoc): string {
  const lines: string[] = [];
  for (const entry of doc.titlePage) lines.push(...entry.raw);
  for (const el of doc.elements) lines.push(...el.raw);
  return lines.join('\n');
}
