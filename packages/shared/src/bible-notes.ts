/**
 * МИР ПРОЕКТА is a flat list of free-text notes (the Claude-Projects model):
 * the редактор reads it before every answer and the model itself understands
 * what's a person, a rule or a tone — no types, no rubrics.
 *
 * Storage lives in the existing `scripts.bible` jsonb. Legacy bibles carried
 * typed `characters` / `tone` / `rules`; this folds them losslessly into the
 * notes list on read, so old projects show their canon as notes and persist
 * as `{ notes }` on the first edit (a lazy, safe migration — no jsonb SQL).
 */

export interface BibleShape {
  notes?: Array<string | BibleNote> | undefined;
  characters?: Array<{ name: string; description: string }> | undefined;
  tone?: string[] | undefined;
  rules?: string[] | undefined;
}

export interface BibleNote {
  id: string;
  content: string;
  includeInAi: boolean;
}

/** Normalize any bible (new notes or legacy typed fields) to a flat notes list. */
export function bibleNotes(bible: BibleShape | null | undefined): string[] {
  const b = bible ?? {};
  const notes: string[] = [];
  for (const n of b.notes ?? []) {
    if (typeof n !== 'string' && !n.includeInAi) continue;
    const t = (typeof n === 'string' ? n : n.content).trim();
    if (t) notes.push(t);
  }
  for (const c of b.characters ?? []) {
    const name = c.name.trim();
    const desc = c.description.trim();
    if (name || desc) notes.push(desc ? `${name} — ${desc}` : name);
  }
  const tone = (b.tone ?? []).map((t) => t.trim()).filter(Boolean);
  if (tone.length) notes.push(`Тон: ${tone.join(', ')}`);
  for (const r of b.rules ?? []) {
    const t = r.trim();
    if (t) notes.push(t);
  }
  return notes;
}
