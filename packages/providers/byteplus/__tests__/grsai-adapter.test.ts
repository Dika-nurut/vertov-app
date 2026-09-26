import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import {
  buildGrsaiDrawBody,
  getAdapter,
  getResumeAdapter,
  GrsaiAdapter,
  GrsaiClient,
  GRSAI_BATCH_PREFIX,
  StubBytePlusAdapter,
} from '../src/index';
import type { WorkflowSpec } from '../src/types';

const BASE = 'https://mock.grsai.test';
const CDN = 'https://file.grsai.test';
let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
});

function spec(modelId: string, params: Record<string, unknown> = {}): WorkflowSpec {
  return {
    modelId,
    providerModelId: modelId,
    providerEndpoint: '/v1/draw/nano-banana',
    kind: 'image',
    prompt: 'a red cube',
    params,
    referenceAssets: [],
    maxDurationSeconds: null,
  };
}

describe('gateway registry — grsai', () => {
  it('stays a stub until explicitly armed, and never resumes through a stub', () => {
    expect(getAdapter('grsai', { GRSAI_API_KEY: 'k' })).toBeInstanceOf(StubBytePlusAdapter);
    expect(getAdapter('grsai', { GRSAI_MODE: 'live', GRSAI_API_KEY: 'k' })).not.toBeInstanceOf(
      StubBytePlusAdapter,
    );
    expect(getResumeAdapter('grsai', { GRSAI_API_KEY: 'k' })).toBeNull();
    expect(getResumeAdapter('grsai', { GRSAI_MODE: 'live', GRSAI_API_KEY: 'k' })).not.toBeNull();
  });
});

describe('buildGrsaiDrawBody', () => {
  it('maps NB Pro with size, ratio and the poll-id webhook', () => {
    expect(
      buildGrsaiDrawBody(spec('gemini-3-pro-image', { resolution: '2K', aspect_ratio: '16:9' })),
    ).toEqual({
      model: 'nano-banana-pro',
      prompt: 'a red cube',
      aspectRatio: '16:9',
      imageSize: '2K',
      webHook: '-1',
      shutProgress: true,
    });
  });

  it('sends references as urls and maps NB-2', () => {
    const body = buildGrsaiDrawBody(
      spec('gemini-3-1-flash-image', { imageUrls: ['https://cdn.example/a.png'] }),
    );
    expect(body.model).toBe('nano-banana-2');
    expect(body.urls).toEqual(['https://cdn.example/a.png']);
  });

  it('refuses a model it has no route for and a size it does not sell', () => {
    expect(() => buildGrsaiDrawBody(spec('gpt-image-2'))).toThrow(/no Grsai route/);
    expect(() => buildGrsaiDrawBody(spec('gemini-3-pro-image', { resolution: '3K' }))).toThrow(
      /3K/,
    );
  });
});

describe('GrsaiAdapter', () => {
  const adapter = () =>
    new GrsaiAdapter(new GrsaiClient({ baseUrl: BASE, apiKey: 'k' }), { pollIntervalMs: 1 });

  it('fans n>1 into n billed submits and packs the ids', async () => {
    const pool = agent.get(BASE);
    for (const id of ['t1', 't2']) {
      pool
        .intercept({
          path: '/v1/draw/nano-banana',
          method: 'POST',
          headers: { authorization: 'Bearer k' },
        })
        .reply(200, { code: 0, msg: 'success', data: { id } });
    }
    const handle = await adapter().generate(spec('gemini-3-pro-image', { n: 2 }));
    expect(handle.gateway).toBe('grsai');
    expect(handle.providerJobId.startsWith(GRSAI_BATCH_PREFIX)).toBe(true);
  });

  it('polls to succeeded and downloads before the 2 h URL expiry', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/v1/draw/result', method: 'POST' })
      .reply(200, { code: 0, data: { id: 't1', status: 'running', progress: 40 } });
    pool.intercept({ path: '/v1/draw/result', method: 'POST' }).reply(200, {
      code: 0,
      data: { id: 't1', status: 'succeeded', results: [{ url: `${CDN}/o.png` }] },
    });
    agent
      .get(CDN)
      .intercept({ path: '/o.png', method: 'GET' })
      .reply(200, Buffer.from('png'), { headers: { 'content-type': 'image/png' } });
    const result = await adapter().awaitResult(
      { providerJobId: 't1', gateway: 'grsai' },
      spec('gemini-3-pro-image'),
    );
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.extension).toBe('png');
  });

  it('fails terminally on a moderation refusal so the job refunds', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/v1/draw/result', method: 'POST' })
      .reply(200, {
        code: 0,
        data: { id: 't9', status: 'failed', failure_reason: 'output_moderation', error: 'x' },
      });
    await expect(
      adapter().awaitResult({ providerJobId: 't9', gateway: 'grsai' }, spec('gemini-3-pro-image')),
    ).rejects.toMatchObject({ code: 'SUBMIT_REJECTED', retryable: false });
  });

  it('treats the live insufficient-credit answer (HTTP 200, code -1) as an unbilled 402', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/v1/draw/nano-banana', method: 'POST' })
      .reply(200, { code: -1, data: null, msg: 'insufficient credits' });
    await expect(adapter().generate(spec('gemini-3-pro-image'))).rejects.toMatchObject({
      status: 402,
      retryable: false,
    });
  });
});
