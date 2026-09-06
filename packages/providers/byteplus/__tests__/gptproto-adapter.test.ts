import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import {
  buildGptprotoImageBody,
  GptprotoAdapter,
  GptprotoClient,
  getAdapter,
  getResumeAdapter,
  StubBytePlusAdapter,
} from '../src/index';
import type { WorkflowSpec } from '../src/types';

const BASE = 'https://mock.gptproto.test';
let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
});

function makeAdapter(pollIntervalMs = 1) {
  return new GptprotoAdapter(new GptprotoClient({ baseUrl: BASE, apiKey: 'sk-gp-test' }), {
    pollIntervalMs,
  });
}

function imageSpec(params: Record<string, unknown> = {}): WorkflowSpec {
  return {
    modelId: 'gemini-3-pro-image',
    providerModelId: 'gemini-3-pro-image-preview',
    providerEndpoint: '/api/v3/google/gemini-3-pro-image-preview/text-to-image',
    kind: 'image',
    prompt: 'a red cube',
    params,
    referenceAssets: [],
    maxDurationSeconds: null,
  };
}

describe('gateway registry — gptproto', () => {
  it('requires the explicit live opt-in even when the key exists', () => {
    expect(getAdapter('gptproto', { GPTPROTO_API_KEY: 'sk-x' })).toBeInstanceOf(
      StubBytePlusAdapter,
    );
    expect(getAdapter('gptproto', { GPTPROTO_MODE: 'live' })).toBeInstanceOf(StubBytePlusAdapter);
  });

  it('returns the real adapter when armed', () => {
    const a = getAdapter('gptproto', { GPTPROTO_MODE: 'live', GPTPROTO_API_KEY: 'sk-x' });
    expect(a).not.toBeInstanceOf(StubBytePlusAdapter);
  });

  it('is resumable when armed — a persisted prediction id must resume polling', () => {
    const armed = { GPTPROTO_MODE: 'live', GPTPROTO_API_KEY: 'sk-x' };
    expect(getResumeAdapter('gptproto', armed)).not.toBeNull();
    // and null when NOT armed — never a stub re-polling a real paid handle
    expect(getResumeAdapter('gptproto', {})).toBeNull();
  });
});

describe('buildGptprotoImageBody — pure body shape', () => {
  it('maps resolution tier and aspect ratio; async mode is always off', () => {
    const body = buildGptprotoImageBody(imageSpec({ resolution: '2K', aspect_ratio: '16:9' }));
    expect(body).toEqual({
      prompt: 'a red cube',
      output_format: 'png',
      aspect_ratio: '16:9',
      size: '2K',
      enable_sync_mode: false,
    });
  });

  it('image-edit scene inputs ride the images[] array from referenceAssets', () => {
    const spec = imageSpec();
    spec.kind = 'image-edit';
    spec.referenceAssets = ['https://assets.test/ref1.png', 'https://assets.test/clip.mp4'];
    const body = buildGptprotoImageBody(spec);
    expect(body.images).toEqual(['https://assets.test/ref1.png']);
  });
});

