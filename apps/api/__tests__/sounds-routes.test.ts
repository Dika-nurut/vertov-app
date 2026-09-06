import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import type IORedis from 'ioredis';
import type { Client as MinioClient } from 'minio';
import { setupSoundsRoutes } from '../src/sounds';

/**
 * Audio catalog proxy (Pixabay music / Freesound SFX) for /studio.
 *
 * No real network, DB, or MinIO: global `fetch` is stubbed per-test, the
 * per-user rate limiter runs against an in-memory Redis stub (same shape as
 * the other route tests), and MinIO is injected via `opts.minio` so storage
 * writes never touch a live bucket.
 */

const FAKE_USER_ID = 'usr-sounds-test-001';
let currentIsAnonymous = false;

async function fakeRequireSession(
  _req: FastifyRequest,
  _reply: FastifyReply,
): Promise<{ user: { id: string; isAnonymous: boolean } } | null> {
  return { user: { id: FAKE_USER_ID, isAnonymous: currentIsAnonymous } };
}

/** In-memory eval (atomic INCR) Redis subset — same shape as other route tests. */
function makeRedisStub(): IORedis {
  const store = new Map<string, number>();
  return {
    async eval(_script: string, _numKeys: number, key: string) {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
  } as unknown as IORedis;
}

/** Single-chunk ReadableStream — mirrors real fetch's Response.body shape,
 * used by the download-step mocks so they exercise the streamed-read path. */
function bodyStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

/** MinIO stub: statObject rejects unless the key was "uploaded" via putObject. */
function makeMinioStub(): { minio: MinioClient; puts: Array<{ key: string; bytes: number }> } {
  const stored = new Set<string>();
  const puts: Array<{ key: string; bytes: number }> = [];
  const minio = {
    async statObject(_bucket: string, key: string) {
      if (!stored.has(key)) throw Object.assign(new Error('NotFound'), { code: 'NotFound' });
      return {};
    },
    async putObject(_bucket: string, key: string, buf: Buffer) {
      stored.add(key);
      puts.push({ key, bytes: buf.length });
      return {};
    },
  } as unknown as MinioClient;
  return { minio, puts };
}

let app: FastifyInstance;
let fetchMock: ReturnType<typeof vi.fn>;
let minioStub: ReturnType<typeof makeMinioStub>;

function buildApp() {
  minioStub = makeMinioStub();
  app = Fastify({ logger: false });
  setupSoundsRoutes(app, fakeRequireSession, { redis: makeRedisStub(), minio: minioStub.minio });
  return app.ready();
}

beforeEach(async () => {
  currentIsAnonymous = false;
  delete process.env.FREESOUND_API_KEY;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await buildApp();
});

afterEach(async () => {
  await app.close();
  vi.unstubAllGlobals();
  delete process.env.FREESOUND_API_KEY;
});

const freesoundSearchBody = {
  next: 'https://freesound.org/apiv2/search/text/?page=2',
  results: [
    {
      id: 12345,
      name: 'Rain on window',
      username: 'ambientdesigner',
      license: 'https://creativecommons.org/publicdomain/zero/1.0/',
      duration: 12.345,
      previews: {
        'preview-hq-mp3': 'https://freesound.org/data/previews/123/12345_hq.mp3',
        'preview-lq-mp3': 'https://freesound.org/data/previews/123/12345_lq.mp3',
      },
    },
  ],
};

const freesoundMusicSearchBody = {
  next: null,
  results: [
    {
      id: 67890,
      name: 'Lo-fi background loop',
      username: 'loopmaker',
      license: 'https://creativecommons.org/publicdomain/zero/1.0/',
      duration: 180,
      previews: {
        'preview-hq-mp3': 'https://freesound.org/data/previews/678/67890_hq.mp3',
        'preview-lq-mp3': 'https://freesound.org/data/previews/678/67890_lq.mp3',
      },
    },
  ],
};

describe('GET /v1/studio/sounds/search — schema', () => {
  it('rejects a bad kind (400 invalid_query)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/studio/sounds/search?kind=video' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_query' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing kind', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/studio/sounds/search' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /v1/studio/sounds/search — kind=music (Freesound)', () => {
  it('503s honestly when FREESOUND_API_KEY is unset (no fake results)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/studio/sounds/search?kind=music&q=lofi',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'catalog_unconfigured', provider: 'freesound' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes a canned Freesound response into { items, nextPage }', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => freesoundMusicSearchBody,
    } as Response);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/studio/sounds/search?kind=music&q=lofi&page=1',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          id: '67890',
          title: 'Lo-fi background loop',
          author: 'loopmaker',
          durSec: 180,
          previewUrl: 'https://freesound.org/data/previews/678/67890_hq.mp3',
          license: 'https://creativecommons.org/publicdomain/zero/1.0/',
          source: 'freesound',
        },
      ],
      nextPage: null,
    });
    // Same provider + token auth as sfx, but a music-oriented filter: longer
    // duration window and tag:music (vs. sfx's short one-shot window).
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://freesound.org/apiv2/search/text/?');
    expect(url).toContain('query=lofi');
    // URLSearchParams encodes spaces as "+", not "%20" — decode both.
    const decodedFilter = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decodedFilter).toContain('duration:[30 TO 600]');
    expect(decodedFilter).toContain('tag:music');
    expect((init.headers as Record<string, string>).Authorization).toBe('Token fake-token');
  });
});

