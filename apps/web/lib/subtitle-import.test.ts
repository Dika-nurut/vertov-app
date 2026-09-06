import { describe, expect, it, vi } from 'vitest';
import {
  parseSubtitles,
  chunkCaptionSegments,
  wordsToPopCaptions,
  mergePopWords,
} from './subtitle-import';

describe('parseSubtitles', () => {
  it('parses basic SRT with comma millis', () => {
    const srt = `1\n00:00:01,000 --> 00:00:03,500\nHello there\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond line`;
    const cues = parseSubtitles(srt);
    expect(cues).toEqual([
      { text: 'Hello there', fromSec: 1, toSec: 3.5 },
      { text: 'Second line', fromSec: 4, toSec: 6 },
    ]);
  });

  it('parses SRT with dot millis', () => {
    const srt = `1\n00:00:01.250 --> 00:00:02.750\nDot millis`;
    const cues = parseSubtitles(srt);
    expect(cues).toEqual([{ text: 'Dot millis', fromSec: 1.25, toSec: 2.75 }]);
  });

  it('parses VTT with a WEBVTT header', () => {
    const vtt = `WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nHi from VTT`;
    const cues = parseSubtitles(vtt);
    expect(cues).toEqual([{ text: 'Hi from VTT', fromSec: 0.5, toSec: 2 }]);
  });

  it('caps cue text at 200 chars', () => {
    const long = 'x'.repeat(300);
    const srt = `1\n00:00:00,000 --> 00:00:01,000\n${long}`;
    const cues = parseSubtitles(srt);
    expect(cues[0]!.text.length).toBe(200);
  });

  it('parses ASS with a reordered Format line, stripping override tags and \\N', () => {
    const ass = [
      '[Script Info]',
      'ScriptType: v4.00+',
      '',
      '[Events]',
      'Format: Layer, End, Start, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:04.00,0:00:01.00,Default,,0,0,0,,{\\i1}Hello{\\i0}\\Nworld',
    ].join('\n');
    const cues = parseSubtitles(ass);
    expect(cues).toEqual([{ text: 'Hello world', fromSec: 1, toSec: 4 }]);
  });

  it('parses ASS with the default 10-field layout when no Format line is present', () => {
    const ass = [
      '[Events]',
      'Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,Plain text here',
    ].join('\n');
    const cues = parseSubtitles(ass);
    expect(cues).toEqual([{ text: 'Plain text here', fromSec: 1.5, toSec: 3 }]);
  });

  it('parses ASS where Text is not the last Format column (no comma-in-text support)', () => {
    const ass = [
      '[Events]',
      'Format: Layer, Start, End, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Mid-position text',
    ].join('\n');
    const cues = parseSubtitles(ass);
    expect(cues).toEqual([{ text: 'Mid-position text', fromSec: 1, toSec: 2 }]);
  });

  it('sorts cues by start time and drops empty/invalid ones', () => {
    const srt = `1\n00:00:05,000 --> 00:00:06,000\nSecond\n\n2\n00:00:01,000 --> 00:00:02,000\nFirst\n\n3\n00:00:07,000 --> 00:00:07,000\n\n`;
    const cues = parseSubtitles(srt);
    expect(cues.map((c) => c.text)).toEqual(['First', 'Second']);
  });
});

describe('chunkCaptionSegments', () => {
  it('splits a 7-word 3.5s segment into 3 chunks of <=3 words with proportional times', () => {
    const segs = [{ text: 'one two three four five six seven', fromSec: 0, toSec: 3.5 }];
    const chunks = chunkCaptionSegments(segs, { maxWords: 3, minDurSec: 0.4 });
    expect(chunks.map((c) => c.text)).toEqual(['one two three', 'four five six', 'seven']);
    expect(chunks.every((c) => c.text.split(' ').length <= 3)).toBe(true);
    expect(chunks[0]).toEqual({ text: 'one two three', fromSec: 0, toSec: 1.5 });
    expect(chunks[1]).toEqual({ text: 'four five six', fromSec: 1.5, toSec: 3 });
    expect(chunks[2]).toEqual({ text: 'seven', fromSec: 3, toSec: 3.5 });
  });

  it('merges a too-short chunk into its neighbor (default minDurSec 0.8)', () => {
    const segs = [{ text: 'one two three four five six seven', fromSec: 0, toSec: 3.5 }];
    const chunks = chunkCaptionSegments(segs, { maxWords: 3 });
    // last group ('seven') is 0.5s < 0.8s -> merges backward into the previous chunk
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toEqual({ text: 'four five six seven', fromSec: 1.5, toSec: 3.5 });
    expect(chunks.every((c) => c.toSec - c.fromSec >= 0.5)).toBe(true);
  });

  it('never overlaps the next segment start when merging', () => {
    const segs = [
      { text: 'short', fromSec: 0, toSec: 0.3 },
      { text: 'next segment words here', fromSec: 1, toSec: 2.6 },
    ];
    const chunks = chunkCaptionSegments(segs, { maxWords: 3, minDurSec: 0.8 });
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i]!.toSec).toBeLessThanOrEqual(chunks[i + 1]!.fromSec);
    }
  });

  it('never merges a short chunk across a gap into a distant segment (stays within its own bounds)', () => {
    const segs = [
      { text: 'short cue', fromSec: 1, toSec: 1.4 }, // 0.4s, below default minDurSec
      { text: 'far away words here', fromSec: 10, toSec: 11.6 },
    ];
    const chunks = chunkCaptionSegments(segs, { maxWords: 3 });
    expect(chunks).toHaveLength(2);
    // the short cue must not absorb text from — or extend into — the far segment
    expect(chunks[0]!.text).toBe('short cue');
    expect(chunks[0]!.fromSec).toBe(1);
    expect(chunks[0]!.toSec).toBeLessThan(10);
    expect(chunks[1]!.text).toBe('far away words here');
  });

  it('extends a lone short chunk to minDurSec, clamped to not overlap the next segment', () => {
    const alone = chunkCaptionSegments([{ text: 'hi', fromSec: 2, toSec: 2.2 }], {
      maxWords: 3,
      minDurSec: 0.8,
    });
    expect(alone).toEqual([{ text: 'hi', fromSec: 2, toSec: 2.8 }]);

    const clamped = chunkCaptionSegments(
      [
        { text: 'hi', fromSec: 2, toSec: 2.2 },
        { text: 'next', fromSec: 2.5, toSec: 3 },
      ],
      { maxWords: 3, minDurSec: 0.8 },
    );
    expect(clamped[0]).toEqual({ text: 'hi', fromSec: 2, toSec: 2.5 });
  });
});