describe('gptproto adapter — submit/poll/download flow', () => {
  it('submits to the text-to-image scene and returns the prediction id', async () => {
    let capturedPath = '';
    let capturedBody: Record<string, unknown> | null = null;
    agent
      .get(BASE)
      .intercept({
        path: '/api/v3/google/gemini-3-pro-image-preview/text-to-image',
        method: 'POST',
      })
      .reply(200, (req) => {
        capturedPath = req.path as unknown as string;
        capturedBody = JSON.parse(req.body as string) as Record<string, unknown>;
        return { data: { id: 'pred-1', status: 'queued' }, message: 'success', code: 200 };
      });
    const handle = await makeAdapter().generate(imageSpec());
    expect(handle.providerJobId).toBe('pred-1');
    expect(handle.gateway).toBe('gptproto');
    expect(capturedPath).toContain('/api/v3/google/gemini-3-pro-image-preview/text-to-image');
    expect(capturedBody!['enable_sync_mode']).toBe(false);
  });

  it('submits image-edit to the image-edit scene with the reference URLs', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    agent
      .get(BASE)
      .intercept({
        path: '/api/v3/google/gemini-3-pro-image-preview/image-edit',
        method: 'POST',
      })
      .reply(200, (req) => {
        capturedBody = JSON.parse(req.body as string) as Record<string, unknown>;
        return { data: { id: 'pred-2' }, code: 200 };
      });
    const spec = imageSpec();
    spec.kind = 'image-edit';
    spec.referenceAssets = ['https://assets.test/ref1.png'];
    const handle = await makeAdapter().generate(spec);
    expect(handle.providerJobId).toBe('pred-2');
    expect(capturedBody!['images']).toEqual(['https://assets.test/ref1.png']);
  });

  it('n>1 fans out to n submits encoded as a gp-batch: handle', async () => {
    let submitCount = 0;
    const pool = agent.get(BASE);
    for (let i = 0; i < 3; i++) {
      pool
        .intercept({
          path: '/api/v3/google/gemini-3-pro-image-preview/text-to-image',
          method: 'POST',
        })
        .reply(200, () => {
          submitCount += 1;
          return { data: { id: `pred-${submitCount}` }, code: 200 };
        });
    }
    const handle = await makeAdapter().generate(imageSpec({ n: 3 }));
    expect(submitCount).toBe(3);
    expect(handle.providerJobId).toBe('gp-batch:pred-1,pred-2,pred-3');
  });

  it('no prediction id → NO_TASK_ID, retryable', async () => {
    agent
      .get(BASE)
      .intercept({
        path: /\/api\/v3\/google\/gemini-3-pro-image-preview\/text-to-image$/,
        method: 'POST',
      })
      .reply(200, { message: 'weird empty', code: 200 });
    await expect(makeAdapter().generate(imageSpec())).rejects.toMatchObject({
      code: 'NO_TASK_ID',
      retryable: true,
    });
  });

  it('polls until completed then downloads the vendor-hosted output', async () => {
    let polls = 0;
    agent
      .get(BASE)
      .intercept({ path: /\/api\/v3\/google\/.*\/text-to-image$/, method: 'POST' })
      .reply(200, { data: { id: 'pred-9' }, code: 200 });
    agent
      .get(BASE)
      .intercept({ path: '/api/v3/predictions/pred-9/result', method: 'GET' })
      .reply(200, { data: { id: 'pred-9', status: 'running', outputs: [] }, code: 200 });
    agent
      .get(BASE)
      .intercept({ path: '/api/v3/predictions/pred-9/result', method: 'GET' })
      .reply(200, {
        data: {
          id: 'pred-9',
          status: 'completed',
          outputs: ['https://cdn.gptproto.test/out.png'],
          has_nsfw_contents: [false],
        },
        code: 200,
      });
    polls = 2;
    const png = Buffer.from([137, 80, 78, 71]);
    agent
      .get('https://cdn.gptproto.test')
      .intercept({ path: '/out.png', method: 'GET' })
      .reply(200, png, { headers: { 'content-type': 'image/png' } });

    const adapter = makeAdapter();
    const handle = await adapter.generate(imageSpec());
    const result = await adapter.awaitResult(handle, imageSpec());
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.bytes).toEqual(png);
    expect(result.assets[0]!.extension).toBe('png');
  });

  it('failed prediction → SUBMIT_REJECTED, not retryable', async () => {
    agent
      .get(BASE)
      .intercept({ path: /\/api\/v3\/google\/.*\/text-to-image$/, method: 'POST' })
      .reply(200, { data: { id: 'pred-f' }, code: 200 });
    agent
      .get(BASE)
      .intercept({ path: '/api/v3/predictions/pred-f/result', method: 'GET' })
      .reply(200, {
        data: { id: 'pred-f', status: 'failed', error: 'moderation' },
        code: 200,
      });
    const adapter = makeAdapter();
    const handle = await adapter.generate(imageSpec());
    await expect(adapter.awaitResult(handle, imageSpec())).rejects.toMatchObject({
      code: 'SUBMIT_REJECTED',
      retryable: false,
    });
  });

  it('completed with no outputs → NO_ASSET, retryable', async () => {
    agent
      .get(BASE)
      .intercept({ path: /\/api\/v3\/google\/.*\/text-to-image$/, method: 'POST' })
      .reply(200, { data: { id: 'pred-e' }, code: 200 });
    agent
      .get(BASE)
      .intercept({ path: '/api/v3/predictions/pred-e/result', method: 'GET' })
      .reply(200, { data: { id: 'pred-e', status: 'completed', outputs: [] }, code: 200 });
    const adapter = makeAdapter();
    const handle = await adapter.generate(imageSpec());
    await expect(adapter.awaitResult(handle, imageSpec())).rejects.toMatchObject({
      code: 'NO_ASSET',
      retryable: true,
    });
  });

  it('vendor 402 (no balance) → HTTP_402 classified by the shared retry rule', async () => {
    agent
      .get(BASE)
      .intercept({ path: /\/api\/v3\/google\/.*\/text-to-image$/, method: 'POST' })
      .reply(402, {
        error: { message: 'Insufficient balance' },
      });
    await expect(makeAdapter().generate(imageSpec())).rejects.toMatchObject({
      code: 'HTTP_402',
      retryable: false,
    });
  });
});
