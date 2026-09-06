/**
 * Thread-anchor relocation: a sidebar thread is pinned to a character-offset
 * span of the fountain text at some revision. After edits the offsets drift;
 * we re-locate by exact quote match (with fuzzy fallbacks) instead of
 * trusting offsets across revisions. A thread that can't re-anchor degrades
 * to 'detached' — visible, never lost.
 */

export interface AnchorSpan {
  from: number;
  to: number;
  rev: number;
  quote: string;
}

export type RelocatedAnchor =
  | { status: 'exact'; from: number; to: number }
  | { status: 'moved'; from: number; to: number }
  | { status: 'detached' };

/**
 * Re-locate `anchor` inside `text` (the current fountain at `currentRev`).
 *
 * - Same rev → offsets are authoritative (bounds-checked).
 * - Otherwise: exact-quote search, preferring the occurrence closest to the
 *   original offset; then a whitespace-insensitive search; then detached.
 */
export function relocateAnchor(
  anchor: AnchorSpan,
  text: string,
  currentRev: number,
): RelocatedAnchor {
  if (anchor.rev === currentRev) {
    if (anchor.from <= anchor.to && anchor.to <= text.length) {
      return { status: 'exact', from: anchor.from, to: anchor.to };
    }
    // Same rev but out of bounds — data is inconsistent; fall through to search.
  }

  const quote = anchor.quote;
  if (quote.length === 0) return { status: 'detached' };

  // Exact occurrences, pick the one nearest the remembered position.
  const occurrences: number[] = [];
  for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) {
    occurrences.push(i);
    if (occurrences.length > 50) break;
  }
  if (occurrences.length > 0) {
    const best = occurrences.reduce((a, b) =>
      Math.abs(a - anchor.from) <= Math.abs(b - anchor.from) ? a : b,
    );
    const status = anchor.rev === currentRev && best === anchor.from ? 'exact' : 'moved';
    return { status, from: best, to: best + quote.length };
  }

  // Whitespace-insensitive fallback: tolerate reflowed lines/spacing.
  const relaxed = fuzzyFind(text, quote, anchor.from);
  if (relaxed) return { status: 'moved', ...relaxed };

  return { status: 'detached' };
}

/**
 * Find `quote` in `text` treating any whitespace run as equivalent.
 * Returns real offsets into `text`, or null.
 */
function fuzzyFind(text: string, quote: string, near: number): { from: number; to: number } | null {
  const tokens = quote.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const pattern = tokens.map(escapeRe).join('\\s+');
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'g');
  } catch {
    return null;
  }
  let best: { from: number; to: number } | null = null;
  for (const m of text.matchAll(re)) {
    const cand = { from: m.index!, to: m.index! + m[0].length };
    if (!best || Math.abs(cand.from - near) < Math.abs(best.from - near)) best = cand;
  }
  return best;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
