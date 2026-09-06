import 'dotenv/config';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { db, nid, pool, schema, usersApp, usersPii } from '@seed/db';
import { CreditService } from '@seed/credits';
import { setupMeProfileRoutes } from '../src/me-profile';

const svc = new CreditService();

async function makeUser(): Promise<{ id: string; email: string }> {
  const id = nid();
  const email = `onboarding+${id}@seed.local`;
  await db.insert(schema.user).values({ id, name: 'Test User', email, emailVerified: true });
  await db.insert(usersApp).values({ id, displayName: 'Test User', locale: 'ru' });
  await db.insert(usersPii).values({ id, email });
  return { id, email };
}

async function buildApp(user?: { id: string; email: string }) {
  const app = Fastify({ logger: false });
  setupMeProfileRoutes(
    app,
    async (_req, reply) => {
      if (!user) {
        reply.status(401).send({ error: 'unauthorized' });
        return null;
      }
      return { user: { id: user.id, email: user.email } };
    },
    svc,
  );
  await app.ready();
  return app;
}

async function cleanupUser(id: string) {
  await db.delete(usersPii).where(eq(usersPii.id, id));
  await db.delete(usersApp).where(eq(usersApp.id, id));
  await db.delete(schema.user).where(eq(schema.user.id, id));
}

const createdUsers: string[] = [];
beforeEach(() => {
  createdUsers.length = 0;
});
afterAll(async () => {
  for (const id of createdUsers) await cleanupUser(id);
  await pool.end();
});

describe('POST /v1/me/onboarded', () => {
  it('returns 401 without an authenticated session', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/onboarded',
      payload: { answers: {} },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects malformed answers with 400', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);

    const stringAnswers = await app.inject({
      method: 'POST',
      url: '/v1/me/onboarded',
      payload: { answers: 'not-an-object' },
    });
    expect(stringAnswers.statusCode).toBe(400);

    const nullAnswers = await app.inject({
      method: 'POST',
      url: '/v1/me/onboarded',
      payload: { answers: null },
    });
    expect(nullAnswers.statusCode).toBe(400);
    await app.close();
  });

  it('flips onboardedAt and stores answers', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/onboarded',
      payload: {
        answers: {
          goal: 'avatar',
          source: 'tg',
          emailConsent: true,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.onboardedAt).toBeTruthy();

    // Verify DB was updated.
    const row = await db.select().from(usersApp).where(eq(usersApp.id, u.id)).limit(1);
    expect(row[0]?.onboardedAt).toBeInstanceOf(Date);
    expect((row[0]?.onboardingAnswers as Record<string, unknown>)?.goal).toBe('avatar');
    await app.close();
  });

  it('is idempotent — duplicate POST returns same onboardedAt without updating', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/me/onboarded',
      payload: { answers: { goal: 'art' } },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/me/onboarded',
      payload: { answers: { goal: 'different' } },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body);

    // Timestamps must match (returned as ISO strings in JSON).
    expect(secondBody.onboardedAt).toBe(firstBody.onboardedAt);

    // DB answers unchanged — skipped stays 'art' not 'different'.
    const row = await db.select().from(usersApp).where(eq(usersApp.id, u.id)).limit(1);
    expect((row[0]?.onboardingAnswers as Record<string, unknown>)?.goal).toBe('art');
    await app.close();
  });

  it('skip flow: empty answers {} still flips onboardedAt', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/onboarded',
      payload: { answers: { skipped: true } },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).onboardedAt).toBeTruthy();

    const row = await db.select().from(usersApp).where(eq(usersApp.id, u.id)).limit(1);
    expect(row[0]?.onboardedAt).toBeInstanceOf(Date);
    expect((row[0]?.onboardingAnswers as Record<string, unknown>)?.skipped).toBe(true);
    await app.close();
  });
});

describe('GET /v1/me/profile returns onboardedAt + onboardingAnswers', () => {
  it('returns null onboardedAt for fresh user', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);

    const res = await app.inject({ method: 'GET', url: '/v1/me/profile' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.onboardedAt).toBeNull();
    expect(body.onboardingAnswers).toBeNull();
    await app.close();
  });

  it('returns filled onboardedAt + answers after POST /v1/me/onboarded', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);

    await app.inject({
      method: 'POST',
      url: '/v1/me/onboarded',
      payload: { answers: { goal: 'рекламa', source: 'yandex', emailConsent: false } },
    });

    const res = await app.inject({ method: 'GET', url: '/v1/me/profile' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.onboardedAt).toBeTruthy();
    expect(body.onboardingAnswers).toMatchObject({ goal: 'рекламa', source: 'yandex' });
    await app.close();
  });
});
