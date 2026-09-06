import { parseFountain } from './fountain/parse.js';
import { stripInline } from './fountain/inline.js';

/**
 * Auto-extract a first draft of the «Библия проекта» from the screenplay:
 * character roster with a best-effort description pulled from the action
 * line that introduces them (the "МИХАЛЫЧ (60), киномеханик в потёртом
 * свитере" convention). The writer edits from there — this is a seed, not
 * an oracle.
 */

export interface ExtractedBible {
  characters: Array<{ name: string; description: string; lines: number }>;
}

/** Normalize a character line to the bare name: strip (В.З.)/(ЗК)/(V.O.) etc. */
function bareName(text: string): string {
  return text
    .replace(/\(.*?\)/g, '')
    .replace(/\s*\^$/, '')
    .trim();
}

export function extractBible(fountain: string): ExtractedBible {
  const doc = parseFountain(fountain);
  const byName = new Map<string, { lines: number; description: string }>();

  for (const el of doc.elements) {
    if (el.type !== 'character') continue;
    const name = bareName(el.text);
    if (!name) continue;
    const entry = byName.get(name) ?? { lines: 0, description: '' };
    entry.lines += 1;
    byName.set(name, entry);
  }

  // Introductions: the first action paragraph that mentions the name,
  // preferring the "NAME (age), description…" pattern.
  for (const el of doc.elements) {
    if (el.type !== 'action') continue;
    const text = stripInline(el.text).replace(/\s+/g, ' ');
    for (const [name, entry] of byName) {
      if (entry.description) continue;
      const idx = text.indexOf(name);
      if (idx === -1) continue;
      // Take the sentence that contains the mention.
      const start = text.lastIndexOf('.', idx) + 1;
      let end = text.indexOf('.', idx + name.length);
      if (end === -1) end = text.length;
      const sentence = text.slice(start, end + 1).trim();
      if (sentence) entry.description = sentence;
    }
  }

  const characters = [...byName.entries()]
    .sort((a, b) => b[1].lines - a[1].lines)
    .map(([name, e]) => ({ name, description: e.description, lines: e.lines }));
  return { characters };
}
