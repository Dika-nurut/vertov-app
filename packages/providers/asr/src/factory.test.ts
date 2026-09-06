import { afterEach, describe, it, expect, vi } from 'vitest';
import { createAsrFactory } from './factory.js';
import { FasterWhisperProvider } from './faster-whisper.js';
import { GroqAsrProvider } from './groq.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createAsrFactory', () => {
  it('returns null when no provider is configured', () => {
    const factory = createAsrFactory({});
    expect(factory.forLanguage()).toBeNull();
    expect(factory.forLanguage('ru')).toBeNull();
  });

  it('returns FasterWhisperProvider when WHISPER_SERVER_URL is set', () => {
    const factory = createAsrFactory({ WHISPER_SERVER_URL: 'http://whisper:8000' });
    expect(factory.forLanguage()).toBeInstanceOf(FasterWhisperProvider);
    expect(factory.forLanguage('ru')).toBeInstanceOf(FasterWhisperProvider);
  });

  it('returns GroqAsrProvider when only GROQ_API_KEY is set', () => {
    const factory = createAsrFactory({ GROQ_API_KEY: 'gsk_test' });
    expect(factory.forLanguage()).toBeInstanceOf(GroqAsrProvider);
  });

  it('prefers whisper over groq by default when both are set', () => {
    const factory = createAsrFactory({
      WHISPER_SERVER_URL: 'http://whisper:8000',
      GROQ_API_KEY: 'gsk_test',
    });
    expect(factory.forLanguage()).toBeInstanceOf(FasterWhisperProvider);
  });

  it('ASR_PROVIDER=groq forces groq even when whisper is configured', () => {
    const factory = createAsrFactory({
      WHISPER_SERVER_URL: 'http://whisper:8000',
      GROQ_API_KEY: 'gsk_test',
      ASR_PROVIDER: 'groq',
    });
    expect(factory.forLanguage()).toBeInstanceOf(GroqAsrProvider);
  });

  it('per-language override routes uz to groq', () => {
    const factory = createAsrFactory({
      WHISPER_SERVER_URL: 'http://whisper:8000',
      GROQ_API_KEY: 'gsk_test',
      ASR_LANG_OVERRIDES: 'uz:groq',
    });
    expect(factory.forLanguage('uz')).toBeInstanceOf(GroqAsrProvider);
    expect(factory.forLanguage('ru')).toBeInstanceOf(FasterWhisperProvider);
    expect(factory.forLanguage('en')).toBeInstanceOf(FasterWhisperProvider);
  });

  it('uses the injected Groq API fetch without routing the source asset through it', async () => {
    const audioFetch = vi.fn(async () => new Response('audio-bytes', { status: 200 }));
    const groqFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ segments: [{ text: ' hello ', start: 0, end: 1.2 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', audioFetch);

    const factory = createAsrFactory({ GROQ_API_KEY: 'gsk_test' }, { groqFetch });
    const provider = factory.forLanguage();
    expect(provider).toBeInstanceOf(GroqAsrProvider);

    const segments = await provider!.transcribe('https://assets.vertov.test/a.mp4', 'ru');

    expect(audioFetch).toHaveBeenCalledOnce();
    expect(audioFetch).toHaveBeenCalledWith('https://assets.vertov.test/a.mp4');
    expect(groqFetch).toHaveBeenCalledOnce();
    const firstGroqCall = groqFetch.mock.calls[0] as unknown[] | undefined;
    expect(String(firstGroqCall?.[0])).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(segments).toEqual([{ text: 'hello', startSec: 0, endSec: 1.2 }]);
  });
});