describe('GET /v1/studio/sounds/search — kind=sfx (Freesound)', () => {
  it('503s honestly when FREESOUND_API_KEY is unset (no fake results)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/studio/sounds/search?kind=sfx' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'catalog_unconfigured', provider: 'freesound' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes a canned Freesound response into { items, nextPage }', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => freesoundSearchBody,
    } as Response);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/studio/sounds/search?kind=sfx&q=rain&page=1',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          id: '12345',
          title: 'Rain on window',
          author: 'ambientdesigner',
          durSec: 12.3,
          previewUrl: 'https://freesound.org/data/previews/123/12345_hq.mp3',
          license: 'https://creativecommons.org/publicdomain/zero/1.0/',
          source: 'freesound',
        },
      ],
      nextPage: 2,
    });
    // Query shape sent upstream: text-search endpoint, token auth, CC0-only
    // filter scoped to short one-shots (vs. music's longer duration window).
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('https://freesound.org/apiv2/search/text/?');
    expect(url).toContain('query=rain');
    // URLSearchParams encodes spaces as "+", not "%20" — decode both.
    const decodedFilter = decodeURIComponent(url.replace(/\+/g, ' '));
    expect(decodedFilter).toContain('duration:[0 TO 30]');
    expect(decodedFilter).not.toContain('tag:music');
    expect((init.headers as Record<string, string>).Authorization).toBe('Token fake-token');
    // SSRF layer 2: the outgoing request must NOT auto-follow redirects — a
    // freesound.org 302→private-IP would otherwise bypass the host allowlist.
    expect(init.redirect).toBe('manual');
    // The abort deadline must be armed on the request (it stays armed through the
    // body read so a slow-drip body can't hold the slot — see fetchWithDeadline).
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects a bad body via 502, not a fabricated list', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    const res = await app.inject({ method: 'GET', url: '/v1/studio/sounds/search?kind=sfx' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'catalog_search_failed' });
  });

  it('drops a result whose preview URL points at a non-freesound host', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        next: null,
        results: [
          {
            id: 1,
            name: 'Legit',
            username: 'a',
            license: 'https://creativecommons.org/publicdomain/zero/1.0/',
            duration: 5,
            previews: { 'preview-hq-mp3': 'https://freesound.org/data/previews/1/1_hq.mp3' },
          },
          {
            id: 2,
            name: 'Spoofed host',
            username: 'b',
            license: 'https://creativecommons.org/publicdomain/zero/1.0/',
            duration: 5,
            previews: { 'preview-hq-mp3': 'https://evil.example.com/steal.mp3' },
          },
        ],
      }),
    } as Response);
    const res = await app.inject({ method: 'GET', url: '/v1/studio/sounds/search?kind=sfx' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items: Array<{ id: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe('1');
  });

  it('is allowed for an anonymous («Гость») session — browsing is free', async () => {
    currentIsAnonymous = true;
    process.env.FREESOUND_API_KEY = 'fake-token';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ next: null, results: [] }),
    } as Response);
    const res = await app.inject({ method: 'GET', url: '/v1/studio/sounds/search?kind=sfx' });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('sets rate-limit headers on a successful search', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ next: null, results: [] }),
    } as Response);
    const res = await app.inject({ method: 'GET', url: '/v1/studio/sounds/search?kind=sfx' });
    expect(res.headers['x-ratelimit-limit']).toBe('30');
    expect(res.headers['x-ratelimit-remaining']).toBe('29');
  });
});

