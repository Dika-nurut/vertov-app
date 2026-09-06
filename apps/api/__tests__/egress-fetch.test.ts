import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProxyAgent } from 'undici';
import { egressDispatcher, egressFetch, resetEgressFetchForTest } from '../src/egress-fetch';

afterEach(() => {
  resetEgressFetchForTest();
  vi.unstubAllGlobals();
});

describe('egressDispatcher', () => {
  it('returns undefined when EGRESS_PROXY_URL is unset — direct path (today)', () => {
    expect(egressDispatcher({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(egressDispatcher({ EGRESS_PROXY_URL: '   ' } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('returns a memoized ProxyAgent when configured', () => {
    const env = {
      EGRESS_PROXY_URL: 'http://gw:8118',
      EGRESS_PROXY_TOKEN: 'Basic x',
    } as NodeJS.ProcessEnv;
    const a = egressDispatcher(env);
    expect(a).toBeInstanceOf(ProxyAgent);
    expect(egressDispatcher(env)).toBe(a); // same instance
  });

  it('rebuilds when the url/token changes', () => {
    const a = egressDispatcher({ EGRESS_PROXY_URL: 'http://a:8118' } as NodeJS.ProcessEnv);
    const b = egressDispatcher({ EGRESS_PROXY_URL: 'http://b:8118' } as NodeJS.ProcessEnv);
    expect(a).not.toBe(b);
  });
});

describe('egressFetch', () => {
  it('forwards to global fetch WITHOUT a dispatcher when egress is off', async () => {
    const spy = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', spy);
    resetEgressFetchForTest();
    const prev = process.env.EGRESS_PROXY_URL;
    delete process.env.EGRESS_PROXY_URL;
    try {
      await egressFetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' });
      expect(spy).toHaveBeenCalledOnce();
      const opts = spy.mock.calls[0]![1] as Record<string, unknown>;
      expect(opts.dispatcher).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.EGRESS_PROXY_URL = prev;
    }
  });

  it('adds a dispatcher when EGRESS_PROXY_URL is set', async () => {
    const spy = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', spy);
    resetEgressFetchForTest();
    const prev = process.env.EGRESS_PROXY_URL;
    process.env.EGRESS_PROXY_URL = 'http://gw:8118';
    try {
      await egressFetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' });
      const opts = spy.mock.calls[0]![1] as Record<string, unknown>;
      expect(opts.dispatcher).toBeInstanceOf(ProxyAgent);
    } finally {
      if (prev === undefined) delete process.env.EGRESS_PROXY_URL;
      else process.env.EGRESS_PROXY_URL = prev;
    }
  });
});
