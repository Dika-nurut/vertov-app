import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import {
  AtlasCloudAdapter,
  AtlasCloudClient,
  buildAtlasRequest,
  imageSizeToPixels,
  type WorkflowSpec,
} from '../src/index';

function imageSpec(params: Record<string, unknown>, referenceAssets: string[] = []): WorkflowSpec {
  return {
    modelId: 'seedream-4-5',
    providerModelId: 'doubao-seedream-4.5',
    providerEndpoint: '/api/v3/images/generations',
    kind: 'image',
    prompt: 'a cat',
    params,
    referenceAssets,
    maxDurationSeconds: null,
  };
}

function videoSpec(
  providerModelId: string,
  params: Record<string, unknown>,
  referenceAssets: string[] = [],
): WorkflowSpec {
  return {
    modelId: 'seedance-2-0',
    providerModelId,
    providerEndpoint: '/api/v3/videos/generations',
    kind: 'video',
    prompt: 'a whale',
    params,
    referenceAssets,
    maxDurationSeconds: 15,
  };
}

describe('imageSizeToPixels (ratio → AtlasCloud pixel enum)', () => {
  it('snaps known ratios to the nearest enum entry', () => {
    expect(imageSizeToPixels('1:1')).toBe('2048*2048');
    expect(imageSizeToPixels('16:9')).toBe('2848*1600');
    expect(imageSizeToPixels('9:16')).toBe('1600*2848');
    expect(imageSizeToPixels('3:4')).toBe('1728*2304');
    expect(imageSizeToPixels('21:9')).toBe('3136*1344');
  });
  it('accepts pixel strings (x or *) and snaps by aspect', () => {
    expect(imageSizeToPixels('1024x1024')).toBe('2048*2048');
    expect(imageSizeToPixels('1920x1080')).toBe('2848*1600');
  });
  it('falls back to square for garbage', () => {
    expect(imageSizeToPixels('nonsense')).toBe('2048*2048');
  });

  it('selects the 4K enum ladder when the canonical resolution requests 4K', () => {
    expect(imageSizeToPixels('16:9', '4K')).toBe('5504*3040');
  });
});

describe('buildAtlasRequest — image (seedream v4.5 routing)', () => {
  it('maps canonical Board aspect and resolution to the provider pixel enum', () => {
    const { body } = buildAtlasRequest(imageSpec({ aspect_ratio: '16:9', resolution: '4K', n: 1 }));
    expect(body['size']).toBe('5504*3040');
  });

  it('single image → base model, pixel size, no max_images/images', () => {
    const { path, body } = buildAtlasRequest(imageSpec({ size: '1:1', n: 1 }));
    expect(path).toBe('/model/generateImage');
    expect(body['model']).toBe('bytedance/seedream-v4.5');
    expect(body['size']).toBe('2048*2048');
    expect(body['max_images']).toBeUndefined();
    expect(body['images']).toBeUndefined();
  });

  it('n>1 → sequential with max_images == n (charge==delivery)', () => {
    const { body } = buildAtlasRequest(imageSpec({ size: '1:1', n: 4 }));
    expect(body['model']).toBe('bytedance/seedream-v4.5/sequential');
    expect(body['max_images']).toBe(4);
  });

  it('references → edit variant with images[]', () => {
    const { body } = buildAtlasRequest(
      imageSpec({ size: '3:4', n: 1, imageUrls: ['https://x/a.png'] }),
    );
    expect(body['model']).toBe('bytedance/seedream-v4.5/edit');
    expect(body['images']).toEqual(['https://x/a.png']);
  });

  it('references + n>1 → edit-sequential with both images and max_images', () => {
    const { body } = buildAtlasRequest(
      imageSpec({ size: '1:1', n: 2, imageUrls: ['https://x/a.png'] }),
    );
    expect(body['model']).toBe('bytedance/seedream-v4.5/edit-sequential');
    expect(body['images']).toEqual(['https://x/a.png']);
    expect(body['max_images']).toBe(2);
  });

  it('falls back to referenceAssets (image urls) when imageUrls param absent', () => {
    const { body } = buildAtlasRequest(imageSpec({ size: '1:1', n: 1 }, ['https://x/ref.jpg']));
    expect(body['model']).toBe('bytedance/seedream-v4.5/edit');
    expect(body['images']).toEqual(['https://x/ref.jpg']);
  });
});

