import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { AtlasCloudClient, ProviderError } from '../src/index';

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

function client() {
  return new AtlasCloudClient({ baseUrl: `${BASE}/api/v1`, apiKey: 'apikey-test' });
}

describe('AtlasCloudClient', () => {
  it('submit parses the prediction envelope', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/api/v1/model/generateImage', method: 'POST' })
      .reply(200, { id: 'pred_1', status: 'created' });
    const res = await client().submit('/model/generateImage', { model: 'x', prompt: 'y' });
    expect(res.id).toBe('pred_1');
    expect(res.status).toBe('created');
  });

  it('getResult returns outputs on completion', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/api/v1/model/result/pred_1', method: 'GET' })
      .reply(200, { id: 'pred_1', status: 'completed', outputs: ['https://cdn.atlas.test/a.jpeg'] });
    const res = await client().getResult('pred_1');
    expect(res.status).toBe('completed');
    expect(res.outputs).toEqual(['https://cdn.atlas.test/a.jpeg']);
  });

  it('429 throws a retryable ProviderError', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/api/v1/model/generateVideo', method: 'POST' })
      .reply(429, 'rate limited');
    await expect(client().submit('/model/generateVideo', {})).rejects.toMatchObject({
      code: 'HTTP_429',
      status: 429,
      retryable: true,
    });
  });

  it('400 throws a non-retryable ProviderError', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/api/v1/model/generateImage', method: 'POST' })
      .reply(400, '{"code":400,"msg":"not found"}');
    const err = await client()
      .submit('/model/generateImage', {})
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
  });

  it('non-JSON 200 throws a retryable PARSE_ERROR', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/api/v1/model/result/pred_x', method: 'GET' })
      .reply(200, '<html>oops</html>', { headers: { 'content-type': 'text/html' } });
    const err = await client()
      .getResult('pred_x')
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('PARSE_ERROR');
    expect(err.retryable).toBe(true);
  });

  it('fetchAsset returns bytes + content-type', async () => {
    agent
      .get('https://cdn.atlas.test')
      .intercept({ path: '/a.jpeg', method: 'GET' })
      .reply(200, Buffer.from([4, 5, 6, 7]), { headers: { 'content-type': 'image/jpeg' } });
    const r = await client().fetchAsset('https://cdn.atlas.test/a.jpeg');
    expect(r.contentType).toBe('image/jpeg');
    expect(r.bytes.length).toBe(4);
  });
});