describe('POST /v1/studio/sounds/pick — schema', () => {
  it('rejects a bad kind (400 invalid_body)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'video', id: '123' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_body' });
  });

  it('rejects an id with characters outside [A-Za-z0-9_-]', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '../etc/passwd' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an id over 40 chars', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: 'a'.repeat(41) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/studio/sounds/pick — Guest-CJM', () => {
  it('blocks an anonymous session (403 signup_required), same wall as render', async () => {
    currentIsAnonymous = true;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '12345' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'signup_required' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /v1/studio/sounds/pick — kind=music (Freesound)', () => {
  it('503s honestly when FREESOUND_API_KEY is unset', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'music', id: '67890' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'catalog_unconfigured', provider: 'freesound' });
  });

  it('downloads the preview, uploads it, and returns normalized metadata (same path as sfx)', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    const musicDetailBody = {
      id: 67890,
      name: 'Lo-fi background loop',
      username: 'loopmaker',
      license: 'https://creativecommons.org/publicdomain/zero/1.0/',
      duration: 180,
      previews: {
        'preview-hq-mp3': 'https://freesound.org/data/previews/678/67890_hq.mp3',
      },
    };
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => musicDetailBody,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '4', 'content-type': 'audio/mpeg' }),
        body: bodyStream(new TextEncoder().encode('mp3!')),
      } as unknown as Response);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'music', id: '67890' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      url: expect.stringContaining(`${FAKE_USER_ID}/audio/catalog-music-67890.mp3`),
      name: 'Lo-fi background loop',
      durSec: 180,
      license: 'https://creativecommons.org/publicdomain/zero/1.0/',
      author: 'loopmaker',
      source: 'freesound',
    });
    expect(minioStub.puts).toEqual([
      { key: `${FAKE_USER_ID}/audio/catalog-music-67890.mp3`, bytes: 4 },
    ]);
  });
});