describe('buildAtlasRequest — video (seedance 2.0 family, field renames)', () => {
  it('text-to-video → ratio field (not aspect_ratio), clamped duration', () => {
    const { path, body } = buildAtlasRequest(
      videoSpec('seedance-2.0-text-to-video', {
        duration_seconds: 8,
        resolution: '1080p',
        aspect_ratio: '9:16',
        generate_audio: true,
      }),
    );
    expect(path).toBe('/model/generateVideo');
    expect(body['model']).toBe('bytedance/seedance-2.0/text-to-video');
    expect(body['ratio']).toBe('9:16');
    expect(body).not.toHaveProperty('aspect_ratio');
    expect(body['duration']).toBe(8);
    expect(body['resolution']).toBe('1080p');
    expect(body['generate_audio']).toBe(true);
  });

  it('duration sent == billed window: -1 stays auto, oversize clamps to 15', () => {
    expect(
      buildAtlasRequest(videoSpec('seedance-2.0-text-to-video', { duration_seconds: -1 })).body[
        'duration'
      ],
    ).toBe(-1);
    expect(
      buildAtlasRequest(videoSpec('seedance-2.0-text-to-video', { duration_seconds: 99 })).body[
        'duration'
      ],
    ).toBe(15);
  });

  it('fast variant maps to -fast model and downgrades plain 1080p → 720p', () => {
    const { body } = buildAtlasRequest(
      videoSpec('seedance-2.0-fast-text-to-video', {
        duration_seconds: 5,
        resolution: '1080p',
      }),
    );
    expect(body['model']).toBe('bytedance/seedance-2.0-fast/text-to-video');
    expect(body['resolution']).toBe('720p');
  });

  it('image-to-video → image + last_image (not arrays)', () => {
    const { body } = buildAtlasRequest(
      videoSpec('seedance-2.0-image-to-video', {
        duration_seconds: 5,
        imageUrls: ['https://x/first.png', 'https://x/last.png'],
      }),
    );
    expect(body['model']).toBe('bytedance/seedance-2.0/image-to-video');
    expect(body['image']).toBe('https://x/first.png');
    expect(body['last_image']).toBe('https://x/last.png');
  });

  it('preserves a sparse typed last frame as last_image', () => {
    const { body } = buildAtlasRequest(
      videoSpec('seedance-2.0-image-to-video', {
        duration_seconds: 5,
        frameImages: [{ role: 'last', url: 'https://x/last.png' }],
      }),
    );
    expect(body['model']).toBe('bytedance/seedance-2.0/image-to-video');
    expect(body['image']).toBeUndefined();
    expect(body['last_image']).toBe('https://x/last.png');
  });

  it('reference-to-video → reference_images/videos/audios arrays', () => {
    const { body } = buildAtlasRequest(
      videoSpec('seedance-2.0-reference-to-video', {
        duration_seconds: 6,
        imageUrls: ['https://x/i.png'],
        videoUrls: ['https://x/v.mp4'],
        audioUrls: ['https://x/a.mp3'],
      }),
    );
    expect(body['model']).toBe('bytedance/seedance-2.0/reference-to-video');
    expect(body['reference_images']).toEqual(['https://x/i.png']);
    expect(body['reference_videos']).toEqual(['https://x/v.mp4']);
    expect(body['reference_audios']).toEqual(['https://x/a.mp3']);
  });

  it('fast reference-to-video maps to the -fast namespaced model', () => {
    const { body } = buildAtlasRequest(
      videoSpec('seedance-2.0-fast-reference-to-video', {
        duration_seconds: 4,
        imageUrls: ['https://x/cast.png'],
      }),
    );
    expect(body['model']).toBe('bytedance/seedance-2.0-fast/reference-to-video');
    expect(body['reference_images']).toEqual(['https://x/cast.png']);
  });

  it('reference arrays cap at 9 images / 3 videos / 3 audios', () => {
    const { body } = buildAtlasRequest(
      videoSpec('seedance-2.0-reference-to-video', {
        duration_seconds: 5,
        imageUrls: Array.from({ length: 12 }, (_, i) => `https://x/i${i}.png`),
        videoUrls: Array.from({ length: 5 }, (_, i) => `https://x/v${i}.mp4`),
        audioUrls: Array.from({ length: 4 }, (_, i) => `https://x/a${i}.mp3`),
      }),
    );
    expect(body['reference_images']).toHaveLength(9);
    expect(body['reference_videos']).toHaveLength(3);
    expect(body['reference_audios']).toHaveLength(3);
  });

  it('forwards watermark + return_last_frame only when set', () => {
    const off = buildAtlasRequest(
      videoSpec('seedance-2.0-text-to-video', { duration_seconds: 5 }),
    ).body;
    expect(off).not.toHaveProperty('watermark');
    expect(off).not.toHaveProperty('return_last_frame');
    const on = buildAtlasRequest(
      videoSpec('seedance-2.0-text-to-video', {
        duration_seconds: 5,
        watermark: true,
        return_last_frame: true,
      }),
    ).body;
    expect(on['watermark']).toBe(true);
    expect(on['return_last_frame']).toBe(true);
  });

  it('never forwards web_search (no AtlasCloud equivalent)', () => {
    const { body } = buildAtlasRequest(
      videoSpec('seedance-2.0-text-to-video', { duration_seconds: 5, webSearch: true }),
    );
    expect(body).not.toHaveProperty('web_search');
    expect(body).not.toHaveProperty('webSearch');
  });
});

