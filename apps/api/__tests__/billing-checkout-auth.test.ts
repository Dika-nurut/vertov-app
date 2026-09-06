import 'dotenv/config';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  db,
  nid,
  orders,
  pool,
  subscriptions,
  subscriptionsCatalog,
  usersApp,
  usersPii,
} from '@seed/db';
import { CHECKOUT_RATE_LIMIT, setupBillingRoutes } from '../src/billing';

const createdUsers: string[] = [];

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'CheckoutAuth', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `checkout-auth+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

async function giveLivePlan(userId: string): Promise<void> {
  const [catalog] = await db
    .select()
    .from(subscriptionsCatalog)
    .where(eq(subscriptionsCatalog.tier, 'start'))
    .limit(1);
  if (!catalog) throw new Error('start tier not seeded');
  const now = new Date();
  await db.insert(subscriptions).values({
    id: nid(),
    userId,
    tier: 'start',
    status: 'active',
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: true,
    cycleNumber: 1,
    priceRub: catalog.priceRub,
    creditsPerCycle: catalog.creditsPerCycle,
  });
}

function unauthenticatedApp(): FastifyInstance {
  const app = Fastify();
  setupBillingRoutes(app, async (_req, reply) => {
    await reply.status(401).send({ error: 'unauthorized' });
    return null;
  });
  return app;
}

function appFor(userId: string): FastifyInstance {
  const app = Fastify();
  setupBillingRoutes(app, async () => ({ user: { id: userId } }));
  return app;
}

afterEach(async () => {
  for (const id of createdUsers) {
    await db.delete(orders).where(eq(orders.userId, id));
    await db.delete(subscriptions).where(eq(subscriptions.userId, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
  createdUsers.length = 0;
});

afterAll(async () => {
  await pool.end();
});

describe('POST /v1/billing/checkout authorization', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await unauthenticatedApp().inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { packId: 'pack-s' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a session without its own live subscription', async () => {
    const planOwner = await makeUser();
    const otherUser = await makeUser();
    await giveLivePlan(planOwner);

    const response = await appFor(otherUser).inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { packId: 'pack-s' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'active_subscription_required' });
    expect(await db.select().from(orders).where(eq(orders.userId, otherUser))).toHaveLength(0);
  });

  it('registers a dedicated checkout rate limit', async () => {
    const configs: unknown[] = [];
    const app = Fastify();
    app.addHook('onRoute', (route) => {
      if (route.method === 'POST' && route.url === '/v1/billing/checkout') {
        configs.push(route.config.rateLimit);
      }
    });
    setupBillingRoutes(app, async () => null);
    await app.ready();
    expect(configs).toContainEqual(CHECKOUT_RATE_LIMIT);
    await app.close();
  });
});