describe('POST /v1/studio/sounds/pick — kind=sfx (Freesound)', () => {
  const detailBody = {
    id: 12345,
    name: 'Rain on window',
    username: 'ambientdesigner',
    license: 'https://creativecommons.org/publicdomain/zero/1.0/',
    duration: 12.345,
    previews: {
      'preview-hq-mp3': 'https://freesound.org/data/previews/123/12345_hq.mp3',
    },
  };

  it('503s honestly when FREESOUND_API_KEY is unset', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '12345' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'catalog_unconfigured', provider: 'freesound' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads the preview, uploads it, and returns normalized metadata', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => detailBody } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '4', 'content-type': 'audio/mpeg' }),
        body: bodyStream(new TextEncoder().encode('mp3!')),
      } as unknown as Response);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '12345' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      url: expect.stringContaining(`${FAKE_USER_ID}/audio/catalog-sfx-12345.mp3`),
      name: 'Rain on window',
      durSec: 12.3,
      license: 'https://creativecommons.org/publicdomain/zero/1.0/',
      author: 'ambientdesigner',
      source: 'freesound',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(minioStub.puts).toEqual([
      { key: `${FAKE_USER_ID}/audio/catalog-sfx-12345.mp3`, bytes: 4 },
    ]);
  });

  it('rejects an HTML error page (no audio content-type, no MP3 signature) with 502 invalid_audio and no storage write', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => detailBody } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: bodyStream(new TextEncoder().encode('<html>error</html>')),
      } as unknown as Response);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '12345' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'invalid_audio' });
    expect(minioStub.puts.length).toBe(0);
  });

  it('rejects truncated/garbage bytes with no audio content-type or MP3 signature (502 invalid_audio, no write)', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => detailBody } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: bodyStream(new Uint8Array([0x00, 0x01, 0x02, 0x03])),
      } as unknown as Response);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '12345' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'invalid_audio' });
    expect(minioStub.puts.length).toBe(0);
  });

  it('accepts a valid ID3-tagged buffer with no content-type header (signature-only match)', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => detailBody } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: bodyStream(new TextEncoder().encode('ID3\x03\x00\x00')),
      } as unknown as Response);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '12345' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(minioStub.puts.length).toBe(1);
  });

  it('dedups: a second pick of the same id skips the download but still returns metadata', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => detailBody } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '4', 'content-type': 'audio/mpeg' }),
        body: bodyStream(new TextEncoder().encode('mp3!')),
      } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => detailBody } as Response);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '12345' },
    });
    expect(first.statusCode, first.body).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '12345' },
    });
    expect(second.statusCode, second.body).toBe(200);
    // Only 3 fetch calls total (detail+download, then detail again) — the
    // second pick's download is skipped.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(minioStub.puts.length).toBe(1);
  });

  it('rejects an oversized declared preview before downloading (413)', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => detailBody } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(20 * 1024 * 1024) }),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '12345' },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'preview_too_large' });
    expect(minioStub.puts.length).toBe(0);
  });

  it('rejects an oversized chunked body with no content-length (413)', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    // Two 8MB chunks (16MB total) exceed the 15MB cap; no content-length
    // header, so this can only be caught by the streamed running-count check.
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => detailBody } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: bodyStream(new Uint8Array(8 * 1024 * 1024), new Uint8Array(8 * 1024 * 1024)),
      } as unknown as Response);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '12345' },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'preview_too_large' });
    expect(minioStub.puts.length).toBe(0);
  });

  it('rejects a non-CC0 license (403 license_not_allowed)', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    const nonCc0Detail = { ...detailBody, license: 'https://creativecommons.org/licenses/by/4.0/' };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => nonCc0Detail,
    } as Response);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '12345' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'license_not_allowed' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // never proceeds to download
    expect(minioStub.puts.length).toBe(0);
  });

  it('rejects a detail whose previewUrl points at an external host (502 preview_rejected)', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    const evilDetail = {
      ...detailBody,
      previews: { 'preview-hq-mp3': 'https://evil.example.com/steal.mp3' },
    };
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => evilDetail,
    } as Response);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '12345' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: 'preview_rejected' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // never proceeds to download
    expect(minioStub.puts.length).toBe(0);
  });

  it('404s when Freesound has no such sound id', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 } as Response);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '99999999' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('sets rate-limit headers distinct from search (sounds-pick bucket)', async () => {
    process.env.FREESOUND_API_KEY = 'fake-token';
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => detailBody } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': '4', 'content-type': 'audio/mpeg' }),
        body: bodyStream(new TextEncoder().encode('mp3!')),
      } as unknown as Response);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/sounds/pick',
      payload: { kind: 'sfx', id: '12345' },
    });
    expect(res.headers['x-ratelimit-limit']).toBe('15');
    expect(res.headers['x-ratelimit-remaining']).toBe('14');
  });
});