describe('buildAtlasRequest — Gemini Omni Flash (distinct family, not Seedance)', () => {
  it('text-to-video (no images) → text-to-video-developer, no images field', () => {
    const { path, body } = buildAtlasRequest(
      videoSpec('gemini-omni-flash-text-to-video', { duration_seconds: 8, resolution: '1080p' }),
    );
    expect(path).toBe('/model/generateVideo');
    expect(body['model']).toBe('google/gemini-omni-flash/text-to-video-developer');
    expect(body['resolution']).toBe('1080p');
    expect(body).not.toHaveProperty('images');
  });

  it('attaching an image upgrades to image-to-video-developer (mode follows input)', () => {
    const { body } = buildAtlasRequest(
      videoSpec('gemini-omni-flash-text-to-video', {
        duration_seconds: 4,
        imageUrls: ['https://x/ref.png'],
      }),
    );
    expect(body['model']).toBe('google/gemini-omni-flash/image-to-video-developer');
    expect(body['images']).toEqual(['https://x/ref.png']);
  });

  it('reference-to-video providerModelId → reference-to-video-developer', () => {
    const { body } = buildAtlasRequest(
      videoSpec('gemini-omni-flash-reference-to-video', {
        duration_seconds: 6,
        imageUrls: ['https://x/a.png', 'https://x/b.png'],
      }),
    );
    expect(body['model']).toBe('google/gemini-omni-flash/reference-to-video-developer');
  });

  it('duration snaps to the nearest supported tier [4,6,8,10]', () => {
    expect(
      buildAtlasRequest(videoSpec('gemini-omni-flash-text-to-video', { duration_seconds: 7 })).body[
        'duration'
      ],
    ).toBe(6);
    expect(
      buildAtlasRequest(videoSpec('gemini-omni-flash-text-to-video', { duration_seconds: 9 })).body[
        'duration'
      ],
    ).toBe(8);
  });

  it('unsupported resolution falls back to 720p; wire field is aspect_ratio (not ratio)', () => {
    const { body } = buildAtlasRequest(
      videoSpec('gemini-omni-flash-text-to-video', {
        duration_seconds: 4,
        resolution: '2160p',
        aspect_ratio: '9:16',
      }),
    );
    expect(body['resolution']).toBe('720p');
    expect(body['aspect_ratio']).toBe('9:16');
    expect(body).not.toHaveProperty('ratio');
  });

  it('does not fall through to Seedance model-id mapping', () => {
    const { body } = buildAtlasRequest(
      videoSpec('gemini-omni-flash-text-to-video', { duration_seconds: 4 }),
    );
    expect(body['model']).not.toMatch(/bytedance/);
  });
});

