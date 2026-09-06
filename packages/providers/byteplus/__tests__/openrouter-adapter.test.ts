import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { billableVideoUnits, byteplusRouteContracts } from '@seed/shared';
import {
  OpenRouterAdapter,
  OpenRouterClient,
  StubBytePlusAdapter,
  buildOpenRouterImageBody,
  buildOpenRouterVideoBody,
  getAdapter,
  openRouterImageSlug,
  openRouterVideoSlug,
  type WorkflowSpec,
} from '../src/index';

const BASE = 'https://mock.openrouter.test';
let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
});

function makeAdapter() {
  return new OpenRouterAdapter(
    new OpenRouterClient({ baseUrl: `${BASE}/api/v1`, apiKey: 'sk-or-test' }),
    { pollBackoffMs: [5] },
  );
}

function videoSpec(
  providerModelId: string,
  params: Record<string, unknown>,
  referenceAssets: string[] = [],
  extra: Partial<WorkflowSpec> = {},
): WorkflowSpec {
  return {
    modelId: 'seedance-2-0',
    providerModelId,
    providerEndpoint: '/api/v3/videos/generations',
    kind: 'video',
    prompt: 'a whale breaching at dawn',
    params,
    referenceAssets,
    maxDurationSeconds: 15,
    ...extra,
  };
}

function imageSpec(params: Record<string, unknown>): WorkflowSpec {
  return {
    modelId: 'seedream-4-5',
    providerModelId: 'doubao-seedream-4.5',
    providerEndpoint: '/api/v3/images/generations',
    kind: 'image',
    prompt: 'a cat',
    params,
    referenceAssets: [],
    maxDurationSeconds: null,
  };
}

describe('gateway registry — openrouter', () => {
  it('requires the explicit live opt-in even when the key exists', () => {
    expect(getAdapter('openrouter', { OPENROUTER_API_KEY: 'sk-x' })).toBeInstanceOf(
      StubBytePlusAdapter,
    );
    expect(getAdapter('openrouter', { OPENROUTER_MODE: 'live' })).toBeInstanceOf(
      StubBytePlusAdapter,
    );
    expect(
      getAdapter('openrouter', { OPENROUTER_MODE: 'live', OPENROUTER_API_KEY: 'sk-x' }),
    ).toBeInstanceOf(OpenRouterAdapter);
  });
});

describe('slug mapping', () => {
  it('maps catalog provider ids (with mode suffixes) to OpenRouter slugs', () => {
    expect(openRouterVideoSlug('seedance-2.0-fast-text-to-video')).toBe(
      'bytedance/seedance-2.0-fast',
    );
    expect(openRouterVideoSlug('seedance-2.0-image-to-video')).toBe('bytedance/seedance-2.0');
    expect(openRouterVideoSlug('seedance-2-0-fast')).toBe('bytedance/seedance-2.0-fast');
    expect(openRouterVideoSlug('seedance-1-5-pro')).toBe('bytedance/seedance-1-5-pro');
    // Catalog reference-to-video rows (previz): suffix strips to the family slug.
    expect(openRouterVideoSlug('seedance-2.0-reference-to-video')).toBe('bytedance/seedance-2.0');
    expect(openRouterVideoSlug('seedance-2.0-fast-reference-to-video')).toBe(
      'bytedance/seedance-2.0-fast',
    );
    expect(openRouterImageSlug('doubao-seedream-4.5')).toBe('bytedance-seed/seedream-4.5');
  });

  it('throws non-retryable MODEL_UNAVAILABLE for unmapped models', () => {
    expect(() => openRouterVideoSlug('seedance-1-0-lite')).toThrowError(/no OpenRouter slug/);
    expect(() => openRouterImageSlug('flux-dev')).toThrowError(/no OpenRouter slug/);
  });

  it('de-hardcoded: slug-shaped providerModelId is used verbatim (S1/S2)', () => {
    // New OpenRouter catalog rows store the 'vendor/model' slug directly.
    expect(openRouterVideoSlug('google/veo-3.1-fast')).toBe('google/veo-3.1-fast');
    expect(openRouterVideoSlug('openai/sora-2-pro')).toBe('openai/sora-2-pro');
    expect(openRouterVideoSlug('kwaivgi/kling-v3.0-std')).toBe('kwaivgi/kling-v3.0-std');
    expect(openRouterImageSlug('black-forest-labs/flux.2-pro')).toBe(
      'black-forest-labs/flux.2-pro',
    );
    expect(openRouterImageSlug('google/gemini-2.5-flash-image')).toBe(
      'google/gemini-2.5-flash-image',
    );
  });
});

