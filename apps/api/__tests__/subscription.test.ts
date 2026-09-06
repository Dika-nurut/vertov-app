import 'dotenv/config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import IORedis from 'ioredis';
import { pino } from 'pino';
import {
  auditLog,
  creditBuckets,
  creditTransactions,
  db,
  galleryItems,
  hasPaidMediaStorage,
  nid,
  orders,
  pool,
  resolveLivePlanSubscription,
  subscriptions,
  usersApp,
  usersPii,
} from '@seed/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { CreditService } from '@seed/credits';
import type { TochkaPaymentProvider } from '@seed/provider-tochka';
import { setupAdminPanelRoutes } from '../src/admin-panel';
import { _internal } from '../src/billing';
import { setupSubscriptionRoutes } from '../src/subscriptions';
import { startSubscriptionCycle } from '../../worker/src/subscription-cycle';

/** Minimal app mounting the subscription routes with a fixed session — enough
 *  for the no-payment downgrade/cancel endpoints (they never touch the PSP). */
function buildSubApp(userId: string): FastifyInstance {
  const app = Fastify();
  setupSubscriptionRoutes(app, async () => ({ user: { id: userId } }));
  return app;
}

const svc = new CreditService();
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';

const createdUsers: string[] = [];

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'SubTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `sub+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

interface SubscribeOpts {
  tier?: 'start' | 'creator';
  purpose?: 'subscribe' | 'upgrade' | 'renewal';
  metadata?: Record<string, unknown>;
  amountRub?: number;
}

async function makeSubscriptionOrder(
  userId: string,
  paymentId: string,
  opts: SubscribeOpts = {},
): Promise<string> {
  const id = nid();
  const tier = opts.tier ?? 'start';
  const purpose = opts.purpose ?? 'subscribe';
  await db.insert(orders).values({
    id,
    userId,
    kind: 'subscription',
    tierOrPackId: tier,
    amountRub: opts.amountRub ?? 490,
    psp: 'yookassa-stub',
    pspPaymentId: paymentId,
    pspStatus: 'pending',
    ourStatus: 'pending',
    metadata: opts.metadata ?? { purpose, tier },
  });
  return id;
}

beforeEach(() => {
  createdUsers.length = 0;
});

afterEach(async () => {
  for (const id of createdUsers) {
    await db.delete(auditLog).where(eq(auditLog.userId, id));
    await db.delete(creditTransactions).where(eq(creditTransactions.userId, id));
    await db.delete(orders).where(eq(orders.userId, id));
    await db.delete(subscriptions).where(eq(subscriptions.userId, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
});

afterAll(async () => {
  await pool.end();
});

describe('applyPaymentSucceeded — subscription orders', () => {
  it('subscribe creates subscription row + grants first cycle credits', async () => {
    const u = await makeUser();
    const assetId = nid();
    await db.insert(galleryItems).values({
      id: assetId,
      userId: u,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const paymentId = `subtest-${nid()}`;
    await makeSubscriptionOrder(u, paymentId, { tier: 'start' });
    const out = await _internal.applyPaymentSucceeded(paymentId);
    expect(out.kind).toBe('subscription');
    // Старт grants its catalog creditsPerCycle (5-tier grid, 2026-07-17).
    expect(out.credits).toBe(1175);

    const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, u));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.tier).toBe('start');
    expect(subs[0]!.status).toBe('active');
    expect(subs[0]!.cancelAtPeriodEnd).toBe(true); // anti-pattern wedge: opt-in
    expect(subs[0]!.cycleNumber).toBe(1);
    expect(subs[0]!.creditsPerCycle).toBe(1175);

    const balance = await svc.balanceFor(u);
    expect(balance.available).toBe(1175);
    expect(
      (await db.select().from(galleryItems).where(eq(galleryItems.id, assetId)))[0]?.expiresAt,
    ).toBeNull();
  });

  it('duplicate subscribe webhook short-circuits — no new subscription, no double grant (audit #1)', async () => {
    const u = await makeUser();
    const paymentId = `subdup-${nid()}`;
    await makeSubscriptionOrder(u, paymentId, { tier: 'creator' });
    const first = await _internal.applyPaymentSucceeded(paymentId);
    expect(first.granted).toBe(true);
    expect(first.credits).toBe(4500);

    // Replay the same webhook: must NOT mint a second sub row, must NOT
    // double-grant credits, must report granted=false.
    const second = await _internal.applyPaymentSucceeded(paymentId);
    expect(second.granted).toBe(false);
    expect(second.credits).toBe(0);

    const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, u));
    expect(subs).toHaveLength(1);
    const balance = await svc.balanceFor(u);
    expect(balance.available).toBe(4500);
  });

  it('concurrent subscribe webhooks create one subscription and one cycle grant', async () => {
    const u = await makeUser();
    const paymentId = `sub-race-${nid()}`;
    await makeSubscriptionOrder(u, paymentId, { tier: 'start' });

    const outcomes = await Promise.allSettled([
      _internal.applyPaymentSucceeded(paymentId),
      _internal.applyPaymentSucceeded(paymentId),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(2);
    expect(await db.select().from(subscriptions).where(eq(subscriptions.userId, u))).toHaveLength(
      1,
    );
    expect((await svc.balanceFor(u)).available).toBe(1175);
  });

  it('duplicate subscribe webhook is idempotent (cycle-1 key dedupes ledger)', async () => {
    const u = await makeUser();
    const paymentId = `subtest-${nid()}`;
    const orderId = await makeSubscriptionOrder(u, paymentId, { tier: 'creator' });
    await _internal.applyPaymentSucceeded(paymentId);
    // second call: order is now paid but ledger key has been seen — credits
    // should remain at 4500, not double.
    const b1 = await svc.balanceFor(u);
    expect(b1.available).toBe(4500);
    // The applyPaymentSucceeded "subscribe" branch inserts a fresh
    // subscriptions row on every call, so re-running it would create a
    // second sub. We simulate the webhook layer's behaviour: it'll only
    // re-fire if the order is still pending. Once it's paid, the
    // webhook handler short-circuits the call. We assert the ledger
    // idempotency directly by re-issuing the same grant key and the same
    // source-order identity; a changed source order must be a conflict.
    await expect(
      svc.grant({
        userId: u,
        amount: 4500,
        account: 'subscription_grant',
        reason: 'subscription.subscribe',
        sourceOrderId: orderId,
        idempotencyKey: `sub:${(await db.select().from(subscriptions).where(eq(subscriptions.userId, u)).limit(1))[0]!.id}:cycle:1`,
      }),
    ).resolves.toBeDefined();
    const b2 = await svc.balanceFor(u);
    expect(b2.available).toBe(4500);
  });
});

describe('paid media storage and immediate cancellation', () => {
  it('keeps the legacy paid tier signal without a subscription, while plain free is 30-day', async () => {
    const u = await makeUser();
    expect(await hasPaidMediaStorage(db, u, new Date())).toBe(false);
    const app = buildSubApp(u);
    expect((await app.inject({ method: 'GET', url: '/v1/billing/media-storage' })).json()).toEqual({
      paid: false,
    });
    await db.update(usersApp).set({ tier: 'max' }).where(eq(usersApp.id, u));
    expect(await hasPaidMediaStorage(db, u, new Date())).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/v1/billing/media-storage' })).json()).toEqual({
      paid: true,
    });
    await app.close();
  });

  it('immediate cancel resets only live permanent media to 30 days', async () => {
    const u = await makeUser();
    const now = Date.now();
    const liveId = nid();
    const deletedId = nid();
    await db.insert(galleryItems).values([
      {
        id: liveId,
        userId: u,
        assetUrl: `https://assets.seed.test/${liveId}.png`,
        kind: 'image',
        expiresAt: null,
      },
      {
        id: deletedId,
        userId: u,
        assetUrl: `https://assets.seed.test/${deletedId}.png`,
        kind: 'image',
        expiresAt: null,
        deletedAt: new Date(),
      },
    ]);
    await db.insert(subscriptions).values({
      id: nid(),
      userId: u,
      tier: 'start',
      status: 'active',
      currentPeriodStart: new Date(now - 31 * 86_400_000),
      currentPeriodEnd: new Date(now - 1_000),
      cancelAtPeriodEnd: false,
      cycleNumber: 1,
      priceRub: 490,
      creditsPerCycle: 1175,
    });

    const response = await buildSubApp(u).inject({
      method: 'POST',
      url: '/v1/billing/cancel-subscription',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, status: 'canceled' });
    const rows = await db
      .select({ id: galleryItems.id, expiresAt: galleryItems.expiresAt })
      .from(galleryItems)
      .where(inArray(galleryItems.id, [liveId, deletedId]));
    expect(rows.find((row) => row.id === liveId)?.expiresAt?.getTime()).toBeGreaterThan(
      now + 29 * 86_400_000,
    );
    expect(rows.find((row) => row.id === deletedId)?.expiresAt).toBeNull();
  });

  it('canceling one elapsed subscription keeps media permanent while another is active', async () => {
    const u = await makeUser();
    const assetId = nid();
    const now = Date.now();
    await db.insert(galleryItems).values({
      id: assetId,
      userId: u,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
      expiresAt: null,
    });
    await db.insert(subscriptions).values([
      {
        id: nid(),
        userId: u,
        tier: 'start',
        status: 'active',
        currentPeriodStart: new Date(now - 86_400_000),
        currentPeriodEnd: new Date(now + 10 * 86_400_000),
        cancelAtPeriodEnd: false,
        cycleNumber: 1,
        priceRub: 490,
        creditsPerCycle: 1175,
        createdAt: new Date(now - 10_000),
      },
      {
        id: nid(),
        userId: u,
        tier: 'plus',
        status: 'active',
        currentPeriodStart: new Date(now - 31 * 86_400_000),
        currentPeriodEnd: new Date(now - 1_000),
        cancelAtPeriodEnd: false,
        cycleNumber: 1,
        priceRub: 990,
        creditsPerCycle: 2500,
        createdAt: new Date(now),
      },
    ]);

    const response = await buildSubApp(u).inject({
      method: 'POST',
      url: '/v1/billing/cancel-subscription',
    });
    expect(response.statusCode).toBe(200);
    expect(
      (await db.select().from(galleryItems).where(eq(galleryItems.id, assetId)))[0]?.expiresAt,
    ).toBeNull();
  });
});

