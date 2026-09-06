import type { WordSegment } from '../subtitle-import';

/** One raw word from transformers.js ASR word-timestamps output. With
 * `return_timestamps: 'word'` each `output.chunks[i]` is a single word shaped
 * `{ text, timestamp: [start, end] }`; whisper leaves `end` null when it cannot
 * close the final word, so we model it as nullable and coerce it here. */
export interface RawAsrWord {
  word: string;
  startSec: number;
  endSec: number | null;
}

export interface GroupOptions {
  /** Start a new segment when the silent gap before a word exceeds this. */
  maxGapSec?: number;
}

/** A word that ends a sentence closes its segment. Tolerates a trailing quote /
 * bracket after the punctuation («…мир».). */
const SENTENCE_END = /[.!?…]["»)\]]?$/;

/** Group flat per-word ASR output into sentence-ish segments for LINE captions.
 * Splits at sentence-ending punctuation or a silent gap > `maxGapSec` (default
 * 0.8s), and coerces a null/invalid word-end to the next word's start (or +0.2s
 * when there is no next word). Pure — no DOM/worker deps, unit-tested in
 * group.test.ts. Word-pop mode reads `seg.words`, so this grouping only shapes
 * the LINE-mode display; the per-word timings survive untouched either way. */
export function groupWordsIntoSegments(
  words: RawAsrWord[],
  opts: GroupOptions = {},
): WordSegment[] {
  const maxGap = opts.maxGapSec ?? 0.8;

  // 1. Clean: trim, drop empties, coerce a missing/invalid end.
  const clean: { word: string; startSec: number; endSec: number }[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    const text = (w.word ?? '').trim();
    if (!text) continue;
    const startSec = Number.isFinite(w.startSec)
      ? w.startSec
      : (clean[clean.length - 1]?.endSec ?? 0);
    let endSec = w.endSec;
    if (endSec == null || !Number.isFinite(endSec) || endSec <= startSec) {
      const next = words[i + 1];
      endSec =
        next && Number.isFinite(next.startSec) && next.startSec > startSec
          ? next.startSec
          : startSec + 0.2;
    }
    clean.push({ word: text, startSec, endSec });
  }
  const first = clean[0];
  if (!first) return [];

  // 2. Group into segments, breaking at gaps and sentence boundaries.
  const segments: WordSegment[] = [];
  let cur: WordSegment | null = null;
  let prevEnd = first.startSec;
  for (const w of clean) {
    const gap = w.startSec - prevEnd;
    if (!cur || gap > maxGap) {
      cur = { text: w.word, startSec: w.startSec, endSec: w.endSec, words: [w] };
      segments.push(cur);
    } else {
      cur.text = `${cur.text} ${w.word}`;
      cur.endSec = w.endSec;
      cur.words!.push(w);
    }
    prevEnd = w.endSec;
    // A sentence-ending word forces the next word into a fresh segment.
    if (SENTENCE_END.test(w.word)) cur = null;
  }
  return segments;
}
