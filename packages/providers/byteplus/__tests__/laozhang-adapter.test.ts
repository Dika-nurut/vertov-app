import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import {
  buildLaozhangImageBody,
  LaozhangAdapter,
  LaozhangClient,
  getAdapter,
  ServingLegAdapter,
  StubBytePlusAdapter,
} from '../src/index';
import type { WorkflowSpec } from '../src/types';

const BASE = 'https://mock.laozhang.test';
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
  return new LaozhangAdapter(new LaozhangClient({ baseUrl: BASE, apiKey: 'sk-lz-test' }));
}

function imageSpec(params: Record<string, unknown>): WorkflowSpec {
  return {
    modelId: 'gemini-3-pro-image',
    providerModelId: 'gemini-3-pro-image',
    providerEndpoint: '/v1/chat/completions',
    kind: 'image',
    prompt: 'a red cube',
    params,
    referenceAssets: [],
    maxDurationSeconds: null,
  };
}

describe('gateway registry — nanobanana', () => {
  it('requires the explicit live opt-in even when the key exists', () => {
    expect(getAdapter('nanobanana', { LAOZHANG_API_KEY: 'sk-x' })).toBeInstanceOf(
      StubBytePlusAdapter,
    );
    expect(getAdapter('nanobanana', { LAOZHANG_MODE: 'live' })).toBeInstanceOf(StubBytePlusAdapter);
    // Armed with only laozhang, the chain collapses to that one leg — but it is
    // a NAMED leg now (ServingLegAdapter), not the bare adapter. A bare adapter
    // stamps no `servedBy`, so a collapsed chain used to be recorded under the
    // routing alias 'nanobanana' instead of the vendor that served it.
    const single = getAdapter('nanobanana', { LAOZHANG_MODE: 'live', LAOZHANG_API_KEY: 'sk-x' });
    expect(single).toBeInstanceOf(ServingLegAdapter);
    expect((single as unknown as { name: string; inner: unknown }).name).toBe('laozhang');
    expect((single as unknown as { inner: unknown }).inner).toBeInstanceOf(LaozhangAdapter);
  });
});

describe('laozhang adapter — normalized Gemini-native path', () => {
  it('decodes native inline data and sends exact aspect/resolution controls', async () => {
    const png = Buffer.from([137, 80, 78, 71]);
    let captured: Record<string, unknown> | null = null;
    agent
      .get(BASE)
      .intercept({ path: '/v1beta/models/gemini-3-pro-image:generateContent', method: 'POST' })
      .reply(200, (req) => {
        captured = JSON.parse(req.body as string) as Record<string, unknown>;
        return {
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }],
              },
            },
          ],
        };
      });

    const adapter = makeAdapter();
    const spec = imageSpec({ aspect_ratio: '16:9', resolution: '1K' });
    const handle = await adapter.generate(spec);
    expect(handle.inlineResult).toBeDefined();
    const result = await adapter.awaitResult(handle, spec);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.contentType).toBe('image/png');
    expect(result.assets[0]!.bytes.equals(png)).toBe(true);
    expect((captured!['generationConfig'] as Record<string, unknown>)['imageConfig']).toEqual({
      aspectRatio: '16:9',
      imageSize: '1K',
    });
  });

  it('fans out the billed count into one native request per image', async () => {
    const captured: Record<string, unknown>[] = [];
    const pool = agent.get(BASE);
    for (let index = 0; index < 2; index += 1) {
      pool
        .intercept({ path: '/v1beta/models/gemini-3-pro-image:generateContent', method: 'POST' })
        .reply(200, (req) => {
          captured.push(JSON.parse(req.body as string) as Record<string, unknown>);
          return {
            candidates: [
              { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] } },
            ],
          };
        });
    }

    const spec = imageSpec({ n: 2, aspect_ratio: '1:1', resolution: '2K' });
    const adapter = makeAdapter();
    const result = await adapter.awaitResult(await adapter.generate(spec), spec);
    expect(result.assets).toHaveLength(2);
    expect(captured).toHaveLength(2);
  });

  it('fetches reference images and sends them as native inline parts', async () => {
    let captured: Record<string, unknown> | null = null;
    agent
      .get('https://a.test')
      .intercept({ path: '/ref.jpg', method: 'GET' })
      .reply(200, Buffer.from([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
    agent
      .get(BASE)
      .intercept({ path: '/v1beta/models/gemini-3-pro-image:generateContent', method: 'POST' })
      .reply(200, (req) => {
        captured = JSON.parse(req.body as string) as Record<string, unknown>;
        return {
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] } },
          ],
        };
      });

    const adapter = makeAdapter();
    await adapter.generate(
      imageSpec({ aspect_ratio: '1:1', imageUrls: ['https://a.test/ref.jpg'] }),
    );
    const contents = captured!['contents'] as { parts: unknown[] }[];
    expect(contents[0]!.parts).toEqual([
      { text: 'a red cube' },
      { inlineData: { mimeType: 'image/jpeg', data: Buffer.from([1, 2, 3]).toString('base64') } },
    ]);
  });

  it('no image in the response throws a retryable NO_ASSET', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/v1beta/models/gemini-3-pro-image:generateContent', method: 'POST' })
      .reply(200, { candidates: [{ content: { parts: [{ text: 'sorry, no image' }] } }] });
    await expect(makeAdapter().generate(imageSpec({}))).rejects.toMatchObject({
      code: 'NO_ASSET',
      retryable: true,
    });
  });
});

