/** Caption-file import: sniffs SRT / VTT / ASS-SSA content and parses cues, plus
 * re-chunking of ASR segments into short caption cards (OpenCut defaults, MIT). */

export interface SubtitleCue {
  text: string;
  fromSec: number;
  toSec: number;
}

const MAX_CUE_CHARS = 200;

/** Tolerant `H:MM:SS[,.]mmm` / `M:SS[,.]mmm` parser shared by SRT and VTT cues. */
function srtTimeToSec(s: string): number {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s) ?? /(\d+):(\d+)[,.](\d+)/.exec(s);
  if (!m) return 0;
  return m.length === 5
    ? +m[1]! * 3600 + +m[2]! * 60 + +m[3]! + +m[4]! / 1000
    : +m[1]! * 60 + +m[2]! + +m[3]! / 1000;
}

/** Ported from the legacy `_model.parseSrt` — tolerant of comma or dot millis and
 * a leading WEBVTT header. */
function parseSrtOrVtt(raw: string): SubtitleCue[] {
  const out: SubtitleCue[] = [];
  for (const block of raw
    .replace(/\r/g, '')
    .trim()
    .split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti]!.split('-->');
    const text = lines
      .slice(ti + 1)
      .join(' ')
      .trim()
      .slice(0, MAX_CUE_CHARS);
    if (text) out.push({ text, fromSec: srtTimeToSec(a!), toSec: srtTimeToSec(b!) });
  }
  return out;
}

/** `H:MM:SS.cc` (centiseconds) parser for ASS/SSA `Dialogue:` timestamps. */
function assTimeToSec(s: string): number {
  const m = /(\d+):(\d+):(\d+)\.(\d+)/.exec(s.trim());
  if (!m) return 0;
  const frac = +m[4]! / 10 ** m[4]!.length;
  return +m[1]! * 3600 + +m[2]! * 60 + +m[3]! + frac;
}

const ASS_DEFAULT_FORMAT = [
  'Layer',
  'Start',
  'End',
  'Style',
  'Name',
  'MarginL',
  'MarginR',
  'MarginV',
  'Effect',
  'Text',
];

function stripAssText(raw: string): string {
  return raw
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/gi, ' ')
    .trim()
    .slice(0, MAX_CUE_CHARS);
}

/** Parses the `[Events]` section's `Dialogue:` lines. Reads the `Format:` line
 * for column order, falling back to the standard 10-field layout. */
function parseAss(raw: string): SubtitleCue[] {
  const lines = raw.replace(/\r/g, '').split('\n');
  const eventsStart = lines.findIndex((l) => /^\[Events\]/i.test(l.trim()));
  if (eventsStart < 0) return [];

  let format = ASS_DEFAULT_FORMAT;
  const out: SubtitleCue[] = [];
  for (let i = eventsStart + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\[/.test(line.trim())) break; // next section
    if (/^Format:/i.test(line.trim())) {
      format = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((f) => f.trim());
      continue;
    }
    if (!/^Dialogue:/i.test(line.trim())) continue;

    const startIdx = format.indexOf('Start');
    const endIdx = format.indexOf('End');
    const textIdx = format.indexOf('Text');
    if (startIdx < 0 || endIdx < 0 || textIdx < 0) continue;

    let parts = line
      .slice(line.indexOf(':') + 1)
      .trim()
      .split(',');
    if (textIdx === format.length - 1) {
      // Text is the last column, so any extra commas from the split can only
      // have come from inside the free-form text — safe to rejoin them.
      if (parts.length > format.length) {
        const head = parts.slice(0, format.length - 1);
        const tail = parts.slice(format.length - 1).join(',');
        parts = [...head, tail];
      }
    }
    // When Text isn't the last column there's no way to tell which extra
    // commas belong to it, so require an exact column-count match — commas
    // inside the text are unsupported for that layout.
    if (parts.length !== format.length) continue;

    const fromSec = assTimeToSec(parts[startIdx]!);
    const toSec = assTimeToSec(parts[endIdx]!);
    const text = stripAssText(parts[textIdx]!);
    if (text && toSec > fromSec) out.push({ text, fromSec, toSec });
  }
  return out;
}

/** Parses an SRT, VTT, or ASS/SSA subtitle file, sniffing the format from content.
 * Drops empty/invalid cues and returns cues sorted by start time. */
