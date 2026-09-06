import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { setupBoardRoutes } from '../src/boards';

describe('board autosave throttle', () => {
  it('returns 429 and Retry-After when the per-user sliding window is full', async () => {
    const app = Fastify({ logger: false });
    const redis = {
      eval: async () => [120, 9],
    } as never;
    const requireSession = async (_req: FastifyRequest, _reply: FastifyReply) => ({
      user: { id: 'throttle-user' },
    });
    setupBoardRoutes(app, requireSession, { redis });
    await app.ready();
    const response = await app.inject({
      method: 'PUT',
      url: '/v1/boards/board-1',
      payload: { title: 'still no database work' },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('9');
    expect(response.json()).toMatchObject({ error: 'rate_limited', retryAfterSeconds: 9 });
    await app.close();
  });
});
