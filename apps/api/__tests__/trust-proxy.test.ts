import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { resolveTrustProxy } from '../src/trust-proxy';

/**
 * BL-7 — `trustProxy` not configured → IP rate-limits collapse or are bypassable.
 *
 * The default config trusts ONLY the loopback hop (the local Caddy). So:
 *  - a request that genuinely came through the local proxy exposes the real
 *    client IP from `X-Forwarded-For` (limits key on the caller, not on Caddy);
 *  - a direct connection from an untrusted address that sets `X-Forwarded-For`
 *    is ignored — `req.ip` is the socket peer, so the spoof can't dodge limits.
 *
 * Pre-fix (`trustProxy` unset), `req.ip` was ALWAYS the socket peer regardless
 * of `X-Forwarded-For`, so the trusted-hop extraction below fails.
 */
describe('BL-7: resolveTrustProxy env parsing', () => {
  it('defaults to trusting only the loopback hop', () => {
    expect(resolveTrustProxy({})).toEqual(['127.0.0.1', '::1']);
  });
  it('false → trust nobody, true → trust all', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: 'false' })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: 'true' })).toBe(true);
  });
  it('a bare number → hop count', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: '2' })).toBe(2);
  });
  it('a comma list → CIDR/IP allow-list', () => {
    expect(resolveTrustProxy({ TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' })).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
    ]);
  });
});

describe('BL-7: req.ip behind the proxy (default loopback trust)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false, trustProxy: resolveTrustProxy({}) });
    app.get('/whoami', async (req) => ({ ip: req.ip }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const ipFor = async (remoteAddress: string, xff?: string): Promise<string> => {
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      remoteAddress,
      ...(xff ? { headers: { 'x-forwarded-for': xff } } : {}),
    });
    return (res.json() as { ip: string }).ip;
  };

  it('extracts the real client IP from XFF when the peer is the trusted local proxy', async () => {
    expect(await ipFor('127.0.0.1', '9.9.9.9')).toBe('9.9.9.9');
  });

  it('walks past chained loopback hops to the real client', async () => {
    expect(await ipFor('127.0.0.1', '9.9.9.9, 127.0.0.1')).toBe('9.9.9.9');
  });

  it('IGNORES spoofed XFF from an untrusted direct connection', async () => {
    // A client connecting directly (not via the loopback proxy) cannot forge
    // its IP — req.ip stays the socket peer.
    expect(await ipFor('203.0.113.5', '9.9.9.9')).toBe('203.0.113.5');
  });

  it('falls back to the socket peer when there is no XFF', async () => {
    expect(await ipFor('127.0.0.1')).toBe('127.0.0.1');
  });

  it('uses the forwarded client IP for the velocity key, not the proxy address', async () => {
    expect(await ipFor('127.0.0.1', '198.51.100.27')).toBe('198.51.100.27');
  });
});