describe('wordsToPopCaptions', () => {
  const identity = { timelineStartSec: 0, sourceInSec: 0, sourceOutSec: 100, speed: 1 };

  it('emits one cue per spoken word from the segments word list', () => {
    const pops = wordsToPopCaptions(
      [
        {
          text: 'привет мир',
          startSec: 0,
          endSec: 1,
          words: [
            { word: 'привет', startSec: 0, endSec: 0.5 },
            { word: 'мир', startSec: 0.5, endSec: 1 },
          ],
        },
      ],
      identity,
    );
    expect(pops).toEqual([
      { text: 'привет', fromSec: 0, toSec: 0.5 },
      { text: 'мир', fromSec: 0.5, toSec: 1 },
    ]);
  });

  it('clamps overlapping word windows so the pop lane never shows two at once', () => {
    // Malformed/overlapping ASR word times: «раз» runs long into «два».
    const pops = wordsToPopCaptions(
      [
        {
          text: 'раз два',
          startSec: 0,
          endSec: 2,
          words: [
            { word: 'раз', startSec: 0, endSec: 1.5 },
            { word: 'два', startSec: 1.0, endSec: 2.0 },
          ],
        },
      ],
      identity,
    );
    // «раз».toSec is clamped down to «два».fromSec (1.0) — no overlap, so a given
    // playhead lands in exactly one window (preview `.find` == worker per-word draw).
    expect(pops).toEqual([
      { text: 'раз', fromSec: 0, toSec: 1.0 },
      { text: 'два', fromSec: 1.0, toSec: 2.0 },
    ]);
  });

  it('maps word source time into timeline time with clip start, trim and speed', () => {
    // Clip starts at 10s on the timeline, trimmed from 4s of source, played 2×.
    const pops = wordsToPopCaptions(
      [
        {
          text: 'one two',
          startSec: 4,
          endSec: 8,
          words: [
            { word: 'one', startSec: 4, endSec: 6 },
            { word: 'two', startSec: 6, endSec: 8 },
          ],
        },
      ],
      { timelineStartSec: 10, sourceInSec: 4, sourceOutSec: 20, speed: 2 },
    );
    // (srcStart - inSec)/speed + timelineStart → word 1: 10..11, word 2: 11..12.
    expect(pops).toEqual([
      { text: 'one', fromSec: 10, toSec: 11 },
      { text: 'two', fromSec: 11, toSec: 12 },
    ]);
  });

  it('merges a sub-minDur word into the previous word (text + window)', () => {
    const pops = wordsToPopCaptions(
      [
        {
          text: 'a то b',
          startSec: 0,
          endSec: 1,
          words: [
            { word: 'держи', startSec: 0, endSec: 0.5 },
            { word: 'то', startSec: 0.5, endSec: 0.55 }, // 0.05s < 0.15s min
            { word: 'крепче', startSec: 0.55, endSec: 1 },
          ],
        },
      ],
      identity,
    );
    expect(pops).toEqual([
      { text: 'держи то', fromSec: 0, toSec: 0.55 },
      { text: 'крепче', fromSec: 0.55, toSec: 1 },
    ]);
  });

  it('extends a lone leading word that is too short to display', () => {
    const pops = wordsToPopCaptions(
      [
        {
          text: 'да',
          startSec: 0,
          endSec: 0.05,
          words: [{ word: 'да', startSec: 0, endSec: 0.05 }],
        },
      ],
      identity,
    );
    expect(pops).toEqual([{ text: 'да', fromSec: 0, toSec: 0.15 }]);
  });

  it('drops words outside the clip trim window', () => {
    const pops = wordsToPopCaptions(
      [
        {
          text: 'in out',
          startSec: 0,
          endSec: 10,
          words: [
            { word: 'keep', startSec: 5, endSec: 6 },
            { word: 'drop', startSec: 20, endSec: 21 }, // past sourceOutSec
          ],
        },
      ],
      { timelineStartSec: 0, sourceInSec: 0, sourceOutSec: 8, speed: 1 },
    );
    expect(pops).toEqual([{ text: 'keep', fromSec: 5, toSec: 6 }]);
  });

  it('returns nothing when segments carry no word timings (graceful)', () => {
    expect(
      wordsToPopCaptions([{ text: 'no words here', startSec: 0, endSec: 2 }], identity),
    ).toEqual([]);
  });
});

