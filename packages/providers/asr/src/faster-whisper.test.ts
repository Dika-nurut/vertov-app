import { afterEach, describe, it, expect, vi } from 'vitest';
import { FasterWhisperProvider } from './faster-whisper.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/audio/transcriptions')) {
      return new Response(JSON.stringify({ segments: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('audio-bytes', { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('FasterWhisperProvider auth header', () => {
  it('sends Authorization: Bearer <token> when ASR_SERVER_TOKEN is configured', async () => {
    const fetchMock = stubFetch();
    const provider = new FasterWhisperProvider('http://whisper:8000', 'small', {
      token: 'secret-token',
    });

    await provider.transcribe('https://assets.vertov.test/a.mp4');

    const transcribeCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/v1/audio/transcriptions'),
    );
    expect(transcribeCall).toBeDefined();
    const [, init] = transcribeCall!;
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('Authorization')).toBe('Bearer secret-token');
  });

  it('sends no Authorization header when no token is configured', async () => {
    const fetchMock = stubFetch();
    const provider = new FasterWhisperProvider('http://whisper:8000', 'small');

    await provider.transcribe('https://assets.vertov.test/a.mp4');

    const transcribeCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/v1/audio/transcriptions'),
    );
    expect(transcribeCall).toBeDefined();
    const [, init] = transcribeCall!;
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get('Authorization')).toBeNull();
  });
});