describe('subscription cycle worker', () => {
  let redis: IORedis;
  beforeAll(() => {
    redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
  });
  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.del('seed:sub-cycle:leader');
  });

  it('renews due subs that opted in (cancelAtPeriodEnd=false)', async () => {
    const u = await makeUser();
    const subId = nid();
    const past = new Date(Date.now() - 60_000);
    await db.insert(subscriptions).values({
      id: subId,
      userId: u,
      tier: 'start',
      status: 'active',
      currentPeriodStart: new Date(past.getTime() - 30 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: past,
      cancelAtPeriodEnd: false,
      cycleNumber: 1,
      priceRub: 490,
      creditsPerCycle: 1200,
    });
    // Seed first cycle grant so the ledger isn't empty (mirrors real life).
    await svc.grant({
      userId: u,
      amount: 1200,
      account: 'subscription_grant',
      reason: 'subscription.subscribe',
      idempotencyKey: `sub:${subId}:cycle:1`,
    });

    const handle = startSubscriptionCycle({
      log: pino({ level: 'silent' }),
      redis,
      intervalMs: 60_000,
      firstTickDelayMs: 100_000_000,
    });
    const out = await handle.tick();
    handle.stop();
    expect(out.renewed).toBe(1);
    expect(out.expired).toBe(0);
    const after = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(after[0]!.cycleNumber).toBe(2);
    expect(after[0]!.currentPeriodEnd.getTime()).toBeGreaterThan(Date.now());
    const balance = await svc.balanceFor(u);
    expect(balance.available).toBe(2400); // 1200 (initial) + 1200 (renewal)
  });

  it('does not renew a W6 comped subscription created through the admin route', async () => {
    const u = await makeUser();
    const previousAdmins = process.env.ADMIN_USER_IDS;
    process.env.ADMIN_USER_IDS = u;
    const app = Fastify({ logger: false });
    setupAdminPanelRoutes(app, async () => ({ user: { id: u } }));
    await app.ready();
    try {
      const created = await app.inject({
        method: 'POST',
        url: `/v1/admin/users/${u}/subscription`,
        payload: { tier: 'start' },
      });
      expect(created.statusCode).toBe(201);
      const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, u));
      expect(sub!.cancelAtPeriodEnd).toBe(true);
      await db
        .update(subscriptions)
        .set({ currentPeriodEnd: new Date(Date.now() - 60_000) })
        .where(eq(subscriptions.id, sub!.id));
      const creditsBefore = await svc.balanceFor(u);

      const handle = startSubscriptionCycle({
        log: pino({ level: 'silent' }),
        redis,
        intervalMs: 60_000,
        firstTickDelayMs: 100_000_000,
      });
      const out = await handle.tick();
      handle.stop();

      expect(out.expired).toBe(1);
      expect(out.renewed).toBe(0);
      // The comp invariant: no stub-paid renewal order and no extra cycle grant.
      expect(await db.select().from(orders).where(eq(orders.userId, u))).toHaveLength(0);
      expect(await svc.balanceFor(u)).toEqual(creditsBefore);
    } finally {
      if (previousAdmins === undefined) delete process.env.ADMIN_USER_IDS;
      else process.env.ADMIN_USER_IDS = previousAdmins;
      await app.close();
    }
  });

  it('Tochka cycle expires opted-out due subs without charging or requiring a saved card', async () => {
    const u = await makeUser();
    const subId = nid();
    const past = new Date(Date.now() - 60_000);
    await db.insert(subscriptions).values({
      id: subId,
      userId: u,
      tier: 'start',
      status: 'active',
      currentPeriodStart: new Date(past.getTime() - 30 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: past,
      cancelAtPeriodEnd: true,
      cycleNumber: 1,
      priceRub: 599,
      creditsPerCycle: 1175,
    });

    const previousProvider = process.env.BILLING_PROVIDER;
    vi.stubEnv('BILLING_PROVIDER', 'tochka');
    const handle = startSubscriptionCycle({
      log: pino({ level: 'silent' }),
      redis,
      intervalMs: 60_000,
      firstTickDelayMs: 100_000_000,
    });
    let out: { renewed: number; expired: number };
    try {
      out = await handle.tick();
    } finally {
      handle.stop();
      if (previousProvider === undefined) delete process.env.BILLING_PROVIDER;
      else process.env.BILLING_PROVIDER = previousProvider;
    }

    expect(out!.expired).toBe(1);
    expect(out!.renewed).toBe(0);
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(row!.status).toBe('expired');
    expect(
      await db.select({ id: orders.id }).from(orders).where(eq(orders.userId, u)),
    ).toHaveLength(0);
  });

  it('keeps an ambiguous Tochka renewal pending so its later webhook can settle it', async () => {
    const u = await makeUser();
    const subId = nid();
    const past = new Date(Date.now() - 60_000);
    await db.insert(subscriptions).values({
      id: subId,
      userId: u,
      tier: 'start',
      status: 'active',
      currentPeriodStart: new Date(past.getTime() - 30 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: past,
      cancelAtPeriodEnd: false,
      cycleNumber: 1,
      priceRub: 490,
      creditsPerCycle: 1200,
      pspSubscriptionId: `tochka-sub-${nid()}`,
    });

    const paymentId = `tochka-renewal-${nid()}`;
    const chargeSubscription = vi.fn().mockRejectedValue(new Error('request timed out after 30s'));
    const getPaymentInfo = vi.fn().mockResolvedValue({
      Data: {
        Operation: [
          {
            operationId: paymentId,
            status: { value: 'COMPLETED' },
            amount: { amount: '490.00', currency: 'RUB' },
          },
        ],
      },
    });
    const tochka = { chargeSubscription, getPaymentInfo } as unknown as TochkaPaymentProvider;
    const previousProvider = process.env.BILLING_PROVIDER;
    vi.stubEnv('BILLING_PROVIDER', 'tochka');
    const handle = startSubscriptionCycle({
      log: pino({ level: 'silent' }),
      redis,
      tochkaProvider: tochka,
      intervalMs: 60_000,
      firstTickDelayMs: 100_000_000,
    });
    let orderId: string;
    try {
      const out = await handle.tick();
      expect(out).toEqual({ renewed: 0, expired: 0 });
      const [pending] = await db
        .select()
        .from(orders)
        .where(and(eq(orders.userId, u), eq(orders.kind, 'subscription')))
        .limit(1);
      expect(pending).toMatchObject({
        ourStatus: 'pending',
        pspStatus: 'charge_unknown',
        pspPaymentId: null,
      });
      orderId = pending!.id;
      expect((pending!.metadata as Record<string, unknown>).paymentLinkId).toBe(orderId);
      expect(chargeSubscription).toHaveBeenCalledTimes(1);

      // The signed acquiring webhook arrives after the charge call timed out.
      // Metadata attribution + provider verification must now deliver the cycle.
      _internal._setTochkaAdapter(tochka);
      const settled = await _internal.applyPaymentSucceeded(paymentId, orderId);
      expect(settled).toMatchObject({ granted: true, orderId, credits: 0 });
      const [paid] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(paid).toMatchObject({
        ourStatus: 'paid',
        pspStatus: 'succeeded',
        pspPaymentId: paymentId,
      });
      const [afterSub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
      expect(afterSub).toMatchObject({ status: 'active', cycleNumber: 2 });
      expect((await svc.balanceFor(u)).available).toBe(1200);
      expect(getPaymentInfo).toHaveBeenCalledWith(paymentId);
    } finally {
      handle.stop();
      _internal._setTochkaAdapter(null);
      if (previousProvider === undefined) delete process.env.BILLING_PROVIDER;
      else process.env.BILLING_PROVIDER = previousProvider;
    }
  });

  it('double-tick is idempotent on the renewal grant', async () => {
    const u = await makeUser();
    const subId = nid();
    const past = new Date(Date.now() - 60_000);
    await db.insert(subscriptions).values({
      id: subId,
      userId: u,
      tier: 'start',
      status: 'active',
      currentPeriodStart: new Date(past.getTime() - 30 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: past,
      cancelAtPeriodEnd: false,
      cycleNumber: 1,
      priceRub: 490,
      creditsPerCycle: 1200,
    });

    const handle = startSubscriptionCycle({
      log: pino({ level: 'silent' }),
      redis,
      intervalMs: 60_000,
      firstTickDelayMs: 100_000_000,
    });
    await handle.tick();
    const balanceAfterFirst = (await svc.balanceFor(u)).available;
    expect(balanceAfterFirst).toBe(1200);

    const [renewalOrder] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.userId, u), eq(orders.kind, 'subscription')))
      .limit(1);
    expect(renewalOrder).toBeDefined();

    // Force the row's period back into the past + reset leader lock to
    // simulate the worker firing the next cycle. We assert idempotency by
    // using the SAME cycleNumber key — the worker's nextCycle advances on
    // success, so the only way to double-grant would be a re-run with the
    // already-committed nextCycle key. Re-grant with the same key:
    await svc.grant({
      userId: u,
      amount: 1200,
      account: 'subscription_grant',
      reason: 'subscription.cycle.renewal',
      sourceOrderId: renewalOrder!.id,
      idempotencyKey: `sub:${subId}:cycle:2`,
    });
    const balanceAfter = (await svc.balanceFor(u)).available;
    expect(balanceAfter).toBe(1200);
    handle.stop();
  });

  it('period-drift fix: 5-day-overdue renewal ends 30 days past oldEnd, not 30 days from now (audit #6)', async () => {
    const u = await makeUser();
    const subId = nid();
    // Subscription ended 5 days ago.
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const thirtyFiveDaysAgo = new Date(fiveDaysAgo.getTime() - 30 * 24 * 60 * 60 * 1000);
    await db.insert(subscriptions).values({
      id: subId,
      userId: u,
      tier: 'start',
      status: 'active',
      currentPeriodStart: thirtyFiveDaysAgo,
      currentPeriodEnd: fiveDaysAgo,
      cancelAtPeriodEnd: false,
      cycleNumber: 1,
      priceRub: 490,
      creditsPerCycle: 1200,
    });
    // Seed first cycle grant so ledger is consistent.
    await svc.grant({
      userId: u,
      amount: 1200,
      account: 'subscription_grant',
      reason: 'subscription.subscribe',
      idempotencyKey: `sub:${subId}:cycle:1`,
    });

    const handle = startSubscriptionCycle({
      log: pino({ level: 'silent' }),
      redis,
      intervalMs: 60_000,
      firstTickDelayMs: 100_000_000,
    });
    const out = await handle.tick();
    handle.stop();
    expect(out.renewed).toBe(1);

    const after = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    const newEnd = after[0]!.currentPeriodEnd.getTime();
    const expectedEnd = fiveDaysAgo.getTime() + 30 * 24 * 60 * 60 * 1000;
    // New period end must be ~30 days past oldEnd (within 5s tolerance for test timing).
    expect(Math.abs(newEnd - expectedEnd)).toBeLessThan(5_000);
    // Must NOT be 30 days from now (which would be ~25 days from oldEnd + 5day drift).
    const thirtyDaysFromNow = Date.now() + 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(newEnd - thirtyDaysFromNow)).toBeGreaterThan(4 * 24 * 60 * 60 * 1000);
  });

  it('does not renew subs that are not yet due', async () => {
    const u = await makeUser();
    const subId = nid();
    const future = new Date(Date.now() + 60_000);
    await db.insert(subscriptions).values({
      id: subId,
      userId: u,
      tier: 'start',
      status: 'active',
      currentPeriodStart: new Date(Date.now() - 1_000),
      currentPeriodEnd: future,
      cancelAtPeriodEnd: false,
      cycleNumber: 1,
      priceRub: 490,
      creditsPerCycle: 1200,
    });
    const handle = startSubscriptionCycle({
      log: pino({ level: 'silent' }),
      redis,
      intervalMs: 60_000,
      firstTickDelayMs: 100_000_000,
    });
    const out = await handle.tick();
    handle.stop();
    expect(out.renewed).toBe(0);
    expect(out.expired).toBe(0);
  });
});

