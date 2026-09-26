import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import {
  buildPixazoSeedanceMini,
  getAdapter,
  getResumeAdapter,
  PixazoAdapter,
  PixazoClient,
  StubBytePlusAdapter,
} from '../src/index';
import type { WorkflowSpec } from '../src/types';

const BASE = 'https://mock.pixazo.test';
const MEDIA = 'https://pub-582b7213209642b9b995c96c95a30381.r2.dev';
let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
});

function miniSpec(params: Record<string, unknown> = {}, prompt = 'a cat on a beach'): WorkflowSpec {
  return {
    modelId: 'seedance-2-0-mini',
    providerModelId: 'seedance-2-0-mini',
    providerEndpoint: 'https://gateway.pixazo.ai/seedance-2-0-mini/text-to-video',
    kind: 'video',
    prompt,
    params: { resolution: '480p', duration_seconds: 5, aspect_ratio: '9:16', ...params },
    referenceAssets: [],
    maxDurationSeconds: 15,
    capabilities: { frames: ['first', 'last'] },
  };
}

describe('gateway registry — pixazo', () => {
  it('requires the explicit live opt-in even when the key exists', () => {
    expect(getAdapter('pixazo', { PIXAZO_API_KEY: 'k' })).toBeInstanceOf(StubBytePlusAdapter);
    expect(getAdapter('pixazo', { PIXAZO_MODE: 'live' })).toBeInstanceOf(StubBytePlusAdapter);
    expect(getAdapter('pixazo', { PIXAZO_MODE: 'live', PIXAZO_API_KEY: 'k' })).not.toBeInstanceOf(
      StubBytePlusAdapter,
    );
  });

  it('resumes a persisted request id only when armed — never through a stub', () => {
    expect(getResumeAdapter('pixazo', { PIXAZO_MODE: 'live', PIXAZO_API_KEY: 'k' })).not.toBeNull();
    expect(getResumeAdapter('pixazo', { PIXAZO_API_KEY: 'k' })).toBeNull();
  });
});

describe('buildPixazoSeedanceMini', () => {
  it('serializes text-to-video with the quoted rung, duration and ratio', () => {
    expect(buildPixazoSeedanceMini(miniSpec())).toEqual({
      operation: 'text-to-video',
      body: {
        content: [{ type: 'text', text: 'a cat on a beach' }],
        ratio: '9:16',
        resolution: '480p',
        duration: 5,
        generate_audio: true,
        watermark: false,
      },
    });
  });

  it('routes frames to first-last-frame-to-video with explicit roles for two images', () => {
    const { operation, body } = buildPixazoSeedanceMini(
      miniSpec({
        frameImages: [
          { role: 'first', url: 'https://cdn.example/a.png' },
          { role: 'last', url: 'https://cdn.example/b.png' },
        ],
      }),
    );
    expect(operation).toBe('first-last-frame-to-video');
    expect(body.content).toEqual([
      { type: 'text', text: 'a cat on a beach' },
      { type: 'image_url', image_url: { url: 'https://cdn.example/a.png' }, role: 'first_frame' },
      { type: 'image_url', image_url: { url: 'https://cdn.example/b.png' }, role: 'last_frame' },
    ]);
  });

  it('refuses an unsold rung instead of letting the vendor default to 720p', () => {
    expect(() => buildPixazoSeedanceMini(miniSpec({ resolution: '1080p' }))).toThrow(/1080p/);
  });

  it('never asks for auto length and floors/clamps to the billed 4–15 s window', () => {
    expect(buildPixazoSeedanceMini(miniSpec({ duration_seconds: 2 })).body.duration).toBe(4);
    expect(buildPixazoSeedanceMini(miniSpec({ duration_seconds: 7.2 })).body.duration).toBe(8);
    expect(buildPixazoSeedanceMini(miniSpec({ duration_seconds: 40 })).body.duration).toBe(15);
  });

  it('refuses video/audio references the row does not sell', () => {
    expect(() =>
      buildPixazoSeedanceMini(miniSpec({ videoUrls: ['https://cdn.example/a.mp4'] })),
    ).toThrow(/references/);
  });

  it('honours an explicit audio opt-out', () => {
    expect(buildPixazoSeedanceMini(miniSpec({ generate_audio: false })).body.generate_audio).toBe(
      false,
    );
  });
});

describe('PixazoAdapter', () => {
  const adapter = () =>
    new PixazoAdapter(new PixazoClient({ baseUrl: BASE, apiKey: 'k' }), { pollIntervalMs: 1 });

  it('submits with the subscription-key header and returns the durable request id', async () => {
    agent
      .get(BASE)
      .intercept({
        path: '/seedance-2-0-mini/text-to-video',
        method: 'POST',
        headers: { 'ocp-apim-subscription-key': 'k' },
      })
      .reply(202, { request_id: 'seedance-2-0-mini_1', status: 'QUEUED', polling_url: 'x' });
    await expect(adapter().generate(miniSpec())).resolves.toEqual({
      providerJobId: 'seedance-2-0-mini_1',
      gateway: 'pixazo',
    });
  });

  it('polls to COMPLETED and downloads the mp4', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/v2/requests/status/seedance-2-0-mini_1', method: 'GET' })
      .reply(200, { status: 'PROCESSING' });
    pool.intercept({ path: '/v2/requests/status/seedance-2-0-mini_1', method: 'GET' }).reply(200, {
      status: 'COMPLETED',
      output: { media_url: [`${MEDIA}/v1/x/output.mp4`], media_type: 'video/mp4' },
    });
    agent
      .get(MEDIA)
      .intercept({ path: '/v1/x/output.mp4', method: 'GET' })
      .reply(200, Buffer.from('mp4'), { headers: { 'content-type': 'video/mp4' } });
    const result = await adapter().awaitResult(
      { providerJobId: 'seedance-2-0-mini_1', gateway: 'pixazo' },
      miniSpec(),
    );
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.contentType).toBe('video/mp4');
    expect(result.assets[0]!.extension).toBe('mp4');
  });

  it('fails terminally on ERROR/FAILED so the job refunds', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/v2/requests/status/seedance-2-0-mini_2', method: 'GET' })
      .reply(200, { status: 'ERROR', error: 'moderation', output: null });
    await expect(
      adapter().awaitResult(
        { providerJobId: 'seedance-2-0-mini_2', gateway: 'pixazo' },
        miniSpec(),
      ),
    ).rejects.toMatchObject({ code: 'SUBMIT_REJECTED', retryable: false });
  });

  it('surfaces 402 as a provably unbilled submit failure', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/seedance-2-0-mini/text-to-video', method: 'POST' })
      .reply(402, { error: 'Insufficient Balance' });
    await expect(adapter().generate(miniSpec())).rejects.toMatchObject({ status: 402 });
  });
});
