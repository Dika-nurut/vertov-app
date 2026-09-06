/**
 * Adapter for fedirz/faster-whisper-server (self-hosted).
 * Exposes an OpenAI-compatible POST /v1/audio/transcriptions endpoint.
 * Docker image: ghcr.io/fedirz/faster-whisper-server:latest-cpu
 */
import type { AsrProvider, AsrSegment } from './types.js';

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

interface WhisperSegment {
  text: string;
  start: number;
  end: number;
  words?: WhisperWord[];
}

interface WhisperVerboseResponse {
  segments?: WhisperSegment[];
  text?: string;
}

export class FasterWhisperProvider implements AsrProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly token: string | undefined;

  constructor(baseUrl: string, model = 'small', opts: { token?: string | undefined } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.token = opts.token;
  }

  async transcribe(audioUrl: string, language?: string): Promise<AsrSegment[]> {
    // Fetch audio from the URL and stream it as a multipart/form-data upload.
    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) {
      throw new Error(`asr_fetch_failed: ${audioResp.status}`);
    }
    const audioBlob = await audioResp.blob();

    const form = new FormData();
    form.append('file', audioBlob, 'audio.mp4');
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    // Also request word-level timings (powers word-pop captions). Servers without
    // word support simply omit `words` on each segment — we degrade gracefully.
    form.append('timestamp_granularities[]', 'word');
    if (language) form.append('language', language);

    const resp = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      // Self-host kit's optional bearer auth (ASR_SERVER_TOKEN) — omitted entirely
      // when unset so the request stays byte-identical for open servers.
      ...(this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : {}),
      body: form,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`whisper_server_error: ${resp.status} ${text}`);
    }

    const data = (await resp.json()) as WhisperVerboseResponse;
    if (!data.segments?.length) {
      // No speech detected — return empty (not an error).
      return [];
    }

    return data.segments.map((s) => {
      // The faster-whisper-server nests `words` inside each segment when word
      // granularity is available; pass them straight through, else leave absent.
      const words = (s.words ?? [])
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
