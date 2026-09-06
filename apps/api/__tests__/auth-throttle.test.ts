import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type IORedis from 'ioredis';
import { setupAuthFrontDoorRoutes } from '../src/auth-throttle';

/**
 * BL-6 (magic-link email-bombing) + BL-3 (anonymous-signup credit farming).
 *
 * Pre-fix the magic-link endpoint was throttled per-IP ONLY (rotating IPs flood
 * any inbox) and `/sign-in/anonymous` had only the global 100/min bucket (a
 * script mints unlimited free-credit accounts). The throttles below are the
 * blocked exploits; with `forward` stubbed there is no Better-Auth/DB.
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
  app = Fastify({ logger: false });
  setupAuthFrontDoorRoutes(app, {
    redis: makeRedisStub(),
    isProd: true, // exercise the tight production ceilings
    forward: async (_req, reply) => {
      reply.status(200).send({ ok: true });
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const magicLink = (email: string, ip: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/magic-link',
    payload: { email },
    remoteAddress: ip,
  });

const anon = (ip: string) =>
  app.inject({ method: 'POST', url: '/api/auth/sign-in/anonymous', remoteAddress: ip });

describe('BL-6: magic-link is throttled per destination email, regardless of IP', () => {
  it('rejects disposable signup email domains', async () => {
    const res = await magicLink('attacker@mailinator.com', '203.0.113.99');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'disposable_email' });
  });

  it('blocks the 5th link to one address even from 5 different IPs', async () => {
    const victim = 'victim@example.com';
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await magicLink(victim, `203.0.113.${10 + i}`); // rotate source IP each time
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(codes[4]).toBe(429);
  });

  it('does not throttle a different destination address', async () => {
    const res = await magicLink('someone-else@example.com', '203.0.113.10');
    expect(res.statusCode).toBe(200);
  });
});

describe('BL-3: anonymous signup is throttled per client IP', () => {
  it('blocks the 11th anonymous signup from one IP', async () => {
    const ip = '198.51.100.7';
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await anon(ip)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('does not throttle a fresh IP', async () => {
    expect((await anon('198.51.100.200')).statusCode).toBe(200);
  });
});