describe('buildOpenRouterVideoBody — capability-driven (non-Seedance engines)', () => {
  it('Veo 3.1 Fast: snaps duration to supported [4,6,8], keeps its 2 aspect ratios', () => {
    const body = buildOpenRouterVideoBody(
      videoSpec(
        'google/veo-3.1-fast',
        { duration_seconds: 7, resolution: '1080p', aspect_ratio: '9:16' },
        [],
        {
          // veo has NO OpenRouter route contract in the registry (kie-only), so this
          // exercises the legacy capability-driven path. modelId is set to a value
          // WITHOUT an OR contract so the registry override does not apply.
          modelId: 'veo-3-1-fast',
          maxDurationSeconds: 8,
          capabilities: {
            audio: true,
            frames: ['first', 'last'],
            durations: [4, 6, 8],
            resolutions: ['720p', '1080p'],
            aspect_ratios: ['16:9', '9:16'],
          },
        },
      ),
    );
    expect(body).toMatchObject({
      model: 'google/veo-3.1-fast',
      duration: 6, // 7 snaps down to the largest supported ≤ 7
      resolution: '1080p',
      aspect_ratio: '9:16',
      generate_audio: true,
    });
  });

  it('Veo: a disallowed aspect ratio is dropped (model infers it)', () => {
    const body = buildOpenRouterVideoBody(
      videoSpec('google/veo-3.1-fast', { aspect_ratio: '21:9', duration_seconds: 4 }, [], {
        modelId: 'veo-3-1-fast', // no OR contract → legacy capability path
        maxDurationSeconds: 8,
        capabilities: { durations: [4, 6, 8], aspect_ratios: ['16:9', '9:16'] },
      }),
    );
    expect(body['aspect_ratio']).toBeUndefined();
  });

  it('Sora 2 Pro: t2v-only (frames:[]) drops frame_images even with refs, honors 20s', () => {
    const body = buildOpenRouterVideoBody(
      videoSpec(
        'openai/sora-2-pro',
        {
          duration_seconds: 20,
          resolution: '1080p',
          imageUrls: ['https://a.test/first.jpg'],
        },
        [],
        {
          modelId: 'sora-2-pro', // not in the registry → legacy capability path
          maxDurationSeconds: 20,
          capabilities: {
            audio: true,
            frames: [],
            durations: [4, 8, 12, 16, 20],
            resolutions: ['720p', '1080p'],
          },
        },
      ),
    );
    expect(body['model']).toBe('openai/sora-2-pro');
    expect(body['duration']).toBe(20);
    expect(body['frame_images']).toBeUndefined();
  });

  it('a resolution outside the model schema falls back to an allowed tier', () => {
    const body = buildOpenRouterVideoBody(
      videoSpec('kwaivgi/kling-v3.0-std', { resolution: '1080p', duration_seconds: 5 }, [], {
        modelId: 'kling-v3-0-std', // not in the registry → legacy capability path
        maxDurationSeconds: 10,
        capabilities: { audio: true, durations: [5, 10], resolutions: ['720p'] },
      }),
    );
    expect(body['resolution']).toBe('720p'); // Kling std is 720p-only
    expect(body['duration']).toBe(5);
  });
});