describe('laozhang adapter — legacy resolution compatibility', () => {
  it('routes to generateContent with imageConfig.imageSize when resolution is 4K', async () => {
    const jpeg = Buffer.from([255, 216, 255]);
    let captured: Record<string, unknown> | null = null;
    agent
      .get(BASE)
      .intercept({
        path: '/v1beta/models/gemini-3-pro-image:generateContent',
        method: 'POST',
      })
      .reply(200, (req) => {
        captured = JSON.parse(req.body as string) as Record<string, unknown>;
        return {
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }],
              },
            },
          ],
        };
      });

    const adapter = makeAdapter();
    const spec = imageSpec({ resolution: '4K' });
    const handle = await adapter.generate(spec);
    const result = await adapter.awaitResult(handle, spec);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.contentType).toBe('image/jpeg');
    expect(result.assets[0]!.bytes.equals(jpeg)).toBe(true);
    expect((captured!['generationConfig'] as Record<string, unknown>)['imageConfig']).toEqual({
      imageSize: '4K',
    });
  });

  it('a "4096x4096" size string also resolves to the 4K native path', async () => {
    agent
      .get(BASE)
      .intercept({
        path: '/v1beta/models/gemini-3-pro-image:generateContent',
        method: 'POST',
      })
      .reply(200, {
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] } },
        ],
      });
    const handle = await makeAdapter().generate(imageSpec({ size: '4096x4096' }));
    expect(handle.inlineResult?.assets).toHaveLength(1);
  });
});