describe('AtlasCloudAdapter end-to-end (mocked, zero spend)', () => {
  const BASE = 'https://mock.atlas.test';
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it('submits, polls to completion, and downloads n assets', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/api/v1/model/generateImage', method: 'POST' })
      .reply(200, { id: 'pred_9', status: 'created' });
    pool.intercept({ path: '/api/v1/model/result/pred_9', method: 'GET' }).reply(200, {
      id: 'pred_9',
      status: 'completed',
      outputs: ['https://cdn.atlas.test/1.jpeg', 'https://cdn.atlas.test/2.jpeg'],
    });
    const cdn = agent.get('https://cdn.atlas.test');
    for (const p of ['/1.jpeg', '/2.jpeg']) {
      cdn
        .intercept({ path: p, method: 'GET' })
        .reply(200, Buffer.from([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    }

    const adapter = new AtlasCloudAdapter(
      new AtlasCloudClient({ baseUrl: `${BASE}/api/v1`, apiKey: 'apikey-test' }),
    );
    const spec = imageSpec({ size: '1:1', n: 2 });
    const handle = await adapter.generate(spec);
    expect(handle.providerJobId).toBe('pred_9');
    const result = await adapter.awaitResult(handle, spec);
    expect(result.assets).toHaveLength(2);
    expect(result.assets[0]!.extension).toBe('jpg');
    expect(result.assets[0]!.contentType).toBe('image/jpeg');
    // No `has_nsfw_contents` in the reply → flag defaults to false, not undefined.
    expect(result.assets[0]!.nsfw).toBe(false);
    expect(result.assets[1]!.nsfw).toBe(false);
  });

  it('M-1: carries the per-output has_nsfw_contents flag onto each asset', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/api/v1/model/generateImage', method: 'POST' })
      .reply(200, { id: 'pred_nsfw', status: 'created' });
    pool.intercept({ path: '/api/v1/model/result/pred_nsfw', method: 'GET' }).reply(200, {
      id: 'pred_nsfw',
      status: 'completed',
      outputs: ['https://cdn.atlas.test/clean.jpeg', 'https://cdn.atlas.test/flagged.jpeg'],
      has_nsfw_contents: [false, true],
    });
    const cdn = agent.get('https://cdn.atlas.test');
    for (const p of ['/clean.jpeg', '/flagged.jpeg']) {
      cdn
        .intercept({ path: p, method: 'GET' })
        .reply(200, Buffer.from([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    }

    const adapter = new AtlasCloudAdapter(
      new AtlasCloudClient({ baseUrl: `${BASE}/api/v1`, apiKey: 'apikey-test' }),
    );
    const spec = imageSpec({ size: '1:1', n: 2 });
    const handle = await adapter.generate(spec);
    const result = await adapter.awaitResult(handle, spec);
    expect(result.assets.map((a) => a.nsfw)).toEqual([false, true]);
  });

  it('throws a non-retryable ProviderError on failed status', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/api/v1/model/generateVideo', method: 'POST' })
      .reply(200, { id: 'pred_f', status: 'created' });
    pool
      .intercept({ path: '/api/v1/model/result/pred_f', method: 'GET' })
      .reply(200, { id: 'pred_f', status: 'failed', error: { code: 'NSFW', message: 'blocked' } });
    const adapter = new AtlasCloudAdapter(
      new AtlasCloudClient({ baseUrl: `${BASE}/api/v1`, apiKey: 'apikey-test' }),
    );
    const spec = videoSpec('seedance-2.0-text-to-video', { duration_seconds: 5 });
    const handle = await adapter.generate(spec);
    await expect(adapter.awaitResult(handle, spec)).rejects.toMatchObject({
      code: 'NSFW',
      retryable: false,
    });
  });
});