describe('applyPaymentSucceeded — upgrade order', () => {
  it('grants prorated credits and flips subscription tier', async () => {
    const u = await makeUser();
    // First, create an active 'start' subscription via the subscribe path.
    const subPaymentId = `up-base-${nid()}`;
    await makeSubscriptionOrder(u, subPaymentId, { tier: 'start' });
    await _internal.applyPaymentSucceeded(subPaymentId);
    const subRows = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, u), inArray(subscriptions.status, ['active'])))
      .limit(1);
    const sub = subRows[0]!;

    // Upgrade order with 30 prorated days remaining (max upgrade window).
    const upPaymentId = `up-${nid()}`;
    await makeSubscriptionOrder(u, upPaymentId, {
      tier: 'creator',
      purpose: 'upgrade',
      amountRub: 1000,
      metadata: {
        purpose: 'upgrade',
        subscriptionId: sub.id,
        fromTier: 'start',
        toTier: 'creator',
        proratedDays: 30,
      },
    });
    const out = await _internal.applyPaymentSucceeded(upPaymentId);
    expect(out.kind).toBe('subscription');
    // (4500 - 1175) * 30 / 30 = 3325 prorated credits (Старт=1175 in the 5-tier grid).
    expect(out.credits).toBe(3325);

    const after = await db.select().from(subscriptions).where(eq(subscriptions.id, sub.id));
    expect(after[0]!.tier).toBe('creator');
    expect(after[0]!.priceRub).toBe(1490);
    expect(after[0]!.creditsPerCycle).toBe(4500);

    const balance = await svc.balanceFor(u);
    expect(balance.available).toBe(1175 + 3325); // initial 1175 + prorated 3325
  });

  it('clears expiry only for live media when the referenced subscription remains paid', async () => {
    const u = await makeUser();
    const subPaymentId = `up-live-base-${nid()}`;
    await makeSubscriptionOrder(u, subPaymentId, { tier: 'start' });
    await _internal.applyPaymentSucceeded(subPaymentId);
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, u)).limit(1);
    const liveId = nid();
    const deletedId = nid();
    const expiry = new Date(Date.now() + 86_400_000);
    await db.insert(galleryItems).values([
      { id: liveId, userId: u, assetUrl: `https://x/${liveId}`, kind: 'image', expiresAt: expiry },
      {
        id: deletedId,
        userId: u,
        assetUrl: `https://x/${deletedId}`,
        kind: 'image',
        expiresAt: expiry,
        deletedAt: new Date(),
      },
    ]);
    const paymentId = `up-live-${nid()}`;
    await makeSubscriptionOrder(u, paymentId, {
      tier: 'creator',
      purpose: 'upgrade',
      metadata: { purpose: 'upgrade', subscriptionId: sub!.id, proratedDays: 1 },
    });
    await _internal.applyPaymentSucceeded(paymentId);
    const assets = await db
      .select({ id: galleryItems.id, expiresAt: galleryItems.expiresAt })
      .from(galleryItems)
      .where(inArray(galleryItems.id, [liveId, deletedId]));
    expect(assets.find((row) => row.id === liveId)?.expiresAt).toBeNull();
    expect(assets.find((row) => row.id === deletedId)?.expiresAt).toEqual(expiry);
  });

  it('a delayed upgrade after cancellation does not make media permanent', async () => {
    const u = await makeUser();
    const subPaymentId = `up-cancel-base-${nid()}`;
    await makeSubscriptionOrder(u, subPaymentId, { tier: 'start' });
    await _internal.applyPaymentSucceeded(subPaymentId);
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, u)).limit(1);
    await db.update(subscriptions).set({ status: 'canceled' }).where(eq(subscriptions.id, sub!.id));
    const assetId = nid();
    const expiry = new Date(Date.now() + 86_400_000);
    await db.insert(galleryItems).values({
      id: assetId,
      userId: u,
      assetUrl: `https://x/${assetId}`,
      kind: 'image',
      expiresAt: expiry,
    });
    const paymentId = `up-cancel-${nid()}`;
    await makeSubscriptionOrder(u, paymentId, {
      tier: 'creator',
      purpose: 'upgrade',
      metadata: { purpose: 'upgrade', subscriptionId: sub!.id, proratedDays: 1 },
    });
    await expect(_internal.applyPaymentSucceeded(paymentId)).rejects.toMatchObject({
      name: 'UnsettleableOrderError',
    });
    const [unchanged] = await db.select().from(subscriptions).where(eq(subscriptions.id, sub!.id));
    expect(unchanged!.tier).toBe('start');
    const [pending] = await db.select().from(orders).where(eq(orders.pspPaymentId, paymentId));
    expect(pending!.ourStatus).toBe('pending');
    expect(
      (await db.select().from(galleryItems).where(eq(galleryItems.id, assetId)))[0]?.expiresAt,
    ).toEqual(expiry);
  });

  // A customer may legitimately climb the ladder twice inside ONE paid month:
  // Старт → Плюс on the 3rd, Плюс → Про on the 10th. `cycleNumber` only advances
  // at renewal, so both settlements land in cycle 1 and the ledger key must still
  // separate them — otherwise the SECOND upgrade is charged and deduped away.
  it('two upgrades inside ONE billing cycle each grant their own prorated credits', async () => {
    const u = await makeUser();
    const subPaymentId = `two-up-base-${nid()}`;
    await makeSubscriptionOrder(u, subPaymentId, { tier: 'start' });
    await _internal.applyPaymentSucceeded(subPaymentId);
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, u)).limit(1);
    expect(sub!.cycleNumber).toBe(1);
    expect((await svc.balanceFor(u)).available).toBe(1175);

    const app = buildSubApp(u);

    // Upgrade #1 — Старт → Плюс, priced by the real endpoint and settled by the
    // real webhook path (the stub PSP mints pspPaymentId = `stub-${orderId}`).
    const first = await app.inject({
      method: 'POST',
      url: '/v1/billing/upgrade',
      payload: { newTier: 'plus' },
    });
    expect(first.statusCode).toBe(201);
    const firstOrderId = JSON.parse(first.body).orderId as string;
    const firstOut = await _internal.applyPaymentSucceeded(`stub-${firstOrderId}`);
    // (4400 − 1175) × 30/30 = 3225.
    expect(firstOut.credits).toBe(3225);
    expect((await svc.balanceFor(u)).available).toBe(1175 + 3225);

    // Upgrade #2 — Плюс → Про, one week later, still cycle 1.
    const second = await app.inject({
      method: 'POST',
      url: '/v1/billing/upgrade',
      payload: { newTier: 'pro' },
    });
    expect(second.statusCode).toBe(201);
    const secondBody = JSON.parse(second.body);
    const secondOrderId = secondBody.orderId as string;
    expect(secondBody.proratedAmount).toBeGreaterThan(1); // really was charged
    const secondOut = await _internal.applyPaymentSucceeded(`stub-${secondOrderId}`);
    await app.close();

    // Still the same cycle — this is exactly why the two grants used to collide.
    const [afterSub] = await db.select().from(subscriptions).where(eq(subscriptions.id, sub!.id));
    expect(afterSub!.cycleNumber).toBe(1);
    expect(afterSub!.tier).toBe('pro');
    expect(afterSub!.creditsPerCycle).toBe(10300);

    // (10300 − 4400) × 30/30 = 5900. The customer paid for it; it must be in the
    // ledger, not deduped away against the first upgrade's key.
    expect(secondOut.credits).toBe(5900);
    const proratedRows = await db
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.userId, u),
          eq(creditTransactions.reason, 'subscription.upgrade.prorated'),
        ),
      );
    expect(proratedRows.map((r) => r.amount).sort((a, b) => a - b)).toEqual([3225, 5900]);
    expect(proratedRows.map((r) => r.relatedOrderId).sort()).toEqual(
      [firstOrderId, secondOrderId].sort(),
    );
    expect((await svc.balanceFor(u)).available).toBe(1175 + 3225 + 5900);
  });

  // A REPLAYED webhook for the same upgrade order must still be a no-op. The
  // pending-order short-circuit is the first line of defence; the per-order
  // ledger key is the second, so assert on the ledger, not just the return value.
  it('a replayed upgrade webhook does not grant the prorated credits twice', async () => {
    const u = await makeUser();
    const subPaymentId = `up-replay-base-${nid()}`;
    await makeSubscriptionOrder(u, subPaymentId, { tier: 'start' });
    await _internal.applyPaymentSucceeded(subPaymentId);
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, u)).limit(1);

    const paymentId = `up-replay-${nid()}`;
    await makeSubscriptionOrder(u, paymentId, {
      tier: 'plus',
      purpose: 'upgrade',
      amountRub: 1050,
      metadata: {
        purpose: 'upgrade',
        subscriptionId: sub!.id,
        fromTier: 'start',
        toTier: 'plus',
        proratedDays: 30,
      },
    });
    const first = await _internal.applyPaymentSucceeded(paymentId);
    expect(first.granted).toBe(true);
    expect(first.credits).toBe(3225);

    const replay = await _internal.applyPaymentSucceeded(paymentId);
    expect(replay.granted).toBe(false);
    expect(replay.credits).toBe(0);

    const proratedRows = await db
      .select()
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.userId, u),
          eq(creditTransactions.reason, 'subscription.upgrade.prorated'),
        ),
      );
    expect(proratedRows).toHaveLength(1);
    expect((await svc.balanceFor(u)).available).toBe(1175 + 3225);
  });
});

