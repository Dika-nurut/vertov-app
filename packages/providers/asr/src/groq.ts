/**
 * Groq Whisper Large V3 Turbo adapter.
 * Uses Groq's OpenAI-compatible transcription endpoint.
 * ~$0.04/hr — cheapest hosted ASR covering en/ru/uz.
 * Requires GROQ_API_KEY (foreign-card payment — use as fallback only).
 */
import type { AsrProvider, AsrSegment } from './types.js';

const GROQ_API = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';

interface GroqSegment {
  text: string;
  start: number;
  end: number;
}

interface GroqWord {
  word: string;
  start: number;
  end: number;
}

interface GroqVerboseResponse {
  segments?: GroqSegment[];
  // With `timestamp_granularities[]=word`, the OpenAI-compatible API returns a
  // FLAT `words` array spanning the whole transcript (not nested per-segment).
  words?: GroqWord[];
}

export class GroqAsrProvider implements AsrProvider {
  private readonly apiFetch: typeof fetch;

  constructor(
    private readonly apiKey: string,
    opts: { apiFetch?: typeof fetch } = {},
  ) {
    this.apiFetch = opts.apiFetch ?? fetch;
  }

  async transcribe(audioUrl: string, language?: string): Promise<AsrSegment[]> {
    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) throw new Error(`asr_fetch_failed: ${audioResp.status}`);
    const audioBlob = await audioResp.blob();

    const form = new FormData();
    form.append('file', audioBlob, 'audio.mp4');
    form.append('model', GROQ_MODEL);
    form.append('response_format', 'verbose_json');
    // Ask for word-level timings alongside segments — powers word-pop captions.
    // Harmless when unused; segments still come back the same shape.
    form.append('timestamp_granularities[]', 'segment');
    form.append('timestamp_granularities[]', 'word');
    if (language) form.append('language', language);

    const resp = await this.apiFetch(GROQ_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`groq_asr_error: ${resp.status} ${text}`);
    }

    const data = (await resp.json()) as GroqVerboseResponse;
    const allWords = data.words ?? [];
    const segments = data.segments ?? [];
    // Bucket the flat word list into segments with a single forward pointer so
    // each word is consumed exactly once — a boundary word (start ≈ prior
    // segment's end ≈ next segment's start) previously matched both segments'
    // independent filters and got duplicated. Half-open [start, end) per
    // segment; the last segment sweeps up any trailing words past its end.
    let wordIdx = 0;
    return segments.map((s, i) => {
      const isLast = i === segments.length - 1;
      const bucket: GroqWord[] = [];
      while (wordIdx < allWords.length) {
        const w = allWords[wordIdx]!;
        if (!isLast && w.start >= s.end - 1e-3) break;
        bucket.push(w);
        wordIdx++;
      }
      const words = bucket
        .map((w) => ({ word: w.word.trim(), startSec: w.start, endSec: w.end }))
        .filter((w) => w.word.length > 0);
      return {
        text: s.text.trim(),
        startSec: s.start,
        endSec: s.end,
        ...(words.length ? { words } : {}),
      };
    });
  }
}
