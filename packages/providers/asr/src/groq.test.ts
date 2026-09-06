import { afterEach, describe, it, expect, vi } from 'vitest';
import { GroqAsrProvider } from './groq.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GroqAsrProvider word bucketing', () => {
  it('assigns a boundary word to exactly one segment', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('audio-bytes', { status: 200 })),
    );
    const apiFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            segments: [
              { text: 'first segment', start: 0, end: 1.0 },
              { text: 'second segment', start: 1.0, end: 2.0 },
            ],
            // Word starting exactly at the segment boundary (1.0) — must land
            // in exactly one of the two segments, not both.
            words: [
              { word: 'first', start: 0, end: 0.4 },
              { word: 'segment', start: 0.4, end: 1.0 },
              { word: 'second', start: 1.0, end: 1.5 },
              { word: 'part', start: 1.5, end: 2.0 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const provider = new GroqAsrProvider('gsk_test', { apiFetch });
    const segments = await provider.transcribe('https://assets.vertov.test/a.mp4');

    const allWords = segments.flatMap((s) => s.words ?? []);
    const boundaryOccurrences = allWords.filter((w) => w.word === 'segment').length;
    expect(boundaryOccurrences).toBe(1);
    expect(allWords.map((w) => w.word)).toEqual(['first', 'segment', 'second', 'part']);
  });
});
