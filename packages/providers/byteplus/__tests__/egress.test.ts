import { afterEach, describe, expect, it } from 'vitest';
import { ProxyAgent } from 'undici';
import { egressDispatcher, resetEgressDispatcherForTest } from '../src/egress';

afterEach(() => resetEgressDispatcherForTest());

describe('egressDispatcher', () => {
  it('returns undefined when EGRESS_PROXY_URL is unset — the direct path (today)', () => {
    expect(egressDispatcher({})).toBeUndefined();
  });

  it('returns undefined for an empty/whitespace URL (never a half-configured proxy)', () => {
    expect(egressDispatcher({ EGRESS_PROXY_URL: '' })).toBeUndefined();
    expect(egressDispatcher({ EGRESS_PROXY_URL: '   ' })).toBeUndefined();
  });

  it('returns a ProxyAgent when EGRESS_PROXY_URL is set', () => {
    const d = egressDispatcher({ EGRESS_PROXY_URL: 'http://gw.example:8888' });
    expect(d).toBeInstanceOf(ProxyAgent);
  });

  it('memoizes per (url, token) — same config returns the same agent instance', () => {
    const env = { EGRESS_PROXY_URL: 'http://gw.example:8888', EGRESS_PROXY_TOKEN: 'Basic abc' };
    const a = egressDispatcher(env);
    const b = egressDispatcher(env);
    expect(a).toBe(b);
  });

  it('rebuilds the agent when the url or token changes', () => {
    const a = egressDispatcher({ EGRESS_PROXY_URL: 'http://gw.example:8888' });
    const b = egressDispatcher({ EGRESS_PROXY_URL: 'http://gw2.example:8888' });
    expect(a).not.toBe(b);
    const c = egressDispatcher({
      EGRESS_PROXY_URL: 'http://gw2.example:8888',
      EGRESS_PROXY_TOKEN: 'Basic x',
    });
    expect(c).not.toBe(b);
  });
});