export function parseSubtitles(raw: string): SubtitleCue[] {
  const cues =
    /\[Events\]/i.test(raw) && /Dialogue:/i.test(raw) ? parseAss(raw) : parseSrtOrVtt(raw);
  return cues.filter((c) => c.text && c.toSec > c.fromSec).sort((a, b) => a.fromSec - b.fromSec);
}

/** An ASR segment carrying optional per-word timings (mirrors AsrSegment). */
export interface WordSegment {
  text: string;
  startSec: number;
  endSec: number;
  words?: { word: string; startSec: number; endSec: number }[];
}

export interface WordPopOptions {
  /** Where this clip starts on the assembled timeline. */
  timelineStartSec: number;
  /** Source-time trim of the clip the words came from. */
  sourceInSec: number;
  sourceOutSec: number;
  /** Clip playback speed (words compress/stretch with it). */
  speed: number;
  /** Minimum on-screen time per word; a shorter window is merged into the
   * previous word so a fast syllable doesn't flash. Default 0.15s. */
  minDurSec?: number;
}

/** Word-pop captions («по словам» / OpenReel renderWordByWord): one cue per spoken
 * WORD. Maps each word's SOURCE time into assembled-timeline time with the same
 * trim/speed transform captions use, clamps to the clip window, then merges any
 * sub-`minDurSec` window into the PREVIOUS word (a fast function word like «то»
 * rides along with its neighbour instead of flashing). No 12-cap — these ride the
 * dedicated popText render lane, capped at 400 downstream. */
export function wordsToPopCaptions(segments: WordSegment[], opts: WordPopOptions): SubtitleCue[] {
  const speed = Math.max(0.25, opts.speed || 1);
  const minDur = opts.minDurSec ?? 0.15;

  const cues: SubtitleCue[] = [];
  for (const seg of segments) {
    for (const w of seg.words ?? []) {
      const text = (w.word ?? '').trim();
      if (!text) continue;
      const srcStart = Math.max(opts.sourceInSec, w.startSec);
      const srcEnd = Math.min(opts.sourceOutSec, Math.max(w.endSec, w.startSec));
      if (srcEnd <= srcStart) continue;
      const fromSec = opts.timelineStartSec + (srcStart - opts.sourceInSec) / speed;
      const toSec = opts.timelineStartSec + (srcEnd - opts.sourceInSec) / speed;
      cues.push({
        text,
        fromSec: Math.max(0, Math.round(fromSec * 100) / 100),
        toSec: Math.round(toSec * 100) / 100,
      });
    }
  }

  // Fold a too-short window into the previous cue (extends its window + text).
  const merged: SubtitleCue[] = [];
  for (const c of cues) {
    const prev = merged[merged.length - 1];
    if (prev && c.toSec - c.fromSec < minDur) {
      prev.text = `${prev.text} ${c.text}`;
      prev.toSec = Math.max(prev.toSec, c.toSec);
    } else {
      merged.push({ ...c });
    }
  }
  // A lone leading word too short to display (no previous cue) is extended.
  const first = merged[0];
  if (merged.length === 1 && first && first.toSec - first.fromSec < minDur) {
    first.toSec = Math.round((first.fromSec + minDur) * 100) / 100;
  }
  // Clamp each window to the NEXT word's start so the lane never has two words
  // active at once. Pop is one-word-at-a-time: the preview shows the first match
  // (`.find`), the worker draws every word whose window contains t — so an
  // overlap (malformed/overlapping ASR word times) would render two stacked words
  // in export while the preview shows one. Non-overlapping windows keep them equal.
  for (let i = 0; i < merged.length - 1; i++) {
    const next = merged[i + 1]!;
    const cur = merged[i]!;
    if (next.fromSec > cur.fromSec && cur.toSec > next.fromSec) cur.toSec = next.fromSec;
  }
  return merged;
}

/** The render lane's hard limit on word-pop caption words (packages/db studio.ts /
 * apps/api studio schema). Merging must never silently exceed it. */
export const POP_WORD_CAP = 400;

