import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { count, eq } from 'drizzle-orm';
import { db, pool, scripts, usersApp, usersPii, nid } from '@seed/db';
import { setupScriptRoutes } from '../src/scripts';

let app: ReturnType<typeof Fastify>;
let userId: string;

const headers = () => ({ 'x-test-user': userId });

beforeAll(async () => {
  userId = nid();
  await db.insert(usersApp).values({ id: userId, displayName: 'Scripts empty test', locale: 'ru' });
  await db.insert(usersPii).values({ id: userId, email: `scripts-empty+${userId}@seed.local` });
  app = Fastify({ logger: false });
  const requireSession = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers['x-test-user'] !== userId) {
      reply.status(401).send({ error: 'unauthorized' });
      return null;
    }
    return { user: { id: userId } };
  };
  setupScriptRoutes(app as never, requireSession);
});

afterAll(async () => {
  await db.delete(usersApp).where(eq(usersApp.id, userId));
  await db.delete(usersPii).where(eq(usersPii.id, userId));
  await pool.end();
  await app.close();
});

describe('GET /v1/scripts — zero-rows ghost regression', () => {
  it('returns an empty list and creates no rows', async () => {
    const before = await db.select({ n: count() }).from(scripts).where(eq(scripts.userId, userId));
    expect(before[0]?.n).toBe(0);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/scripts',
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items ?? body).toEqual([]);

    const after = await db.select({ n: count() }).from(scripts).where(eq(scripts.userId, userId));
    expect(after[0]?.n).toBe(0);
  });
});