describe('laozhang adapter — GPT Image 2 flat route', () => {
  it('maps every offered Board aspect to a concrete vendor-valid OpenAI size', () => {
    const sizes = {
      '21:9': '1792x768',
      '16:9': '1536x864',
      '3:2': '1536x1024',
      '4:3': '1536x1152',
      '1:1': '1024x1024',
      '3:4': '1152x1536',
      '2:3': '1024x1536',
      '9:16': '864x1536',
    };
    for (const [aspect, size] of Object.entries(sizes)) {
      const body = buildLaozhangImageBody({
        ...imageSpec({ aspect_ratio: aspect }),
        modelId: 'gpt-image-2',
        providerModelId: 'gpt-image-2',
      });
      expect(body['size']).toBe(size);
    }
  });

  it('fans out billed n and maps the Board aspect to its OpenAI size', async () => {
    const captured: Record<string, unknown>[] = [];
    const pool = agent.get(BASE);
    for (let index = 0; index < 2; index += 1) {
      pool.intercept({ path: '/v1/images/generations', method: 'POST' }).reply(200, (req) => {
        captured.push(JSON.parse(req.body as string) as Record<string, unknown>);
        return { data: [{ b64_json: 'data:image/png;base64,AA==' }] };
      });
    }
    const spec: WorkflowSpec = {
      ...imageSpec({ n: 2, aspect_ratio: '9:16', resolution: '4K' }),
      modelId: 'gpt-image-2',
      providerModelId: 'gpt-image-2',
      providerEndpoint: '/v1/images/generations',
    };
    const adapter = makeAdapter();
    const result = await adapter.awaitResult(await adapter.generate(spec), spec);
    expect(result.assets).toHaveLength(2);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toEqual({
      model: 'gpt-image-2-vip',
      prompt: 'a red cube',
      size: '864x1536',
    });
  });

  it('sends the -vip model name, the only laozhang route that honours quality', () => {
    // laozhang documents that default-group `gpt-image-2` supports NEITHER `size`
    // NOR `quality`. We bill three tiers (13/21/33 credits for low/medium/high) and
    // laozhang is the PRIMARY leg, so sending the default-group name meant charging
    // 2.5x for an identical default image. Same $0.03/call either way.
    for (const tier of ['low', 'medium', 'high'] as const) {
      const body = buildLaozhangImageBody({
        ...imageSpec({ resolution: tier, aspect_ratio: '1:1' }),
        modelId: 'gpt-image-2',
        providerModelId: 'gpt-image-2',
      });
      expect(body['model']).toBe('gpt-image-2-vip');
      expect(body['quality']).toBe(tier);
    }
  });

  it('sends references to the /v1/images/edits multipart route (i2i on primary)', async () => {
    const ref = Buffer.from([1, 2, 3, 4]);
    let editsBody: string | null = null;
    agent
      .get(BASE)
      .intercept({ path: '/a.test/ref.png', method: 'GET' })
      .reply(200, ref, { headers: { 'content-type': 'image/png' } });
    agent
      .get(BASE)
      .intercept({ path: '/v1/images/edits', method: 'POST' })
      .reply(200, (req) => {
        editsBody = Buffer.isBuffer(req.body) ? req.body.toString('binary') : String(req.body);
        return { data: [{ b64_json: 'data:image/png;base64,AA==' }] };
      });
    const spec: WorkflowSpec = {
      ...imageSpec({ imageUrls: [`${BASE}/a.test/ref.png`], aspect_ratio: '16:9' }),
      modelId: 'gpt-image-2',
      providerModelId: 'gpt-image-2',
      providerEndpoint: '/v1/images/edits',
    };
    const adapter = makeAdapter();
    const result = await adapter.awaitResult(await adapter.generate(spec), spec);
    expect(result.assets).toHaveLength(1);
    // multipart carried the model field + an `image` file part with the reference bytes.
    expect(editsBody).toContain('name="model"');
    expect(editsBody).toContain('gpt-image-2');
    expect(editsBody).toContain('name="image"');
    expect(editsBody).toContain(ref.toString('binary'));
    expect(editsBody).toContain('name="size"');
    expect(editsBody).toContain('1536x864');
  });

  // Coordinator finding (terra adversarial pass, 2026-07-28): GenerateClient sent
  // the tier as `quality`, priced it as `resolution`'s alias, but this leg read
  // ONLY `spec.params['resolution']` — billed a tier the vendor never received.
  // `resolution` is now the primary key (matches /boards + priceSelectorFromParams'
  // preference order); `quality` is a fallback for a stale/third-party caller.
  it('a Generate-style payload sending `resolution` reaches /v1/images/generations as `quality`', async () => {
    let captured: Record<string, unknown> | null = null;
    agent
      .get(BASE)
      .intercept({ path: '/v1/images/generations', method: 'POST' })
      .reply(200, (req) => {
        captured = JSON.parse(req.body as string) as Record<string, unknown>;
        return { data: [{ b64_json: 'data:image/png;base64,AA==' }] };
      });
    const spec: WorkflowSpec = {
      ...imageSpec({ resolution: 'medium' }),
      modelId: 'gpt-image-2',
      providerModelId: 'gpt-image-2',
      providerEndpoint: '/v1/images/generations',
    };
    await makeAdapter().generate(spec);
    expect(captured).toEqual({ model: 'gpt-image-2-vip', prompt: 'a red cube', quality: 'medium' });
  });

  it('a stale/legacy payload sending `quality` (not `resolution`) still reaches the wire body', async () => {
    let captured: Record<string, unknown> | null = null;
    agent
      .get(BASE)
      .intercept({ path: '/v1/images/generations', method: 'POST' })
      .reply(200, (req) => {
        captured = JSON.parse(req.body as string) as Record<string, unknown>;
        return { data: [{ b64_json: 'data:image/png;base64,AA==' }] };
      });
    const spec: WorkflowSpec = {
      ...imageSpec({ quality: 'high' }),
      modelId: 'gpt-image-2',
      providerModelId: 'gpt-image-2',
      providerEndpoint: '/v1/images/generations',
    };
    await makeAdapter().generate(spec);
    expect(captured).toEqual({ model: 'gpt-image-2-vip', prompt: 'a red cube', quality: 'high' });
  });

  it('an i2i request carries `quality` into the /v1/images/edits multipart body', async () => {
    const ref = Buffer.from([1, 2, 3, 4]);
    let editsBody: string | null = null;
    agent
      .get(BASE)
      .intercept({ path: '/a.test/ref.png', method: 'GET' })
      .reply(200, ref, { headers: { 'content-type': 'image/png' } });
    agent
      .get(BASE)
      .intercept({ path: '/v1/images/edits', method: 'POST' })
      .reply(200, (req) => {
        editsBody = Buffer.isBuffer(req.body) ? req.body.toString('binary') : String(req.body);
        return { data: [{ b64_json: 'data:image/png;base64,AA==' }] };
      });
    const spec: WorkflowSpec = {
      ...imageSpec({ resolution: 'low', imageUrls: [`${BASE}/a.test/ref.png`] }),
      modelId: 'gpt-image-2',
      providerModelId: 'gpt-image-2',
      providerEndpoint: '/v1/images/edits',
    };
    await makeAdapter().generate(spec);
    expect(editsBody).toContain('name="quality"');
    expect(editsBody).toContain('low');
  });
});