describe('expired subscription checkout boundary', () => {
  const DAY = 86_400_000;

  async function seedElapsed(
    userId: string,
    opts: {
      status?: 'active' | 'trialing' | 'past_due';
      cancelAtPeriodEnd?: boolean;
      periodEnd?: Date;
    } = {},
  ): Promise<string> {
    const id = nid();
    const periodEnd = opts.periodEnd ?? new Date(Date.now() - DAY);
    await db.insert(subscriptions).values({
      id,
      userId,
      tier: 'start',
      status: opts.status ?? 'active',
      currentPeriodStart: new Date(periodEnd.getTime() - 30 * DAY),
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: opts.cancelAtPeriodEnd ?? true,
      cycleNumber: 1,
      priceRub: 599,
      creditsPerCycle: 1175,
    });
    return id;
  }

  it('retires an opted-out elapsed row before allowing a fresh subscription', async () => {
    const u = await makeUser();
    const subId = await seedElapsed(u);
    const assetId = nid();
    await db.insert(galleryItems).values({
      id: assetId,
      userId: u,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
      expiresAt: null,
    });

    const app = buildSubApp(u);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/subscribe',
      payload: { tier: 'plus' },
    });
    expect(res.statusCode).toBe(201);
    const orderId = JSON.parse(res.body).orderId as string;

    const [old] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(old!.status).toBe('expired');
    const [asset] = await db
      .select({ expiresAt: galleryItems.expiresAt })
      .from(galleryItems)
      .where(eq(galleryItems.id, assetId));
    expect(asset!.expiresAt).toBeInstanceOf(Date);
    expect(asset!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);

    const settled = await _internal.applyPaymentSucceeded(`stub-${orderId}`);
    await app.close();
    expect(settled.granted).toBe(true);
    const rows = await db.select().from(subscriptions).where(eq(subscriptions.userId, u));
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === 'active')).toHaveLength(1);
    expect(rows.find((row) => row.id === subId)?.status).toBe('expired');
    expect(await resolveLivePlanSubscription(db, u)).not.toBeNull();
  });

  it('retires the row and refuses an upgrade instead of creating a 1 ₽ order', async () => {
    const u = await makeUser();
    const subId = await seedElapsed(u);
    const app = buildSubApp(u);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/upgrade',
      payload: { newTier: 'plus' },
    });
    await app.close();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'subscription_expired', subscriptionId: subId });
    expect(
      (await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]!.status,
    ).toBe('expired');
    expect(await db.select().from(orders).where(eq(orders.userId, u))).toHaveLength(0);
  });

  it('leaves a legacy elapsed upgrade payment pending for reconciliation', async () => {
    const u = await makeUser();
    const subId = await seedElapsed(u);
    const paymentId = `legacy-elapsed-upgrade-${nid()}`;
    await makeSubscriptionOrder(u, paymentId, {
      tier: 'plus',
      purpose: 'upgrade',
      amountRub: 1,
      metadata: { purpose: 'upgrade', subscriptionId: subId, proratedDays: 0 },
    });

    await expect(_internal.applyPaymentSucceeded(paymentId)).rejects.toMatchObject({
      name: 'UnsettleableOrderError',
    });
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    const [order] = await db.select().from(orders).where(eq(orders.pspPaymentId, paymentId));
    expect(row!.tier).toBe('start');
    expect(order!.ourStatus).toBe('pending');
  });

  it('does not retire an elapsed subscription while auto-renew is enabled', async () => {
    const u = await makeUser();
    const subId = await seedElapsed(u, { cancelAtPeriodEnd: false });
    const app = buildSubApp(u);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/subscribe',
      payload: { tier: 'plus' },
    });
    await app.close();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'subscription_renewal_pending', subscriptionId: subId });
    expect(
      (await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]!.status,
    ).toBe('active');
    expect(await db.select().from(orders).where(eq(orders.userId, u))).toHaveLength(0);
  });

  it('renew-toggle retires an opted-out elapsed row instead of re-arming renewal', async () => {
    const u = await makeUser();
    const subId = await seedElapsed(u);
    const app = buildSubApp(u);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/renew-toggle',
      payload: { autoRenew: true },
    });
    await app.close();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'subscription_expired', subscriptionId: subId });
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(row!.status).toBe('expired');
    expect(row!.cancelAtPeriodEnd).toBe(true);
  });

  it('renew-toggle keeps an elapsed auto-renew row in explicit recovery state', async () => {
    const u = await makeUser();
    const subId = await seedElapsed(u, { cancelAtPeriodEnd: false });
    const app = buildSubApp(u);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/renew-toggle',
      payload: { autoRenew: true },
    });
    await app.close();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'subscription_renewal_pending', subscriptionId: subId });
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(row!.status).toBe('active');
    expect(row!.cancelAtPeriodEnd).toBe(false);
  });

  it('does not retire an elapsed row while a renewal/upgrade payment is pending', async () => {
    const u = await makeUser();
    const subId = await seedElapsed(u);
    const orderId = nid();
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'subscription',
      tierOrPackId: 'plus',
      amountRub: 100,
      psp: 'yookassa-stub',
      ourStatus: 'pending',
      metadata: { purpose: 'upgrade', subscriptionId: subId, proratedDays: 1 },
    });

    const app = buildSubApp(u);
    const subscribe = await app.inject({
      method: 'POST',
      url: '/v1/billing/subscribe',
      payload: { tier: 'plus' },
    });
    const upgrade = await app.inject({
      method: 'POST',
      url: '/v1/billing/upgrade',
      payload: { newTier: 'plus' },
    });
    await app.close();

    expect(subscribe.statusCode).toBe(409);
    expect(subscribe.json()).toEqual({
      error: 'subscription_payment_pending',
      subscriptionId: subId,
      orderId,
    });
    expect(upgrade.statusCode).toBe(409);
    expect(upgrade.json()).toEqual({
      error: 'subscription_payment_pending',
      subscriptionId: subId,
      orderId,
    });
    expect(
      (await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]!.status,
    ).toBe('active');
  });

  it('keeps a past_due row for payment recovery instead of allowing re-subscribe', async () => {
    const u = await makeUser();
    const subId = await seedElapsed(u, { status: 'past_due', cancelAtPeriodEnd: false });
    const app = buildSubApp(u);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/subscribe',
      payload: { tier: 'plus' },
    });
    await app.close();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'subscription_payment_failed', subscriptionId: subId });
    expect(
      (await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]!.status,
    ).toBe('past_due');
  });
});

