/**
 * M-1 — prompt pre-screen.
 *
 * Deliberately NARROW. We hard-block exactly one category: prompts that solicit
 * child sexual abuse material (CSAM / CSAE). It is the one category that is
 * unambiguously illegal everywhere, that no legitimate creative prompt needs,
 * and where a hard block (not a soft flag) is the only acceptable posture.
 *
 * Everything else — general adult/NSFW, violence, gore, politics — is left to
 * the model's own guardrails and the provider `has_nsfw_contents` signal
 * (consumed in the worker). That is the product decision: moderate only the
 * severe, legally-mandatory case here, and let the models self-moderate the
 * rest rather than over-block legitimate work.
 *
 * Bilingual by requirement: the RU market means EN **and** RU terms must both be
 * covered — a Russian-language CSAE prompt has to be caught as surely as an
 * English one.
 *
 * This is a keyword + proximity heuristic, NOT a classifier: cheap, synchronous,
 * no new dependency and no cross-border processor (cf. infra register INF-6).
 * It is tuned to MINIMISE false positives (proximity-gated co-occurrence) at the
 * cost of trivially-evadable recall. A managed classifier is the real fix at
 * scale (backlog M-5); this is the no-VPS quick win that closes the worst gap.
 */

export type ModerationCategory = 'csae';

export interface ModerationResult {
  /** True → refuse the prompt outright. */
  blocked: boolean;
  /** Set when blocked. The only category today is child sexual exploitation. */
  category?: ModerationCategory;
}

/**
 * Standalone terms that are, by themselves, a request for sexualised minors.
 * These block regardless of context — they have no benign reading in a
 * generation prompt. EN + RU. Matched against the normalised prompt (lower-case,
 * diacritics stripped, punctuation collapsed to single spaces), so an
 * obfuscation like `child.porn` / `child_porn` reads as `child porn` here.
 */
const SEVERE_TERMS: readonly RegExp[] = [
  /\blolicon\b/,
  /\bshotacon\b/,
  /\bloli\b/,
  /\bshota\b/,
  /\bchild\s*porn/,
  /\bchildporn\b/,
  /\bcsam\b/,
  /\bchild\s*sexual\b/,
  /\bpedophil/,
  // RU
  /детск\w*\s*порно/,
  /детск\w*\s*порнограф/,
  /порно\s*с\s*детьми/,
  /педофил/,
];

/**
 * Minor indicators (EN + RU). Cyrillic stems are matched WITHOUT `\b` — in JS a
 * word boundary is ASCII-only and misbehaves around Cyrillic — so RU entries are
 * substrings chosen to be specific enough not to collide with common words.
 */
const MINOR_TERMS =
  /\b(child|children|kid|kids|toddler|infant|preteen|underage|schoolgirl|schoolboy|teen|teens|teenage|teenager|1[0-7]\s*yo|1[0-7]\s*year)\b|(ребен|детск|малолет|несовершеннолет|школьниц|школьник|подростк)/g;

/**
 * Sexual / explicit indicators (EN + RU). RU forms are spelled out rather than
 * stemmed to `гол` — that stem collides with голова/голос/голод/гол ("head /
 * voice / hunger / goal") and would generate false positives.
 */
const SEXUAL_TERMS =
  /\b(sex|sexy|sexual|porn|porno|nude|nudes|naked|topless|erotic|erotica|nsfw|xxx|fuck|fucking|blowjob|genital|genitalia|penis|vagina|undress|undressing)\b|(секс|порно|голая|голый|голые|голым|голую|обнаж|эроти|раздет|раздев|интим|изнасил)/g;

/**
 * Max character distance between a minor indicator and a sexual indicator for
 * them to count as the same (sexualised-minor) request. Generation prompts are
 * short, so a tight window catches "naked child" / "голый ребёнок" while letting
 * an unrelated co-mention ("children's book" … later … "sexy cover") pass.
 */
const PROXIMITY = 40;

function normalize(text: string): string {
  return (
    text
      .toLowerCase()
      // Fold the one Russian diacritic letter written both ways (ё↔е). NB: a
      // general NFKD combining-mark strip is the obvious move but it corrupts
      // Cyrillic — `й` (и+breve) flattens to `и`, so `голый`→`голыи` and stops
      // matching. ё→е is the only fold the RU terms actually need.
      .replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}]+/gu, ' ') // punctuation/whitespace → single space
      .trim()
  );
}

function matchIndices(text: string, re: RegExp): number[] {
  const out: number[] = [];
  // re carries the `g` flag; matchAll gives every (non-overlapping) hit.
  for (const m of text.matchAll(re)) {
    if (typeof m.index === 'number') out.push(m.index);
  }
  return out;
}

/**
 * Screen a generation prompt. Returns `{ blocked: true, category: 'csae' }`
 * only for the severe CSAE case described above; every other prompt passes.
 */
export function screenPrompt(prompt: string): ModerationResult {
  if (!prompt) return { blocked: false };
  const norm = normalize(prompt);

  for (const re of SEVERE_TERMS) {
    if (re.test(norm)) return { blocked: true, category: 'csae' };
  }

  const minors = matchIndices(norm, MINOR_TERMS);
  if (minors.length > 0) {
    const sexual = matchIndices(norm, SEXUAL_TERMS);
    for (const a of minors) {
      for (const b of sexual) {
        if (Math.abs(a - b) <= PROXIMITY) return { blocked: true, category: 'csae' };
      }
    }
  }

  return { blocked: false };
}
