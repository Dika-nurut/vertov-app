import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { BytePlusClient, ProviderError } from '../src/index';

const BASE = 'https://mock.byteplus.test';
let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
});

describe('BytePlusClient', () => {
  it('200 image response parses', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/api/v3/images/generations', method: 'POST' })
      .reply(200, { data: [{ url: 'https://cdn.byteplus.test/1.png', seed: 1 }] });
    const client = new BytePlusClient({ baseUrl: `${BASE}/api/v3`, apiKey: 'test' });
    const res = await client.createImage('/images/generations', { prompt: 't' });
    expect(res.data[0]!.url).toBe('https://cdn.byteplus.test/1.png');
  });

  it('429 throws ProviderError with retryable=true', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/api/v3/images/generations', method: 'POST' })
      .reply(429, 'rate limited');
    const client = new BytePlusClient({ baseUrl: `${BASE}/api/v3`, apiKey: 'test' });
    await expect(client.createImage('/images/generations', {})).rejects.toMatchObject({
      code: 'HTTP_429',
      status: 429,
      retryable: true,
    });
  });

  it('400 throws ProviderError with retryable=false', async () => {
    const pool = agent.get(BASE);
    pool.intercept({ path: '/api/v3/images/generations', method: 'POST' }).reply(400, 'bad prompt');
    const client = new BytePlusClient({ baseUrl: `${BASE}/api/v3`, apiKey: 'test' });
    const err = await client.createImage('/images/generations', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
  });

  it('200 with non-JSON body throws a retryable PARSE_ERROR', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/api/v3/images/generations', method: 'POST' })
      .reply(200, '<html>oops</html>', { headers: { 'content-type': 'text/html' } });
    const client = new BytePlusClient({ baseUrl: `${BASE}/api/v3`, apiKey: 'test' });
    const err = await client.createImage('/images/generations', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe('PARSE_ERROR');
    expect(err.retryable).toBe(true);
  });

  it('fetchAsset returns bytes + content-type', async () => {
    const pool = agent.get('https://cdn.byteplus.test');
    pool
      .intercept({ path: '/foo.png', method: 'GET' })
      .reply(200, Buffer.from([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    const client = new BytePlusClient({ baseUrl: `${BASE}/api/v3`, apiKey: 'test' });
    const r = await client.fetchAsset('https://cdn.byteplus.test/foo.png');
    expect(r.contentType).toBe('image/png');
    expect(r.bytes.length).toBe(3);
  });
});