/** Merge freshly-generated word-pop captions for ONE clip into the existing
 * project-level popText word list. Because the popText lane is a single
 * project-wide list (not per-clip), captioning a second clip must ADD to the list,
 * not replace it. Words whose start falls inside `replaceRange` — the re-captioned
 * clip's timeline window `[fromSec, toSec)` — are dropped first, so RE-running
 * captions on a clip you already captioned replaces just that clip's words and
 * leaves every OTHER clip's words untouched. The kept + new words are re-sorted by
 * start time.
 *
 * Cap policy: if the merged list would exceed `cap`, the LATEST words (by time) are
 * dropped so the earliest speech survives — matching the render lane's
 * keep-the-front truncation — and a `console.warn` reports the drop count. */
export function mergePopWords<T extends { fromSec: number; toSec: number }>(
  existing: T[],
  newWords: T[],
  replaceRange: { fromSec: number; toSec: number },
  cap = POP_WORD_CAP,
): T[] {
  const kept = existing.filter(
    (w) => w.fromSec < replaceRange.fromSec || w.fromSec >= replaceRange.toSec,
  );
  const merged = [...kept, ...newWords].sort((a, b) => a.fromSec - b.fromSec);
  if (merged.length > cap) {
    console.warn(
      `mergePopWords: ${merged.length} words exceed the ${cap}-word pop caption cap; dropped ${merged.length - cap} latest word(s)`,
    );
    return merged.slice(0, cap);
  }
  return merged;
}

export interface ChunkOptions {
  maxWords?: number;
  minDurSec?: number;
}

/** Re-chunks ASR/caption segments into short caption cards (OpenCut defaults:
 * 3 words per caption, min 0.8s). Splits each segment's text into word groups of
 * `maxWords`, distributes the segment's time span proportionally to word count,
 * then merges any chunk shorter than `minDurSec` into a neighbor — WITHIN the
 * same source segment only, so a short chunk never bridges the gap into a
 * different segment's timespan. A segment that produces a single chunk shorter
 * than `minDurSec` (no in-segment neighbor to merge with) gets extended instead,
 * clamped so it never overlaps the next segment's start. */
export function chunkCaptionSegments<T extends { text: string; fromSec: number; toSec: number }>(
  segments: T[],
  opts: ChunkOptions = {},
): T[] {
  const maxWords = opts.maxWords ?? 3;
  const minDurSec = opts.minDurSec ?? 0.8;

  const result: T[] = [];
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]!;
    const words = seg.text.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const groups: string[][] = [];
    for (let i = 0; i < words.length; i += maxWords) groups.push(words.slice(i, i + maxWords));

    const totalWords = words.length;
    const duration = seg.toSec - seg.fromSec;
    let offset = 0;
    const segChunks: T[] = [];
    for (const group of groups) {
      const frac = group.length / totalWords;
      const start = seg.fromSec + offset;
      offset += duration * frac;
      const end = seg.fromSec + offset;
      segChunks.push({ ...seg, text: group.join(' '), fromSec: start, toSec: end });
    }

    // Merge any chunk shorter than minDurSec into its in-segment neighbor
    // (forward when one exists, else backward).
    for (let i = 0; i < segChunks.length; ) {
      const dur = segChunks[i]!.toSec - segChunks[i]!.fromSec;
      if (dur >= minDurSec || segChunks.length < 2) {
        i++;
        continue;
      }
      if (i + 1 < segChunks.length) {
        const next = segChunks[i + 1]!;
        segChunks[i + 1] = {
          ...next,
          text: `${segChunks[i]!.text} ${next.text}`,
          fromSec: segChunks[i]!.fromSec,
        };
        segChunks.splice(i, 1);
      } else {
        const prev = segChunks[i - 1]!;
        segChunks[i - 1] = {
          ...prev,
          text: `${prev.text} ${segChunks[i]!.text}`,
          toSec: segChunks[i]!.toSec,
        };
        segChunks.splice(i, 1);
      }
    }

    // A lone chunk with no in-segment neighbor still bypasses the min-duration
    // invariant above — extend it forward instead, capped at the next
    // segment's own start so it never spans the gap between segments.
    if (segChunks.length === 1) {
      const only = segChunks[0]!;
      const dur = only.toSec - only.fromSec;
      if (dur < minDurSec) {
        const nextStart = segments[s + 1]?.fromSec;
        const cap =
          nextStart !== undefined
            ? Math.min(only.fromSec + minDurSec, nextStart)
            : only.fromSec + minDurSec;
        segChunks[0] = { ...only, toSec: Math.max(only.toSec, cap) };
      }
    }

    result.push(...segChunks);
  }
  return result;
}
