import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, marketingAttribution, nid, pool, usersApp, usersPii } from '@seed/db';
import { setupMeAttributionRoutes } from '../src/me-attribution';

const createdUsers: string[] = [];

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'AttributionTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `attribution+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

let app: FastifyInstance;
let currentUser: string;
let currentIsAnonymous = false;

beforeAll(async () => {
  currentUser = await makeUser();
  app = Fastify({ logger: false });
  setupMeAttributionRoutes(app, async () => ({
    user: { id: currentUser, isAnonymous: currentIsAnonymous },
  }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const id of createdUsers) {
    await db.delete(marketingAttribution).where(eq(marketingAttribution.userId, id));
    await db.delete(usersPii).where(eq(usersPii.id, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
  await pool.end();
});

describe('first-touch attribution identity boundary', () => {
  it('does not write an anonymous row, then persists first touch after signup', async () => {
    currentIsAnonymous = true;
    const payload = {
      utmSource: 'pilot',
      utmMedium: 'telegram',
      utmCampaign: 'august',
      landingPath: '/?utm_source=pilot',
    };

    const anonymous = await app.inject({ method: 'POST', url: '/v1/me/attribution', payload });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toEqual({ ok: true, skipped: 'anonymous' });

    const beforeSignup = await db
      .select()
      .from(marketingAttribution)
      .where(eq(marketingAttribution.userId, currentUser));
    expect(beforeSignup).toHaveLength(0);

    currentIsAnonymous = false;
    const real = await app.inject({ method: 'POST', url: '/v1/me/attribution', payload });
    expect(real.statusCode).toBe(200);
    expect(real.json()).toEqual({ ok: true });

    const first = await db
      .select()
      .from(marketingAttribution)
      .where(eq(marketingAttribution.userId, currentUser));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      utmSource: 'pilot',
      utmMedium: 'telegram',
      utmCampaign: 'august',
      landingPath: '/?utm_source=pilot',
    });

    const repeat = await app.inject({
      method: 'POST',
      url: '/v1/me/attribution',
      payload: { utmSource: 'later', landingPath: '/later' },
    });
    expect(repeat.statusCode).toBe(200);
    const unchanged = await db
      .select()
      .from(marketingAttribution)
      .where(eq(marketingAttribution.userId, currentUser));
    expect(unchanged[0]?.utmSource).toBe('pilot');
  });
});