describe('mergePopWords', () => {
  const clipA = [
    { text: 'a1', fromSec: 0, toSec: 0.5 },
    { text: 'a2', fromSec: 0.5, toSec: 1 },
  ];
  // Clip B lives later on the timeline (starts at 5s).
  const clipB = [
    { text: 'b1', fromSec: 5, toSec: 5.5 },
    { text: 'b2', fromSec: 5.5, toSec: 6 },
  ];

  it('captioning a second, non-overlapping clip keeps BOTH clips words', () => {
    // clip A already captioned; now caption clip B whose window is [5, 6).
    const merged = mergePopWords(clipA, clipB, { fromSec: 5, toSec: 6 });
    expect(merged).toEqual([
      { text: 'a1', fromSec: 0, toSec: 0.5 },
      { text: 'a2', fromSec: 0.5, toSec: 1 },
      { text: 'b1', fromSec: 5, toSec: 5.5 },
      { text: 'b2', fromSec: 5.5, toSec: 6 },
    ]);
  });

  it('re-captioning the SAME clip replaces only that clips words, leaving others', () => {
    const existing = [...clipA, ...clipB];
    // Re-run captions on clip A (window [0, 1)) with a different transcript.
    const reA = [
      { text: 'a1-new', fromSec: 0, toSec: 0.4 },
      { text: 'a2-new', fromSec: 0.4, toSec: 0.9 },
    ];
    const merged = mergePopWords(existing, reA, { fromSec: 0, toSec: 1 });
    expect(merged).toEqual([
      { text: 'a1-new', fromSec: 0, toSec: 0.4 },
      { text: 'a2-new', fromSec: 0.4, toSec: 0.9 },
      { text: 'b1', fromSec: 5, toSec: 5.5 },
      { text: 'b2', fromSec: 5.5, toSec: 6 },
    ]);
  });

  it('uses a half-open [from, to) range so a neighbour word at the boundary survives', () => {
    // A next-clip word starting exactly at the target clip's end must be kept.
    const existing = [{ text: 'boundary', fromSec: 1, toSec: 1.5 }];
    const merged = mergePopWords(existing, [{ text: 'new', fromSec: 0, toSec: 0.5 }], {
      fromSec: 0,
      toSec: 1,
    });
    expect(merged).toEqual([
      { text: 'new', fromSec: 0, toSec: 0.5 },
      { text: 'boundary', fromSec: 1, toSec: 1.5 },
    ]);
  });

  it('re-sorts the merged list by start time', () => {
    // New clip words land BEFORE the existing ones on the timeline.
    const existing = [{ text: 'late', fromSec: 9, toSec: 9.5 }];
    const merged = mergePopWords(existing, [{ text: 'early', fromSec: 1, toSec: 1.5 }], {
      fromSec: 1,
      toSec: 2,
    });
    expect(merged.map((w) => w.text)).toEqual(['early', 'late']);
  });

  it('caps the merged list at 400, dropping the LATEST words and warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 399 existing words at t = 0..3.99, then a fresh clip of 5 words far later.
    const existing = Array.from({ length: 399 }, (_, i) => ({
      text: `w${i}`,
      fromSec: i * 0.01,
      toSec: i * 0.01 + 0.005,
    }));
    const newWords = Array.from({ length: 5 }, (_, i) => ({
      text: `n${i}`,
      fromSec: 100 + i,
      toSec: 100 + i + 0.5,
    }));
    const merged = mergePopWords(existing, newWords, { fromSec: 100, toSec: 110 });
    expect(merged).toHaveLength(400);
    // Earliest speech survives; the last (latest-in-time) words are dropped.
    expect(merged[399]!.text).toBe('n0');
    expect(merged.some((w) => w.text === 'n4')).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      'mergePopWords: 404 words exceed the 400-word pop caption cap; dropped 4 latest word(s)',
    );
    warn.mockRestore();
  });

  it('respects a custom cap argument', () => {
    const existing = [
      { text: 'a', fromSec: 0, toSec: 1 },
      { text: 'b', fromSec: 1, toSec: 2 },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const merged = mergePopWords(
      existing,
      [{ text: 'c', fromSec: 2, toSec: 3 }],
      {
        fromSec: 2,
        toSec: 3,
      },
      2,
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((w) => w.text)).toEqual(['a', 'b']);
    warn.mockRestore();
  });
});