describe('buildOpenRouterVideoBody', () => {
  it('t2v: clamps duration, strips SR resolutions, defaults audio on', () => {
    const body = buildOpenRouterVideoBody(
      videoSpec('seedance-2.0-fast-text-to-video', {
        duration_seconds: 30,
        resolution: '720p-SR',
        aspect_ratio: '9:16',
        seed: 42,
      }),
    );
    expect(body).toMatchObject({
      model: 'bytedance/seedance-2.0-fast',
      duration: 15,
      resolution: '720p',
      aspect_ratio: '9:16',
      generate_audio: true,
      seed: 42,
    });
    expect(body['frame_images']).toBeUndefined();
  });

  it("omits aspect_ratio for 'adaptive' and duration for -1 (model decides)", () => {
    const body = buildOpenRouterVideoBody(
      videoSpec('seedance-2.0-text-to-video', {
        duration_seconds: -1,
        aspect_ratio: 'adaptive',
      }),
    );
    expect(body['aspect_ratio']).toBeUndefined();
    expect(body['duration']).toBeUndefined();
  });

  it('i2v: imageUrls become typed frame_images (first/last)', () => {
    const body = buildOpenRouterVideoBody(
      videoSpec('seedance-2.0-text-to-video', {
        duration_seconds: 5,
        imageUrls: ['https://a.test/first.jpg', 'https://a.test/last.jpg', 'https://a.test/x.jpg'],
      }),
    );
    expect(body['frame_images']).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'https://a.test/first.jpg' },
        frame_type: 'first_frame',
      },
      {
        type: 'image_url',
        image_url: { url: 'https://a.test/last.jpg' },
        frame_type: 'last_frame',
      },
    ]);
  });

  it('preserves an explicit sparse last frame instead of relabeling it first', () => {
    const body = buildOpenRouterVideoBody(
      videoSpec('seedance-2.0-text-to-video', {
        duration_seconds: 5,
        frameImages: [{ role: 'last', url: 'https://a.test/last.jpg' }],
      }),
    );
    expect(body['frame_images']).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'https://a.test/last.jpg' },
        frame_type: 'last_frame',
      },
    ]);
  });

  it('reference models take input_references instead of frame_images', () => {
    const body = buildOpenRouterVideoBody(
      videoSpec('seedance-2.0-reference-to-video', {
        imageUrls: ['https://a.test/ref1.jpg', 'https://a.test/ref2.jpg'],
      }),
    );
    expect(body['input_references']).toEqual([
      { type: 'image_url', image_url: { url: 'https://a.test/ref1.jpg' } },
      { type: 'image_url', image_url: { url: 'https://a.test/ref2.jpg' } },
    ]);
    expect(body['frame_images']).toBeUndefined();
  });

  it('reference-to-video sends typed image / video / audio input_references', () => {
    // OpenRouter's input_references is a discriminated union (image_url |
    // video_url | audio_url); each attachment reaches the provider tagged by
    // type. Video/audio are honored only by providers that support them.
    const body = buildOpenRouterVideoBody(
      videoSpec('seedance-2.0-fast-reference-to-video', {
        imageUrls: ['https://a.test/cast.jpg'],
        videoUrls: ['https://a.test/motion.mp4'],
        audioUrls: ['https://a.test/voice.mp3'],
      }),
    );
    expect(body['model']).toBe('bytedance/seedance-2.0-fast');
    expect(body['input_references']).toEqual([
      { type: 'image_url', image_url: { url: 'https://a.test/cast.jpg' } },
      { type: 'video_url', video_url: { url: 'https://a.test/motion.mp4' } },
      { type: 'audio_url', audio_url: { url: 'https://a.test/voice.mp3' } },
    ]);
  });

  it('caps input_references at 9 stills', () => {
    const refs = Array.from({ length: 12 }, (_, i) => `https://a.test/r${i}.jpg`);
    const body = buildOpenRouterVideoBody(
      videoSpec('seedance-2.0-reference-to-video', { imageUrls: refs }),
    );
    expect(body['input_references']).toHaveLength(9);
  });
});

describe('buildOpenRouterVideoBody — registry-derived (covered models)', () => {
  const orContract = (modelId: string) =>
    byteplusRouteContracts[modelId]!.find((c) => c.gateway === 'openrouter')!;

  it('derives the scalar surface from the registry, not the legacy catalog defaults', () => {
    // Seedance Fast has no 1080p in the registry. With NO capabilities bag the legacy
    // path would keep 1080p (OR defaults include it — the real bug); the registry
    // override forces the fast route's 720p ceiling.
    const body = buildOpenRouterVideoBody(
      videoSpec('bytedance/seedance-2.0-fast', { resolution: '1080p', duration_seconds: 6 }, [], {
        modelId: 'seedance-2-0-fast',
      }),
    );
    expect(body['resolution']).toBe('720p');
  });

  it('serialized duration == the billing selector (both derive from the normalizer)', () => {
    // 7.4s: the serializer sends ceil→8, and the billing SELECTOR (billableVideoUnits)
    // returns the same 8 — because both call normalizeVideoParams on the same contract.
    // The legacy Math.round path would have serialized 7 while billing charged 8; this
    // closes that skew. (Production pricing is switched to this selector in a later step;
    // here we prove the two derivations agree.)
    const params = { duration_seconds: 7.4 };
    const body = buildOpenRouterVideoBody(
      videoSpec('seedance-2.0-text-to-video', params, [], { modelId: 'seedance-2-0' }),
    );
    const billed = billableVideoUnits(orContract('seedance-2-0'), params);
    expect(billed.ok && billed.units).toBe(8);
    expect(body['duration']).toBe(8);
  });

  it('preserves the -1 "model decides duration" sentinel through the registry path', () => {
    const body = buildOpenRouterVideoBody(
      videoSpec('seedance-2.0-text-to-video', { duration_seconds: -1 }, [], {
        modelId: 'seedance-2-0',
      }),
    );
    expect(body['duration']).toBeUndefined();
  });
});

