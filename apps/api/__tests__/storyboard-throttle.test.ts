import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type IORedis from 'ioredis';
import { pool } from '@seed/db';
import { setupStoryboardRoutes } from '../src/storyboard';

/**
 * BL-8 — the unauthenticated storyboard-PDF endpoint had no rate limit; each hit
 * fans out N MinIO fetches + a PDFKit render, an easy CPU/bandwidth
 * amplification. The public route is now throttled per share token AND per
 * client IP. (Over-limit requests are rejected before the DB lookup / render,
 * so these use non-existent tokens — no board row or PDF needed.)
 */
function makeRedisStub(): IORedis {
  const store = new Map<string, number>();
  return {
    async eval(_script: string, _numKeys: number, key: string) {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
  } as unknown as IORedis;
}

let app: FastifyInstance;

beforeAll(async () => {
  process.env.STORYBOARD_TOKEN_RATE_MAX = '3';
  process.env.STORYBOARD_IP_RATE_MAX = '5';
  app = Fastify({ logger: false });
  setupStoryboardRoutes(app, async () => ({ user: { id: 'unused' } }), { redis: makeRedisStub() });
  await app.ready();
});

afterAll(async () => {
  delete process.env.STORYBOARD_TOKEN_RATE_MAX;
  delete process.env.STORYBOARD_IP_RATE_MAX;
  await app.close();
  await pool.end();
});

const hit = (token: string, ip: string) =>
  app.inject({ method: 'GET', url: `/v1/storyboard/${token}`, remoteAddress: ip });

describe('BL-8: public storyboard route is throttled', () => {
  it('blocks the 4th hit on one share token (cap 3)', async () => {
    const token = 'sb-tokentokentoken';
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await hit(token, '10.0.0.1')).statusCode);
    // Valid-format but non-existent token → 404 while under the cap, then 429.
    expect(codes.slice(0, 3)).toEqual([404, 404, 404]);
    expect(codes[3]).toBe(429);
  });

  it('blocks the 6th hit from one IP across distinct tokens (cap 5)', async () => {
    const ip = '10.0.0.2';
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await hit(`sb-distincttok${i}xx`, ip)).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 404)).toBe(true);
    expect(codes[5]).toBe(429);
  });
});
