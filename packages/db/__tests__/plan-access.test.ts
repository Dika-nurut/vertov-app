import 'dotenv/config';
import { afterEach, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/index';
import { nid } from '../src/id';
import { usersApp, usersPii } from '../schema/users';
import { subscriptions } from '../schema/subscriptions';
import {
  PLAN_ACCESS_STATUSES,
  resolveLivePlanSubscription,
  resolveUserPlanTier,
} from '../src/plan-access';

/**
 * W0 — the plan-access predicate. This is the single answer to "which models may
 * this user run", and it is the ONLY place the answer is computed: the API job
 * gate, the price-estimate suggestion and the `planAccess` payload all call it.
 *
 * The predicate: status ∈ (active, trialing, past_due) AND currentPeriodEnd is
 * still in the future; among the rows that qualify, the newest by `createdAt`.
 * `users_app.tier` is deliberately NOT consulted — no payment path writes it.
 */

const NOW = new Date('2026-07-28T12:00:00.000Z');
const FUTURE = new Date('2026-08-28T12:00:00.000Z');
const PAST = new Date('2026-06-28T12:00:00.000Z');

const createdUsers: string[] = [];

async function makeUser(tier: 'free' | 'start' | 'pro' = 'free'): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'PlanAccess', locale: 'ru', tier });
  await db.insert(usersPii).values({ id, email: `plan-access+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

type SubOverrides = Partial<typeof subscriptions.$inferInsert>;

async function seedSubscription(userId: string, over: SubOverrides = {}): Promise<string> {
  const id = nid();
  await db.insert(subscriptions).values({
    id,
    userId,
    tier: 'start',
    status: 'active',
    currentPeriodStart: PAST,
    currentPeriodEnd: FUTURE,
    cancelAtPeriodEnd: false,
    cycleNumber: 1,
    priceRub: 599,
    creditsPerCycle: 1175,
    createdAt: NOW,
    ...over,
  });
  return id;
}

afterEach(async () => {
  for (const id of createdUsers) {
    await db.delete(subscriptions).where(eq(subscriptions.userId, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
  createdUsers.length = 0;
});

afterAll(async () => {
  await pool.end();
});

describe('PLAN_ACCESS_STATUSES', () => {
  it('is exactly the three statuses that still carry entitlement', () => {
    expect([...PLAN_ACCESS_STATUSES]).toEqual(['active', 'trialing', 'past_due']);
  });
});

describe('resolveLivePlanSubscription', () => {
  it('returns null when the user has no subscription row at all', async () => {
    const userId = await makeUser();
    expect(await resolveLivePlanSubscription(db, userId, NOW)).toBeNull();
  });

  it('returns the row for an active subscription whose period has not elapsed', async () => {
    const userId = await makeUser();
    const subId = await seedSubscription(userId, { tier: 'pro', currentPeriodEnd: FUTURE });

    const live = await resolveLivePlanSubscription(db, userId, NOW);
    expect(live?.id).toBe(subId);
    expect(live?.tier).toBe('pro');
  });

  it('accepts trialing and past_due, and refuses canceled and expired', async () => {
    for (const status of ['trialing', 'past_due'] as const) {
      const userId = await makeUser();
      await seedSubscription(userId, { status });
      expect(
        (await resolveLivePlanSubscription(db, userId, NOW))?.status,
        `status=${status} must still carry entitlement`,
      ).toBe(status);
    }
    for (const status of ['canceled', 'expired'] as const) {
      const userId = await makeUser();
      await seedSubscription(userId, { status });
      expect(
        await resolveLivePlanSubscription(db, userId, NOW),
        `status=${status} must not carry entitlement`,
      ).toBeNull();
    }
  });

  it('refuses a row whose period has already elapsed, however it is statused', async () => {
    const userId = await makeUser();
    await seedSubscription(userId, { status: 'active', currentPeriodEnd: PAST });

    expect(await resolveLivePlanSubscription(db, userId, NOW)).toBeNull();
  });

  it('treats currentPeriodEnd exactly at `now` as elapsed (strictly greater-than)', async () => {
    const userId = await makeUser();
    await seedSubscription(userId, { currentPeriodEnd: NOW });

    expect(await resolveLivePlanSubscription(db, userId, NOW)).toBeNull();
  });

  it('does not let a NEWER elapsed row shadow an OLDER live one', async () => {
    // The exact shape the old `findActiveSubscription` got wrong: it ordered by
    // createdAt with no period check, so the newest elapsed row won and the
    // subscriber lost the plan they are still paid up on.
    const userId = await makeUser();
    const liveStart = await seedSubscription(userId, {
      tier: 'start',
      currentPeriodEnd: FUTURE,
      createdAt: new Date(NOW.getTime() - 10_000),
    });
    await seedSubscription(userId, {
      tier: 'plus',
      currentPeriodEnd: PAST,
      createdAt: NOW,
    });

    const live = await resolveLivePlanSubscription(db, userId, NOW);
    expect(live?.id).toBe(liveStart);
    expect(live?.tier).toBe('start');
  });

  it('picks the newest by createdAt when several rows are live at once', async () => {
    // W0's stated ordering rule. Duplicate live rows only arise from the
    // unresolved duplicate-subscribe flow; W1 owns what SHOULD happen there, so
    // this pins today's answer rather than leaving it accidental.
    const userId = await makeUser();
    await seedSubscription(userId, {
      tier: 'pro',
      currentPeriodEnd: FUTURE,
      createdAt: new Date(NOW.getTime() - 10_000),
    });
    const newer = await seedSubscription(userId, {
      tier: 'start',
      currentPeriodEnd: FUTURE,
      createdAt: NOW,
    });

    const live = await resolveLivePlanSubscription(db, userId, NOW);
    expect(live?.id).toBe(newer);
    expect(live?.tier).toBe('start');
  });

  it('runs on a transaction executor, not just the global db handle', async () => {
    const userId = await makeUser();
    const subId = nid();

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(subscriptions).values({
          id: subId,
          userId,
          tier: 'plus',
          status: 'active',
          currentPeriodStart: PAST,
          currentPeriodEnd: FUTURE,
          cancelAtPeriodEnd: false,
          cycleNumber: 1,
          priceRub: 1290,
          creditsPerCycle: 2635,
          createdAt: NOW,
        });

        const resolved = await resolveLivePlanSubscription(tx, userId, NOW);
        expect(resolved?.id).toBe(subId);
        throw new Error('force rollback');
      }),
    ).rejects.toThrow('force rollback');

    expect(await resolveLivePlanSubscription(db, userId, NOW)).toBeNull();
  });
});

describe('resolveUserPlanTier', () => {
  it('is `free` when nothing is live, even though users_app.tier says otherwise', async () => {
    // The split brain W0 closes: a hand-tiered users_app row grants nothing.
    const userId = await makeUser('pro');
    await seedSubscription(userId, { tier: 'max', currentPeriodEnd: PAST });

    expect(await resolveUserPlanTier(db, userId, NOW)).toBe('free');
  });

  it('is the live row tier, even though users_app.tier says free', async () => {
    const userId = await makeUser('free');
    await seedSubscription(userId, { tier: 'studio', currentPeriodEnd: FUTURE });

    expect(await resolveUserPlanTier(db, userId, NOW)).toBe('studio');
  });
});