describe('video flow', () => {
  it('submit → poll → download with auth → assets + provider cost meta', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/api/v1/videos', method: 'POST' })
      .reply(202, { id: 'vid_1', status: 'pending' });
    pool
      .intercept({ path: '/api/v1/videos/vid_1', method: 'GET' })
      .reply(200, { id: 'vid_1', status: 'in_progress' });
    pool.intercept({ path: '/api/v1/videos/vid_1', method: 'GET' }).reply(200, {
      id: 'vid_1',
      status: 'completed',
      unsigned_urls: [`${BASE}/api/v1/videos/vid_1/content?index=0`],
      usage: { cost: 0.27 },
    });
    pool
      .intercept({
        path: '/api/v1/videos/vid_1/content?index=0',
        method: 'GET',
        headers: { authorization: 'Bearer sk-or-test' },
      })
      .reply(200, Buffer.from([9, 9, 9]), { headers: { 'content-type': 'video/mp4' } });

    const adapter = makeAdapter();
    const spec = videoSpec('seedance-2.0-fast-text-to-video', { duration_seconds: 5 });
    const handle = await adapter.generate(spec);
    expect(handle.providerJobId).toBe('vid_1');
    const result = await adapter.awaitResult(handle, spec);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.extension).toBe('mp4');
    // One job, one bill — a video's usage.cost is the whole invoice by
    // construction, unlike the image path's N-call fan-out.
    expect(result.meta).toEqual({ providerCostUsd: 0.27, providerCostComplete: true });
  });

  it('failed status throws a non-retryable ProviderError with the upstream message', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/api/v1/videos', method: 'POST' })
      .reply(202, { id: 'vid_f', status: 'pending' });
    pool.intercept({ path: '/api/v1/videos/vid_f', method: 'GET' }).reply(200, {
      id: 'vid_f',
      status: 'failed',
      error: { code: 'MODERATION', message: 'content blocked' },
    });

    const adapter = makeAdapter();
    const spec = videoSpec('seedance-2.0-text-to-video', { duration_seconds: 5 });
    const handle = await adapter.generate(spec);
    await expect(adapter.awaitResult(handle, spec)).rejects.toMatchObject({
      code: 'MODERATION',
      retryable: false,
      message: 'content blocked',
    });
  });

  it('202 with an embedded error object surfaces the upstream message, non-retryable', async () => {
    // The real failure shape S0 observed: keep-alive 202, no id, error inside.
    agent
      .get(BASE)
      .intercept({ path: '/api/v1/videos', method: 'POST' })
      .reply(202, {
        error: { message: 'HTTP 400: image_url: timeout while fetching resource', code: 400 },
      });
    const adapter = makeAdapter();
    await expect(
      adapter.generate(videoSpec('seedance-2.0-reference-to-video', {})),
    ).rejects.toMatchObject({
      code: 'SUBMIT_REJECTED',
      retryable: false,
      message: expect.stringContaining('timeout while fetching resource'),
    });
  });

  it('429 on submit is retryable', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/api/v1/videos', method: 'POST' })
      .reply(429, 'rate limited');
    const adapter = makeAdapter();
    await expect(
      adapter.generate(videoSpec('seedance-2.0-text-to-video', {})),
    ).rejects.toMatchObject({ code: 'HTTP_429', retryable: true });
  });
});