describe('scheduled downgrade — schedule / cancel / apply', () => {
  const DAY = 86_400_000;

  async function makeActiveSub(
    userId: string,
    tier: 'pro',
    opts: { periodEnd?: Date; pendingTier?: 'start' | null; cancelAtPeriodEnd?: boolean } = {},
  ): Promise<string> {
    const subId = nid();
    const now = new Date();
    await db.insert(subscriptions).values({
      id: subId,
      userId,
      tier,
      status: 'active',
      currentPeriodStart: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: opts.periodEnd ?? new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: opts.cancelAtPeriodEnd ?? true,
      cycleNumber: 1,
      priceRub: 3799,
      creditsPerCycle: 10300,
      pendingTier: opts.pendingTier ?? null,
    });
    return subId;
  }

  it('POST /v1/billing/downgrade schedules a cheaper tier and enables renewal', async () => {
    const u = await makeUser();
    const subId = await makeActiveSub(u, 'pro', { cancelAtPeriodEnd: true });
    const app = buildSubApp(u);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/downgrade',
      payload: { newTier: 'start' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pendingTier).toBe('start');

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(row!.pendingTier).toBe('start');
    // Scheduling a downgrade turns renewal ON so the change actually applies.
    expect(row!.cancelAtPeriodEnd).toBe(false);
    // No mid-cycle change: tier + snapshot stay on Про until the period ends.
    expect(row!.tier).toBe('pro');
    expect(row!.creditsPerCycle).toBe(10300);
    await app.close();
  });

  it('POST /v1/billing/downgrade retires an opted-out elapsed row instead of re-arming renewal', async () => {
    const u = await makeUser();
    const subId = await makeActiveSub(u, 'pro', {
      periodEnd: new Date(Date.now() - DAY),
      cancelAtPeriodEnd: true,
    });
    const app = buildSubApp(u);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/downgrade',
      payload: { newTier: 'start' },
    });
    await app.close();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'subscription_expired', subscriptionId: subId });
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(row!.status).toBe('expired');
    expect(row!.pendingTier).toBeNull();
    expect(row!.cancelAtPeriodEnd).toBe(true);
  });

  it('POST /v1/billing/downgrade does not re-arm an elapsed auto-renew row', async () => {
    const u = await makeUser();
    const subId = await makeActiveSub(u, 'pro', {
      periodEnd: new Date(Date.now() - DAY),
      cancelAtPeriodEnd: false,
    });
    const app = buildSubApp(u);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/downgrade',
      payload: { newTier: 'start' },
    });
    await app.close();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'subscription_renewal_pending', subscriptionId: subId });
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(row!.status).toBe('active');
    expect(row!.pendingTier).toBeNull();
    expect(row!.cancelAtPeriodEnd).toBe(false);
  });

  it('POST /v1/billing/downgrade rejects a dearer target with not_a_downgrade', async () => {
    const u = await makeUser();
    await makeActiveSub(u, 'pro');
    const app = buildSubApp(u);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/downgrade',
      payload: { newTier: 'max' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('not_a_downgrade');
    await app.close();
  });

  it('POST /v1/billing/cancel-downgrade clears a pending downgrade', async () => {
    const u = await makeUser();
    const subId = await makeActiveSub(u, 'pro', { pendingTier: 'start' });
    const app = buildSubApp(u);
    const res = await app.inject({ method: 'POST', url: '/v1/billing/cancel-downgrade' });
    expect(res.statusCode).toBe(200);
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(row!.pendingTier).toBeNull();
    await app.close();
  });

  it('GET /v1/billing/subscription surfaces the pending downgrade + its title', async () => {
    const u = await makeUser();
    await makeActiveSub(u, 'pro', { pendingTier: 'start' });
    const app = buildSubApp(u);
    const res = await app.inject({ method: 'GET', url: '/v1/billing/subscription' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pendingTier).toBe('start');
    expect(body.pendingTitle).toBe('Старт');
    await app.close();
  });

  it('the cycle worker APPLIES a scheduled downgrade at renewal: tier + credits move to the cheaper plan', async () => {
    const u = await makeUser();
    const past = new Date(Date.now() - 60_000);
    const subId = nid();
    await db.insert(subscriptions).values({
      id: subId,
      userId: u,
      tier: 'pro',
      status: 'active',
      currentPeriodStart: new Date(past.getTime() - 30 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: past, // due
      cancelAtPeriodEnd: false, // renews (downgrade must take effect)
      cycleNumber: 1,
      priceRub: 3799,
      creditsPerCycle: 10300,
      pendingTier: 'start',
    });
    // First-cycle grant so the ledger mirrors real life.
    await svc.grant({
      userId: u,
      amount: 10300,
      account: 'subscription_grant',
      reason: 'subscription.subscribe',
      idempotencyKey: `sub:${subId}:cycle:1`,
    });

    const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    await redis.del('seed:sub-cycle:leader');
    const handle = startSubscriptionCycle({
      log: pino({ level: 'silent' }),
      redis,
      intervalMs: 60_000,
      firstTickDelayMs: 100_000_000,
    });
    const out = await handle.tick();
    handle.stop();
    await redis.quit();

    expect(out.renewed).toBe(1);
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(row!.tier).toBe('start'); // downgrade applied
    expect(row!.priceRub).toBe(599);
    expect(row!.creditsPerCycle).toBe(1175);
    expect(row!.pendingTier).toBeNull(); // cleared
    // The renewal granted the NEW (cheaper) tier's credits, not the old one.
    const balance = await svc.balanceFor(u);
    expect(balance.available).toBe(10300 + 1175);
  });
});

/**
 * W0 — `planAccess` / `planAccessBlock` on GET /v1/billing/subscription.
 *
 * The endpoint answers two different questions from two deliberately different
 * rows, and W0's whole point is that they must not be mixed:
 *
 *   - the TOP-LEVEL row is the MANAGEABLE subscription (`findLifecycleSubscription`,
 *     no period check) — it is what the management card cancels and what the
 *     pricing CTAs act on, so an elapsed subscription must still be returned;
 *   - `planAccess` is the LIVE plan (`resolveLivePlanSubscription`, period checked)
 *     — the one and only answer to "which models may I run", built wholly from
 *     the single row that predicate chose.
 *
 * `planAccessBlock` names the REASON the two disagree, so the client never has
 * to re-derive it and never tells a declined-card customer their plan is over.
 */
describe('W0: plan access on GET /v1/billing/subscription', () => {
  const DAY = 86_400_000;

  interface SeedOpts {
    tier: 'start' | 'creator' | 'plus' | 'pro' | 'studio' | 'max';
    status?: 'active' | 'trialing' | 'past_due' | 'canceled' | 'expired';
    periodEnd: Date;
    createdAt?: Date;
    pendingTier?: 'start' | null;
    priceRub?: number;
  }

  async function seedSubscription(userId: string, opts: SeedOpts): Promise<string> {
    const id = nid();
    await db.insert(subscriptions).values({
      id,
      userId,
      tier: opts.tier,
      status: opts.status ?? 'active',
      currentPeriodStart: new Date(opts.periodEnd.getTime() - 30 * DAY),
      currentPeriodEnd: opts.periodEnd,
      cancelAtPeriodEnd: false,
      cycleNumber: 1,
      priceRub: opts.priceRub ?? 599,
      creditsPerCycle: 1175,
      pendingTier: opts.pendingTier ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    });
    return id;
  }

  async function getSubscription(userId: string) {
    const app = buildSubApp(userId);
    const res = await app.inject({ method: 'GET', url: '/v1/billing/subscription' });
    await app.close();
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as {
      id: string;
      tier: string;
      status: string;
      currentPeriodEnd: string;
      pendingTier: string | null;
      planAccess: {
        tier: string;
        title: string | null;
        priceRub: number;
        currentPeriodEnd: string;
        status: string;
        pendingTier: string | null;
      } | null;
      planAccessBlock: {
        reason: string;
        subscriptionId: string;
        tier: string;
        currentPeriodEnd: string;
      } | null;
    } | null;
  }

  it('a newer ELAPSED row does not shadow an older LIVE one', async () => {
    // The under-grant this whole workstream exists to stop: `createdAt DESC`
    // with no period check hands the newest row to the model pickers, so a
    // subscriber who is paid up on Старт is told they have nothing.
    const u = await makeUser();
    const now = Date.now();
    const livePeriodEnd = new Date(now + 10 * DAY);
    const elapsedPeriodEnd = new Date(now - DAY);
    await seedSubscription(u, {
      tier: 'start',
      status: 'trialing',
      periodEnd: livePeriodEnd,
      createdAt: new Date(now - 10_000),
      priceRub: 599,
      pendingTier: 'start',
    });
    await seedSubscription(u, {
      tier: 'plus',
      status: 'past_due',
      periodEnd: elapsedPeriodEnd,
      createdAt: new Date(now),
      priceRub: 1290,
      pendingTier: null,
    });

    const body = await getSubscription(u);

    expect(body?.planAccess).toEqual({
      tier: 'start',
      title: 'Старт',
      priceRub: 599,
      currentPeriodEnd: livePeriodEnd.toISOString(),
      status: 'trialing',
      pendingTier: 'start',
    });
    expect(body?.planAccessBlock).toBeNull();
    // The manageable row is still the newest one — the management card must be
    // able to cancel the elapsed Плюс subscription.
    expect(body?.tier).toBe('plus');
    expect(body?.status).toBe('past_due');
    expect(body?.currentPeriodEnd).toBe(elapsedPeriodEnd.toISOString());
    expect(body?.pendingTier).toBeNull();
  });

  it('resolves the newest by createdAt when several rows are live at once', async () => {
    // W0's stated ordering rule. Concurrently-live rows come only from the
    // unresolved duplicate-subscribe flow; W1 owns what SHOULD happen there, so
    // this pins today's answer rather than leaving it accidental.
    const u = await makeUser();
    const now = Date.now();
    await seedSubscription(u, {
      tier: 'pro',
      periodEnd: new Date(now + 20 * DAY),
      createdAt: new Date(now - 10_000),
    });
    await seedSubscription(u, {
      tier: 'start',
      periodEnd: new Date(now + 10 * DAY),
      createdAt: new Date(now),
    });

    const body = await getSubscription(u);

    expect(body?.planAccess?.tier).toBe('start');
  });

  it('an elapsed-only subscriber gets planAccess null and a still-manageable row', async () => {
    const u = await makeUser();
    const subId = await seedSubscription(u, {
      tier: 'pro',
      periodEnd: new Date(Date.now() - DAY),
    });

    const body = await getSubscription(u);

    expect(body?.planAccess).toBeNull();
    // Still returned at the top level: the management card exists to close this.
    expect(body?.id).toBe(subId);
    expect(body?.tier).toBe('pro');
    expect(body?.status).toBe('active');
  });

  it('carries the pending downgrade INSIDE planAccess so the object cannot mix rows', async () => {
    const u = await makeUser();
    await seedSubscription(u, {
      tier: 'pro',
      periodEnd: new Date(Date.now() + 10 * DAY),
      pendingTier: 'start',
      priceRub: 3799,
    });

    const body = await getSubscription(u);

    expect(body?.planAccess).toEqual({
      tier: 'pro',
      title: 'Про',
      priceRub: 3799,
      currentPeriodEnd: expect.any(String),
      status: 'active',
      pendingTier: 'start',
    });
  });

  it('reports period_ended when the plan simply ran out', async () => {
    const u = await makeUser();
    const periodEnd = new Date(Date.now() - DAY);
    const subId = await seedSubscription(u, { tier: 'start', periodEnd });

    const body = await getSubscription(u);

    expect(body?.planAccessBlock).toEqual({
      reason: 'period_ended',
      subscriptionId: subId,
      tier: 'start',
      currentPeriodEnd: periodEnd.toISOString(),
    });
  });

  it('reports payment_failed for a past_due row — that subscription is still alive', async () => {
    // Nothing writes `past_due` yet (W3 does), so the row is seeded directly.
    // After W3 this becomes the COMMON cause, and a declined-card customer must
    // never be told their subscription is over.
    const u = await makeUser();
    const subId = await seedSubscription(u, {
      tier: 'plus',
      status: 'past_due',
      periodEnd: new Date(Date.now() - DAY),
    });

    const body = await getSubscription(u);

    expect(body?.planAccess).toBeNull();
    expect(body?.planAccessBlock).toEqual({
      reason: 'payment_failed',
      subscriptionId: subId,
      tier: 'plus',
      currentPeriodEnd: expect.any(String),
    });
  });

  it('reports no block while the plan is live', async () => {
    const u = await makeUser();
    await seedSubscription(u, { tier: 'start', periodEnd: new Date(Date.now() + 10 * DAY) });

    const body = await getSubscription(u);

    expect(body?.planAccess?.tier).toBe('start');
    expect(body?.planAccessBlock).toBeNull();
  });

  it('returns null outright when the user has no subscription row at all', async () => {
    // Unchanged shape — every client already reads `sub.data ?? null`. A null
    // body carries neither a plan nor a block, which is exactly the free state.
    const u = await makeUser();

    expect(await getSubscription(u)).toBeNull();
  });
});

describe('W2-b: cycle bucket remaining on GET /v1/billing/subscription', () => {
  const DAY = 86_400_000;

  async function seedCycleSubscription(
    userId: string,
    opts: { cycleNumber?: number; creditsPerCycle?: number } = {},
  ): Promise<string> {
    const id = nid();
    await db.insert(subscriptions).values({
      id,
      userId,
      tier: 'start',
      status: 'active',
      currentPeriodStart: new Date(Date.now() - DAY),
      currentPeriodEnd: new Date(Date.now() + 29 * DAY),
      cancelAtPeriodEnd: false,
      cycleNumber: opts.cycleNumber ?? 1,
      priceRub: 599,
      creditsPerCycle: opts.creditsPerCycle ?? 100,
    });
    return id;
  }

  async function cycleCreditState(userId: string): Promise<{
    remainingThisCycle: number;
    usedThisCycle: number;
  }> {
    const app = buildSubApp(userId);
    const res = await app.inject({ method: 'GET', url: '/v1/billing/subscription' });
    await app.close();
    expect(res.statusCode).toBe(200);
    // Narrow to the two cycle fields so callers can assert the pair exactly —
    // returning the whole subscription payload would force toMatchObject and
    // stop the assertion from catching an unexpected extra field.
    const body = JSON.parse(res.body) as { remainingThisCycle: number; usedThisCycle: number };
    return {
      remainingThisCycle: body.remainingThisCycle,
      usedThisCycle: body.usedThisCycle,
    };
  }

  it('does not charge a pack spend against this cycle allowance', async () => {
    const u = await makeUser();
    const subscriptionId = await seedCycleSubscription(u);

    // The pack exists first, so this real spend is attributed to the pack bucket.
    await svc.grant({
      userId: u,
      amount: 50,
      account: 'pack_grant',
      origin: 'pack',
      expiresAt: null,
      reason: 'test.cycle-pack',
      idempotencyKey: `cycle-pack:${u}`,
    });
    await svc.reserve({
      userId: u,
      jobId: `cycle-pack-job:${u}`,
      amount: 50,
      reason: 'test.cycle-pack',
      idempotencyKey: `cycle-pack-reserve:${u}`,
    });
    await svc.commit({
      userId: u,
      jobId: `cycle-pack-job:${u}`,
      amount: 50,
      idempotencyKey: `cycle-pack-commit:${u}`,
    });
    await svc.grant({
      userId: u,
      amount: 100,
      account: 'subscription_grant',
      origin: 'subscription',
      expiresAt: new Date(Date.now() + 29 * DAY),
      sourceSubscriptionId: subscriptionId,
      cycleNumber: 1,
      reason: 'test.cycle-base',
      idempotencyKey: `cycle-base:${u}`,
    });

    expect((await cycleCreditState(u)).remainingThisCycle).toBe(100);
  });

  it('sums base + proration and keeps reserved work distinct from consumed work', async () => {
    const u = await makeUser();
    const subscriptionId = await seedCycleSubscription(u);
    const expiresAt = new Date(Date.now() + 29 * DAY);
    await svc.grant({
      userId: u,
      amount: 100,
      account: 'subscription_grant',
      origin: 'subscription',
      expiresAt,
      sourceSubscriptionId: subscriptionId,
      cycleNumber: 1,
      reason: 'test.cycle-base',
      idempotencyKey: `cycle-base:${u}`,
    });
    await svc.grant({
      userId: u,
      amount: 25,
      account: 'subscription_grant',
      origin: 'subscription',
      expiresAt,
      sourceSubscriptionId: subscriptionId,
      cycleNumber: 1,
      reason: 'test.cycle-proration',
      idempotencyKey: `cycle-proration:${u}`,
    });
    await svc.reserve({
      userId: u,
      jobId: `cycle-in-flight:${u}`,
      amount: 10,
      reason: 'test.cycle-in-flight',
      idempotencyKey: `cycle-in-flight-reserve:${u}`,
    });
    await svc.commit({
      userId: u,
      jobId: `cycle-in-flight:${u}`,
      amount: 5,
      idempotencyKey: `cycle-in-flight-commit:${u}`,
    });

    expect(await cycleCreditState(u)).toEqual({ remainingThisCycle: 115, usedThisCycle: 5 });
  });

  it('excludes an expired bucket from this cycle', async () => {
    const u = await makeUser();
    const subscriptionId = await seedCycleSubscription(u);
    await svc.grant({
      userId: u,
      amount: 40,
      account: 'subscription_grant',
      origin: 'subscription',
      expiresAt: new Date(Date.now() - 1_000),
      sourceSubscriptionId: subscriptionId,
      cycleNumber: 1,
      reason: 'test.cycle-expired',
      idempotencyKey: `cycle-expired:${u}`,
    });
    await svc.grant({
      userId: u,
      amount: 100,
      account: 'subscription_grant',
      origin: 'subscription',
      expiresAt: new Date(Date.now() + 29 * DAY),
      sourceSubscriptionId: subscriptionId,
      cycleNumber: 1,
      reason: 'test.cycle-live',
      idempotencyKey: `cycle-live:${u}`,
    });

    expect(await cycleCreditState(u)).toEqual({ remainingThisCycle: 100, usedThisCycle: 0 });
  });

  it('excludes buckets from a different cycle of the same subscription', async () => {
    const u = await makeUser();
    const subscriptionId = await seedCycleSubscription(u);
    const expiresAt = new Date(Date.now() + 29 * DAY);
    await svc.grant({
      userId: u,
      amount: 100,
      account: 'subscription_grant',
      origin: 'subscription',
      expiresAt,
      sourceSubscriptionId: subscriptionId,
      cycleNumber: 1,
      reason: 'test.cycle-current',
      idempotencyKey: `cycle-current:${u}`,
    });
    await svc.grant({
      userId: u,
      amount: 50,
      account: 'subscription_grant',
      origin: 'subscription',
      expiresAt,
      sourceSubscriptionId: subscriptionId,
      cycleNumber: 2,
      reason: 'test.cycle-other',
      idempotencyKey: `cycle-other:${u}`,
    });

    expect((await cycleCreditState(u)).remainingThisCycle).toBe(100);
  });

  it('excludes buckets from a different subscription of the same user', async () => {
    const u = await makeUser();
    const subscriptionId = await seedCycleSubscription(u);
    const expiresAt = new Date(Date.now() + 29 * DAY);
    await svc.grant({
      userId: u,
      amount: 100,
      account: 'subscription_grant',
      origin: 'subscription',
      expiresAt,
      sourceSubscriptionId: subscriptionId,
      cycleNumber: 1,
      reason: 'test.subscription-current',
      idempotencyKey: `subscription-current:${u}`,
    });
    await svc.grant({
      userId: u,
      amount: 60,
      account: 'subscription_grant',
      origin: 'subscription',
      expiresAt,
      sourceSubscriptionId: `different-subscription:${u}`,
      cycleNumber: 1,
      reason: 'test.subscription-other',
      idempotencyKey: `subscription-other:${u}`,
    });

    expect((await cycleCreditState(u)).remainingThisCycle).toBe(100);
  });

  it('uses buckets for a renewed pre-W2-a subscription', async () => {
    const u = await makeUser();
    await db.insert(creditBuckets).values({
      id: nid(),
      userId: u,
      origin: 'legacy',
      priority: 3,
      granted: 300,
      reserved: 0,
      consumed: 0,
      expiresAt: null,
      grantKey: `legacy:renewed:${u}`,
    });
    const subscriptionId = await seedCycleSubscription(u, { cycleNumber: 2 });
    await svc.grant({
      userId: u,
      amount: 125,
      account: 'subscription_grant',
      origin: 'subscription',
      expiresAt: new Date(Date.now() + 29 * DAY),
      sourceSubscriptionId: subscriptionId,
      cycleNumber: 2,
      reason: 'test.renewed-cycle',
      idempotencyKey: `renewed-cycle:${u}`,
    });

    expect((await cycleCreditState(u)).remainingThisCycle).toBe(125);
  });

  it('does not let a grandfathered legacy bucket trigger the fallback', async () => {
    const u = await makeUser();
    await db.insert(creditBuckets).values({
      id: nid(),
      userId: u,
      origin: 'legacy',
      priority: 3,
      granted: 999,
      reserved: 0,
      consumed: 0,
      expiresAt: null,
      grantKey: `legacy:${u}`,
    });
    const subscriptionId = await seedCycleSubscription(u);
    await svc.grant({
      userId: u,
      amount: 125,
      account: 'subscription_grant',
      origin: 'subscription',
      expiresAt: new Date(Date.now() + 29 * DAY),
      sourceSubscriptionId: subscriptionId,
      cycleNumber: 1,
      reason: 'test.after-legacy',
      idempotencyKey: `after-legacy:${u}`,
    });

    expect((await cycleCreditState(u)).remainingThisCycle).toBe(125);
  });
});
