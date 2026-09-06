import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {
  PUBLIC_RATE_LIMITS,
  assetProxyRateLimit,
  publicFeedRateLimit,
  publicReportRateLimit,
} from '../src/public-rate-limits';

/**
 * BL-9 — public read endpoints shared the global 100/min/IP bucket, so one
 * media-heavy page load (many asset-proxy byte requests) could exhaust a real
 * user's budget. Giving the asset proxy + public feeds their own per-route
 * `config.rateLimit` puts each on an INDEPENDENT per-IP bucket. This suite
 * mirrors the server's rate-limit wiring with the real config builders and
 * asserts the isolation: a burst on a public route past the GLOBAL cap stays
 * green and does not consume the global budget, while the feed/global buckets
 * still cap.
 */
const GLOBAL_MAX = 100; // the production global per-IP cap

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(rateLimit, { max: GLOBAL_MAX, timeWindow: '1 minute' });
  app.get('/asset', { config: assetProxyRateLimit(true) }, async () => ({ ok: 'asset' }));
  app.get('/feed', { config: publicFeedRateLimit(true) }, async () => ({ ok: 'feed' }));
  app.post('/report', { config: publicReportRateLimit(true) }, async () => ({ ok: 'report' }));
  app.get('/global', async () => ({ ok: 'global' })); // no per-route config → global bucket
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const hitN = async (url: string, ip: string, n: number): Promise<number[]> => {
  const codes: number[] = [];
  for (let i = 0; i < n; i++)
    codes.push((await app.inject({ method: 'GET', url, remoteAddress: ip })).statusCode);
  return codes;
};

describe('BL-9: public read endpoints have isolated, larger buckets', () => {
  it('a media-heavy page (150 asset hits) stays green past the global 100 cap', async () => {
    const codes = await hitN('/asset', '5.5.5.1', 150);
    expect(codes.every((c) => c === 200)).toBe(true); // asset bucket is 600, not 100
  });

  it('those asset hits did NOT consume the global budget', async () => {
    // Same IP that just made 150 asset requests can still use a global route.
    const res = await app.inject({ method: 'GET', url: '/global', remoteAddress: '5.5.5.1' });
    expect(res.statusCode).toBe(200);
  });

  it('the global bucket still caps a generic route at 100', async () => {
    const codes = await hitN('/global', '5.5.5.2', GLOBAL_MAX + 1);
    expect(codes[GLOBAL_MAX]).toBe(429); // the 101st
  });

  it('the feed bucket caps scraping at its own (higher) limit', async () => {
    const max = PUBLIC_RATE_LIMITS.PUBLIC_FEED_MAX;
    const codes = await hitN('/feed', '5.5.5.3', max + 1);
    expect(codes.slice(0, max).every((c) => c === 200)).toBe(true);
    expect(codes[max]).toBe(429);
  });

  it('the report bucket is narrower than the public read bucket', async () => {
    const max = PUBLIC_RATE_LIMITS.PUBLIC_REPORT_MAX;
    const codes: number[] = [];
    for (let i = 0; i < max + 1; i++) {
      codes.push(
        (await app.inject({ method: 'POST', url: '/report', remoteAddress: '5.5.5.4' })).statusCode,
      );
    }
    expect(codes.slice(0, max).every((c) => c === 200)).toBe(true);
    expect(codes[max]).toBe(429);
    expect(max).toBeLessThan(PUBLIC_RATE_LIMITS.PUBLIC_FEED_MAX);
  });
});