describe('image flow (dedicated /images API)', () => {
  it('maps normalized controls and references to the dedicated request body', () => {
    expect(
      buildOpenRouterImageBody(
        imageSpec({
          aspect_ratio: '9:16',
          resolution: '4K',
          n: 3,
          imageUrls: ['https://a.test/ref.jpg'],
        }),
      ),
    ).toEqual({
      model: 'bytedance-seed/seedream-4.5',
      prompt: 'a cat',
      n: 1,
      aspect_ratio: '9:16',
      resolution: '4K',
      input_references: [{ type: 'image_url', image_url: { url: 'https://a.test/ref.jpg' } }],
    });
  });

  it('n=2 fans out to two one-output calls; base64 decodes to inline assets', async () => {
    const png = Buffer.from([137, 80, 78, 71]);
    const reply = {
      data: [{ b64_json: png.toString('base64'), media_type: 'image/png' }],
      usage: { cost: 0.04 },
    };
    const pool = agent.get(BASE);
    pool.intercept({ path: '/api/v1/images', method: 'POST' }).reply(200, reply);
    pool.intercept({ path: '/api/v1/images', method: 'POST' }).reply(200, reply);

    const adapter = makeAdapter();
    const spec = imageSpec({ n: 2 });
    const handle = await adapter.generate(spec);
    expect(handle.inlineResult).toBeDefined();
    const result = await adapter.awaitResult(handle, spec);
    expect(result.assets).toHaveLength(2);
    expect(result.assets[0]!.contentType).toBe('image/png');
    expect(result.assets[0]!.bytes.equals(png)).toBe(true);
    expect(result.meta).toEqual({ providerCostUsd: 0.08, providerCostComplete: true });
  });

  it('says so when only some of the fan-out reported a cost', async () => {
    // `usage.cost` is the only invoice we ever get, and the official leg's loss
    // budget replaces a whole reservation with it. Summing a missing cost as 0
    // makes a 1-of-4 subtotal indistinguishable from a complete bill, so a
    // four-image job settles at one image's price. The sum stays visible for
    // diagnosis; what changes is that it no longer CLAIMS to be the whole bill.
    const png = Buffer.from([137, 80, 78, 71]);
    const body = { b64_json: png.toString('base64'), media_type: 'image/png' };
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/api/v1/images', method: 'POST' })
      .reply(200, { data: [body], usage: { cost: 0.04 } });
    pool.intercept({ path: '/api/v1/images', method: 'POST' }).reply(200, { data: [body] });

    const adapter = makeAdapter();
    const spec = imageSpec({ n: 2 });
    const result = await adapter.awaitResult(await adapter.generate(spec), spec);
    expect(result.meta).toEqual({ providerCostUsd: 0.04, providerCostComplete: false });
  });

  it('reference images and controls travel as dedicated fields', async () => {
    let captured: Record<string, unknown> | null = null;
    agent
      .get(BASE)
      .intercept({ path: '/api/v1/images', method: 'POST' })
      .reply(200, (req) => {
        captured = JSON.parse(req.body as string) as Record<string, unknown>;
        return {
          data: [{ b64_json: 'AA==', media_type: 'image/png' }],
        };
      });

    const adapter = makeAdapter();
    await adapter.generate(
      imageSpec({
        n: 1,
        aspect_ratio: '16:9',
        resolution: '2K',
        imageUrls: ['https://a.test/ref.jpg'],
      }),
    );
    expect(captured).not.toBeNull();
    expect(captured!['input_references']).toEqual([
      { type: 'image_url', image_url: { url: 'https://a.test/ref.jpg' } },
    ]);
    expect(captured!['aspect_ratio']).toBe('16:9');
    expect(captured!['resolution']).toBe('2K');
    expect(captured!['n']).toBe(1);
    expect(captured!['model']).toBe('bytedance-seed/seedream-4.5');
  });

  it('empty image response throws retryable NO_ASSET', async () => {
    agent.get(BASE).intercept({ path: '/api/v1/images', method: 'POST' }).reply(200, { data: [] });
    const adapter = makeAdapter();
    await expect(adapter.generate(imageSpec({ n: 1 }))).rejects.toMatchObject({
      code: 'NO_ASSET',
      retryable: true,
    });
  });

  it('fails the batch when one of the billed image calls returns no asset', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/api/v1/images', method: 'POST' })
      .reply(200, { data: [{ b64_json: 'AA==', media_type: 'image/png' }] });
    pool.intercept({ path: '/api/v1/images', method: 'POST' }).reply(200, { data: [] });
    await expect(makeAdapter().generate(imageSpec({ n: 2 }))).rejects.toMatchObject({
      code: 'NO_ASSET',
      retryable: true,
    });
  });
});

describe('reference caps come from the registry, not a literal', () => {
  function imageSpec(modelId: string, providerModelId: string, images: string[]) {
    return {
      modelId,
      providerModelId,
      providerEndpoint: '',
      kind: 'image' as const,
      prompt: 'p',
      params: { imageUrls: images },
      referenceAssets: [],
    };
  }

  it('caps recraft-v4 at the ONE reference its vendor schema allows', () => {
    // The adapter used to slice every image model at 14 while the contract — and
    // OpenRouter's own `recraft__recraft-v4.json` — cap `input_references` at 1.
    const body = buildOpenRouterImageBody(
      imageSpec('recraft-v4', 'recraft/recraft-v4', ['a.png', 'b.png', 'c.png']) as never,
      1,
    );
    expect((body['input_references'] as unknown[]).length).toBe(1);
  });

  it('still allows flux-2-pro its contracted eight', () => {
    const body = buildOpenRouterImageBody(
      imageSpec(
        'flux-2-pro',
        'black-forest-labs/flux.2-pro',
        Array.from({ length: 12 }, (_, i) => `${i}.png`),
      ) as never,
      1,
    );
    expect((body['input_references'] as unknown[]).length).toBe(8);
  });
})
