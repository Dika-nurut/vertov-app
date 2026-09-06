import { describe, it, expect } from 'vitest';
import { groupWordsIntoSegments, type RawAsrWord } from './group';

// transformers.js whisper word output: chunks are single words with a LEADING
// space, e.g. " And", " so". groupWordsIntoSegments turns that flat stream into
// sentence-ish segments for line captions while keeping the per-word timings.
const w = (word: string, startSec: number, endSec: number | null): RawAsrWord => ({
  word,
  startSec,
  endSec,
});

describe('groupWordsIntoSegments', () => {
  it('keeps a continuous, gap-free, punctuation-free run as one segment', () => {
    const segs = groupWordsIntoSegments([
      w(' привет', 0, 0.4),
      w(' как', 0.4, 0.7),
      w(' дела', 0.7, 1.1),
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe('привет как дела');
    expect(segs[0]!.startSec).toBe(0);
    expect(segs[0]!.endSec).toBe(1.1);
    expect(segs[0]!.words).toHaveLength(3);
  });

  it('splits into a new segment at a sentence-ending word', () => {
    const segs = groupWordsIntoSegments([
      w(' Привет', 0, 0.4),
      w(' мир.', 0.4, 0.8),
      w(' Как', 0.85, 1.1),
      w(' дела', 1.1, 1.4),
    ]);
    expect(segs.map((s) => s.text)).toEqual(['Привет мир.', 'Как дела']);
  });

  it('splits on a silent gap larger than maxGapSec', () => {
    const segs = groupWordsIntoSegments([
      w(' один', 0, 0.4),
      w(' два', 0.4, 0.8),
      // 1.2s of silence before "три" > 0.8s default gap.
      w(' три', 2.0, 2.4),
    ]);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.text).toBe('один два');
    expect(segs[1]!.text).toBe('три');
  });

  it('honours a custom maxGapSec', () => {
    const words = [w(' a', 0, 0.3), w(' b', 0.9, 1.2)]; // 0.6s gap
    expect(groupWordsIntoSegments(words, { maxGapSec: 0.5 })).toHaveLength(2);
    expect(groupWordsIntoSegments(words, { maxGapSec: 1.0 })).toHaveLength(1);
  });

  it('coerces a null word-end to the next word start', () => {
    const segs = groupWordsIntoSegments([w(' hi', 0, null), w(' there', 0.5, 0.9)]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.words![0]!.endSec).toBe(0.5);
    expect(segs[0]!.words![1]!.endSec).toBe(0.9);
  });

  it('pads a trailing null word-end when there is no next word', () => {
    const segs = groupWordsIntoSegments([w(' end', 1.0, null)]);
    expect(segs[0]!.words![0]!.endSec).toBeCloseTo(1.2, 5);
    expect(segs[0]!.endSec).toBeCloseTo(1.2, 5);
  });

  it('drops empty/whitespace-only words', () => {
    const segs = groupWordsIntoSegments([
      w(' real', 0, 0.4),
      w('   ', 0.4, 0.5),
      w(' word', 0.5, 0.9),
    ]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe('real word');
    expect(segs[0]!.words).toHaveLength(2);
  });

  it('returns [] for empty input', () => {
    expect(groupWordsIntoSegments([])).toEqual([]);
  });

  it('preserves per-word timings for pop mode after grouping', () => {
    const segs = groupWordsIntoSegments([w(' раз.', 0, 0.5), w(' два', 0.6, 1.0)]);
    const allWords = segs.flatMap((s) => s.words ?? []);
    expect(allWords).toEqual([
      { word: 'раз.', startSec: 0, endSec: 0.5 },
      { word: 'два', startSec: 0.6, endSec: 1.0 },
    ]);
  });
});
