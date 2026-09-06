import 'dotenv/config';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  billingUnresolvedEvents,
  creditPacks,
  creditTransactions,
  db,
  nid,
  orders,
  pool,
  subscriptions,
  subscriptionsCatalog,
  usersApp,
  usersPii,
} from '@seed/db';
import { CreditService } from '@seed/credits';
import { PaymentCreateError, type YooKassaAdapter } from '@seed/provider-yookassa';
import { _internal, setupBillingRoutes } from '../src/billing';
import { setupSubscriptionRoutes } from '../src/subscriptions';

const svc = new CreditService();
const createdUsers: string[] = [];
const packAuthorization = new Map<string, Promise<void>>();

/** The real routes, with a fixed session — the PSP adapter runs in stub mode. */
function buildApp(userId: string): FastifyInstance {
  const app = Fastify();
  setupBillingRoutes(app, async (req) => {
    // Pack checkout is a subscriber-only top-up in production. These intent
    // tests exercise the post-authorization money state machine, so give their
    // fixed session a real live plan before that route runs.
    if (req.url.startsWith('/v1/billing/checkout')) {
      let authorization = packAuthorization.get(userId);
      if (!authorization) {
        authorization = (async () => {
          const start = await catalogTier('start');
          await makeSubscription(userId, 'start', start);
        })();
        packAuthorization.set(userId, authorization);
      }
      await authorization;
    }
    return { user: { id: userId } };
  });
  setupSubscriptionRoutes(app, async () => ({ user: { id: userId } }));
  return app;
}

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'IntentTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `intent+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

async function anActivePack() {
  const [pack] = await db
    .select()
    .from(creditPacks)
    .where(eq(creditPacks.isActive, true))
    .orderBy(creditPacks.sortOrder)
    .limit(1);
  if (!pack) throw new Error('no active credit pack seeded');
  return pack;
}

async function catalogTier(tier: 'start' | 'plus' | 'pro') {
  const [row] = await db
    .select()
    .from(subscriptionsCatalog)
    .where(eq(subscriptionsCatalog.tier, tier))
    .limit(1);
  if (!row) throw new Error(`tier ${tier} not seeded`);
  return row;
}

async function makeSubscription(
  userId: string,
  tier: 'start' | 'plus' | 'pro',
  cat: { priceRub: number; creditsPerCycle: number },
): Promise<string> {
  const id = nid();
  const now = new Date();
  await db.insert(subscriptions).values({
    id,
    userId,
    tier,
    status: 'active',
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: true,
    cycleNumber: 1,
    priceRub: cat.priceRub,
    creditsPerCycle: cat.creditsPerCycle,
  });
  return id;
}

/** An upgrade order that already carries a bound payment, as if created earlier. */
async function makeUpgradeOrder(
  userId: string,
  subscriptionId: string,
  toTier: string,
  amountRub: number,
): Promise<string> {
  const id = nid();
  await db.insert(orders).values({
    id,
    userId,
    kind: 'subscription',
    tierOrPackId: toTier,
    amountRub,
    psp: 'yookassa-stub',
    pspPaymentId: `pay-${id}`,
    pspStatus: 'pending',
    ourStatus: 'pending',
    metadata: { purpose: 'upgrade', subscriptionId, toTier, proratedDays: 30 },
  });
  return id;
}

/**
 * Two racing submits must resolve to ONE subject. The loser is allowed to
 * resume onto the winner's order (201, same id) or be refused (409, same id) —
 * never to open a second one.
 */
function expectOneSubject(
  responses: { statusCode: number; json: () => { orderId?: string | null } }[],
  onlyOrderId: string,
) {
  const codes = responses.map((r) => r.statusCode).sort();
  expect(codes[0]).toBe(201);
  expect([201, 409]).toContain(codes[1]);
  for (const r of responses) expect(r.json().orderId).toBe(onlyOrderId);
}

async function ordersFor(userId: string) {
  return db.select().from(orders).where(eq(orders.userId, userId)).orderBy(orders.createdAt);
}

/** Settle EVERY order the entry point created — the money question is not
 *  "how many rows exist" but "what does the customer end up charged for". */
async function settleAll(userId: string): Promise<void> {
  for (const order of await ordersFor(userId)) {
    if (order.pspPaymentId) await _internal.applyPaymentSucceeded(order.pspPaymentId);
  }
}

beforeEach(async () => {
  createdUsers.length = 0;
  packAuthorization.clear();
  // NOTE: no free_grants_enabled write here. These users are never enrolled
  // (no L0), so grantL3 refuses via not_enrolled regardless of the flag — and
  // a per-test write of the SHARED app-settings row races the parallel
  // packages/credits welcome suite's own flag cases (prepush RED, 2026-09-04).
});

afterEach(async () => {
  for (const id of createdUsers) {
    await db.delete(creditTransactions).where(eq(creditTransactions.userId, id));
    await db.delete(orders).where(eq(orders.userId, id));
    await db.delete(subscriptions).where(eq(subscriptions.userId, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
  await db.delete(billingUnresolvedEvents).where(like(billingUnresolvedEvents.objectId, 'ghost-%'));
});

afterAll(async () => {
  await pool.end();
});

describe('W1-0 — one in-progress intent per user per subject', () => {
  it('pack checkout: two concurrent submits create ONE order and grant the pack once', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    const app = buildApp(u);

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/billing/checkout', payload: { packId: pack.id } }),
      app.inject({ method: 'POST', url: '/v1/billing/checkout', payload: { packId: pack.id } }),
    ]);

    const rows = await ordersFor(u);
    expect(rows).toHaveLength(1);
    // The loser either RESUMES onto the winner's order (still unbound) or is
    // told the checkout is in progress (already bound). Which one depends on
    // the timing of the attach, and both are correct — what must never happen
    // is a second order, a second payment or a second grant.
    expectOneSubject([a, b], rows[0]!.id);

    await settleAll(u);
    expect((await svc.balanceFor(u)).available).toBe(pack.credits);
  });

  it('subscribe: two concurrent submits create ONE order, ONE subscription and ONE cycle grant', async () => {
    const u = await makeUser();
    const start = await catalogTier('start');
    const app = buildApp(u);

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/billing/subscribe', payload: { tier: 'start' } }),
      app.inject({ method: 'POST', url: '/v1/billing/subscribe', payload: { tier: 'start' } }),
    ]);

    const rows = await ordersFor(u);
    expect(rows).toHaveLength(1);
    expectOneSubject([a, b], rows[0]!.id);

    await settleAll(u);
    const subs = await db.select().from(subscriptions).where(eq(subscriptions.userId, u));
    expect(subs).toHaveLength(1);
    expect((await svc.balanceFor(u)).available).toBe(start.creditsPerCycle);
  });

  it('subscribe: two concurrent submits for DIFFERENT tiers still create ONE order', async () => {
    // The subject of a subscribe intent is the user, not the tier: two plans
    // settling would be two subscriptions, and canon §5 says the cheaper one
    // can win the race.
    const u = await makeUser();
    const app = buildApp(u);

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/billing/subscribe', payload: { tier: 'start' } }),
      app.inject({ method: 'POST', url: '/v1/billing/subscribe', payload: { tier: 'pro' } }),
    ]);

    expect(await ordersFor(u)).toHaveLength(1);
    // Different tier: resuming would hand the customer a payment for a plan
    // they did not just choose, so the loser is refused outright.
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
  });

  it('upgrade: two concurrent submits to the SAME target charge once and mutate the sub once', async () => {
    const u = await makeUser();
    const start = await catalogTier('start');
    const pro = await catalogTier('pro');
    const subId = nid();
    const now = new Date();
    await db.insert(subscriptions).values({
      id: subId,
      userId: u,
      tier: 'start',
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: true,
      cycleNumber: 1,
      priceRub: start.priceRub,
      creditsPerCycle: start.creditsPerCycle,
    });
    const app = buildApp(u);

    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/billing/upgrade', payload: { newTier: 'pro' } }),
      app.inject({ method: 'POST', url: '/v1/billing/upgrade', payload: { newTier: 'pro' } }),
    ]);

    const rows = await ordersFor(u);
    expect(rows).toHaveLength(1);
    expectOneSubject([a, b], rows[0]!.id);

    await settleAll(u);
    const paid = (await ordersFor(u)).filter((o) => o.ourStatus === 'paid');
    // The customer is charged exactly once for the upgrade.
    expect(paid.reduce((sum, o) => sum + o.amountRub, 0)).toBe(rows[0]!.amountRub);
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(sub!.tier).toBe('pro');
    expect(sub!.creditsPerCycle).toBe(pro.creditsPerCycle);
  });

  it('upgrade: a SECOND upgrade to a different target is refused, not given its own payment', async () => {
    // Both would be priced off «Старт». If «Про» settled first the «Плюс»
    // payment would arrive with a baseline that no longer exists, grant nothing
    // and rewrite the subscription DOWN. One upgrade in flight per subscription.
    const u = await makeUser();
    const start = await catalogTier('start');
    const subId = await makeSubscription(u, 'start', start);
    const app = buildApp(u);

    const toPlus = await app.inject({
      method: 'POST',
      url: '/v1/billing/upgrade',
      payload: { newTier: 'plus' },
    });
    const toPro = await app.inject({
      method: 'POST',
      url: '/v1/billing/upgrade',
      payload: { newTier: 'pro' },
    });

    expect(toPlus.statusCode).toBe(201);
    expect(toPro.statusCode).toBe(409);
    expect(toPro.json()).toMatchObject({ error: 'checkout_in_progress' });
    const rows = await ordersFor(u);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.intentKey).toBe(`upgrade:${subId}`);
  });

  it('a settlement priced off a superseded baseline never rewrites the subscription downward', async () => {
    // The residual case the unique index cannot reach: two upgrade orders that
    // already exist (created before the constraint, or after a tombstone freed
    // the slot). Whichever order they settle in, the customer must not end up
    // demoted by a payment.
    const u = await makeUser();
    const start = await catalogTier('start');
    const plus = await catalogTier('plus');
    const pro = await catalogTier('pro');
    const subId = await makeSubscription(u, 'start', start);

    const toPlusId = await makeUpgradeOrder(u, subId, 'plus', plus.priceRub - start.priceRub);
    const toProId = await makeUpgradeOrder(u, subId, 'pro', pro.priceRub - start.priceRub);

    // Pro settles first and moves the subscription up.
    const proOut = await _internal.applyPaymentSucceeded(`pay-${toProId}`);
    expect(proOut.granted).toBe(true);
    // Plus then arrives carrying the dead «Старт» baseline.
    await expect(_internal.applyPaymentSucceeded(`pay-${toPlusId}`)).rejects.toThrow(
      /stale upgrade baseline/,
    );

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(sub!.tier).toBe('pro');
    expect(sub!.creditsPerCycle).toBe(pro.creditsPerCycle);
    // Refused, not silently accepted: the order is still pending, so W1-1 can
    // decide whether it is delivered, refunded or superseded.
    const [stale] = await db.select().from(orders).where(eq(orders.id, toPlusId));
    expect(stale!.ourStatus).toBe('pending');
  });

  it('the same pair settling in the OPPOSITE order also never demotes', async () => {
    const u = await makeUser();
    const start = await catalogTier('start');
    const plus = await catalogTier('plus');
    const pro = await catalogTier('pro');
    const subId = await makeSubscription(u, 'start', start);

    const toPlusId = await makeUpgradeOrder(u, subId, 'plus', plus.priceRub - start.priceRub);
    const toProId = await makeUpgradeOrder(u, subId, 'pro', pro.priceRub - start.priceRub);

    // Plus first: a real upgrade from «Старт», so it delivers.
    expect((await _internal.applyPaymentSucceeded(`pay-${toPlusId}`)).granted).toBe(true);
    // Pro second: still strictly above «Плюс», so it also delivers — and the
    // customer ends on the higher tier, never below one they already paid for.
    expect((await _internal.applyPaymentSucceeded(`pay-${toProId}`)).granted).toBe(true);

    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(sub!.tier).toBe('pro');
    expect(sub!.creditsPerCycle).toBe(pro.creditsPerCycle);
  });

  it('an abandoned checkout keeps holding the slot — there is no time-based release', async () => {
    // The 24h expiry an earlier revision had is gone: releasing a claim whose
    // payment may still be payable is exactly how two live payments appear.
    const u = await makeUser();
    const pack = await anActivePack();
    const oldId = nid();
    await db.insert(orders).values({
      id: oldId,
      userId: u,
      kind: 'pack',
      tierOrPackId: pack.id,
      amountRub: pack.priceRub,
      psp: 'yookassa-stub',
      pspPaymentId: `abandoned-${oldId}`,
      pspStatus: 'pending',
      ourStatus: 'pending',
      intentKey: `pack:${pack.id}`,
      createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    });
    const app = buildApp(u);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { packId: pack.id },
    });
    expect(res.statusCode).toBe(409);
    expect(await ordersFor(u)).toHaveLength(1);

    // The provider cancelling the abandoned payment is what frees the subject.
    await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook',
      payload: { event: 'payment.canceled', object: { id: `abandoned-${oldId}` } },
    });
    const retry = await app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { packId: pack.id },
    });
    expect(retry.statusCode).toBe(201);

    // And the customer is charged for exactly one pack even if BOTH settle.
    await settleAll(u);
    expect((await svc.balanceFor(u)).available).toBe(pack.credits);
  });
});

describe('W1-0 — webhook ingestion stops stranding money', () => {
  it('resolves a payment.succeeded by the order id in PSP metadata, with no local psp_payment_id yet', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    const orderId = nid();
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'pack',
      tierOrPackId: pack.id,
      amountRub: pack.priceRub,
      psp: 'yookassa',
      pspPaymentId: null, // the PSP call has not returned yet — intent-first
      ourStatus: 'pending',
      intentKey: `pack:${pack.id}`,
    });
    const app = buildApp(u);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/webhook',
      payload: {
        event: 'payment.succeeded',
        object: {
          id: 'yk-race-1',
          status: 'succeeded',
          metadata: { orderId, userId: u, itemId: pack.id, kind: 'pack' },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toMatchObject({ ignored: 'unknown_payment' });
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(row!.ourStatus).toBe('paid');
    expect(row!.pspPaymentId).toBe('yk-race-1');
    expect((await svc.balanceFor(u)).available).toBe(pack.credits);
  });

  it('retains a genuinely unattributable event for retry instead of acking it away', async () => {
    const u = await makeUser();
    const app = buildApp(u);
    const objectId = `ghost-${nid()}`;
    const payload = {
      event: 'payment.succeeded',
      object: { id: objectId, status: 'succeeded' },
    };

    const first = await app.inject({ method: 'POST', url: '/v1/billing/webhook', payload });
    expect(first.statusCode).toBeGreaterThanOrEqual(500);

    const [retained] = await db
      .select()
      .from(billingUnresolvedEvents)
      .where(
        and(
          eq(billingUnresolvedEvents.event, 'payment.succeeded'),
          eq(billingUnresolvedEvents.objectId, objectId),
        ),
      );
    expect(retained).toBeDefined();
    expect(retained!.attempts).toBe(1);

    const second = await app.inject({ method: 'POST', url: '/v1/billing/webhook', payload });
    expect(second.statusCode).toBeGreaterThanOrEqual(500);
    const [again] = await db
      .select()
      .from(billingUnresolvedEvents)
      .where(eq(billingUnresolvedEvents.objectId, objectId));
    expect(again!.attempts).toBe(2);
  });

  it('drops the retained event once the same event finally resolves', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    const objectId = `ghost-${nid()}`;
    const orderId = nid();
    const app = buildApp(u);
    const payload = {
      event: 'payment.succeeded',
      object: { id: objectId, status: 'succeeded', metadata: { orderId } },
    };

    const missed = await app.inject({ method: 'POST', url: '/v1/billing/webhook', payload });
    expect(missed.statusCode).toBeGreaterThanOrEqual(500);

    // The order row lands late (or the retry outran the checkout's DB write).
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'pack',
      tierOrPackId: pack.id,
      amountRub: pack.priceRub,
      psp: 'yookassa',
      ourStatus: 'pending',
    });
    const retry = await app.inject({ method: 'POST', url: '/v1/billing/webhook', payload });
    expect(retry.statusCode).toBe(200);

    const left = await db
      .select()
      .from(billingUnresolvedEvents)
      .where(eq(billingUnresolvedEvents.objectId, objectId));
    expect(left).toHaveLength(0);
    expect((await svc.balanceFor(u)).available).toBe(pack.credits);
  });
});

describe('W1-0 — intent-first ordering', () => {
  it('the local order row carries its own intent key before the PSP payment is attached', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    const app = buildApp(u);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { packId: pack.id },
    });
    expect(res.statusCode).toBe(201);
    const [row] = await ordersFor(u);
    expect(row!.intentKey).toBe(`pack:${pack.id}`);
    // The stub adapter derives its payment id from OUR order id, which is only
    // possible because the order id existed before the PSP was called.
    expect(row!.pspPaymentId).toBe(`stub-${row!.id}`);
  });

  it('subscribe and upgrade orders carry their own subjects', async () => {
    const u = await makeUser();
    const start = await catalogTier('start');
    const app = buildApp(u);
    await app.inject({ method: 'POST', url: '/v1/billing/subscribe', payload: { tier: 'start' } });
    const [subscribeOrder] = await ordersFor(u);
    expect(subscribeOrder!.intentKey).toBe('subscribe');

    await db.delete(orders).where(eq(orders.userId, u));
    const subId = nid();
    const now = new Date();
    await db.insert(subscriptions).values({
      id: subId,
      userId: u,
      tier: 'start',
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: true,
      cycleNumber: 1,
      priceRub: start.priceRub,
      creditsPerCycle: start.creditsPerCycle,
    });
    await app.inject({ method: 'POST', url: '/v1/billing/upgrade', payload: { newTier: 'pro' } });
    const [upgradeOrder] = await ordersFor(u);
    expect(upgradeOrder!.intentKey).toBe(`upgrade:${subId}`);
  });
});

describe('W1-0 — renewal orders are unaffected', () => {
  it('a system renewal order holds no intent slot', async () => {
    // The cycle worker inserts a paid renewal order directly; it must never
    // collide with a user-initiated intent.
    const u = await makeUser();
    const ids = [nid(), nid()];
    for (const id of ids) {
      await db.insert(orders).values({
        id,
        userId: u,
        kind: 'subscription',
        tierOrPackId: 'start',
        amountRub: 490,
        psp: 'yookassa-stub',
        pspPaymentId: `cycle-${id}`,
        pspStatus: 'succeeded',
        ourStatus: 'paid',
        metadata: { purpose: 'renewal' },
      });
    }
    const rows = await db.select().from(orders).where(inArray(orders.id, ids));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.intentKey === null)).toBe(true);
  });
});

describe('W1-0 — an ambiguous PSP create must not reopen the duplicate window', () => {
  /** A stub that succeeds normally but can be told to fail the create. */
  function faultyAdapter(fail: () => never): YooKassaAdapter {
    return {
      mode: 'stub',
      async createPayment() {
        fail();
      },
      async retrievePayment(providerPaymentId) {
        return { providerPaymentId, status: 'succeeded', amountRub: null };
      },
      verifyWebhook: () => ({ ok: true }),
    };
  }

  afterEach(() => _internal._setAdapter(null));

  it('a create that TIMES OUT keeps the intent claimed, and the retry reuses the same order', async () => {
    // The throw came after ЮKassa may have created the payment. Releasing the
    // subject here is exactly how the customer ends up charged twice.
    const u = await makeUser();
    const pack = await anActivePack();
    _internal._setAdapter(
      faultyAdapter(() => {
        throw new PaymentCreateError('socket hang up', 'unknown');
      }),
    );
    const app = buildApp(u);

    const failed = await app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { packId: pack.id },
    });
    expect(failed.statusCode).toBe(502);

    const [held] = await ordersFor(u);
    expect(held!.intentKey).toBe(`pack:${pack.id}`);
    expect(held!.pspPaymentId).toBeNull();

    // The customer retries. It must land on the SAME order — same PSP
    // idempotency key — not mint a second payment.
    _internal._setAdapter(null);
    const retry = await app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { packId: pack.id },
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().orderId).toBe(held!.id);
    expect(await ordersFor(u)).toHaveLength(1);

    await settleAll(u);
    expect((await svc.balanceFor(u)).available).toBe(pack.credits);
  });

  it('a create the provider REFUSED releases the intent, because no payment can exist', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    _internal._setAdapter(
      faultyAdapter(() => {
        throw new PaymentCreateError('invalid request', 'rejected', 400);
      }),
    );
    const app = buildApp(u);

    const failed = await app.inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { packId: pack.id },
    });
    expect(failed.statusCode).toBe(502);
    const [released] = await ordersFor(u);
    expect(released!.intentKey).toBeNull();
    expect(released!.ourStatus).toBe('pending'); // still settleable, never discarded
  });

  it('an UNEXPECTED throw is treated as unknown, not as a refusal', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    _internal._setAdapter(
      faultyAdapter(() => {
        throw new Error('something we have never reasoned about');
      }),
    );
    const app = buildApp(u);

    await app.inject({ method: 'POST', url: '/v1/billing/checkout', payload: { packId: pack.id } });
    const [held] = await ordersFor(u);
    expect(held!.intentKey).toBe(`pack:${pack.id}`);
  });

  it('subscribe holds its intent on an ambiguous create too', async () => {
    const u = await makeUser();
    _internal._setAdapter(
      faultyAdapter(() => {
        throw new PaymentCreateError('gateway timeout', 'unknown', 504);
      }),
    );
    const app = buildApp(u);

    await app.inject({ method: 'POST', url: '/v1/billing/subscribe', payload: { tier: 'start' } });
    const [held] = await ordersFor(u);
    expect(held!.intentKey).toBe('subscribe');
  });
});

describe('W1-0 — the metadata fallback is not a settlement authority', () => {
  async function unboundPackOrder(userId: string, pack: { id: string; priceRub: number }) {
    const orderId = nid();
    await db.insert(orders).values({
      id: orderId,
      userId,
      kind: 'pack',
      tierOrPackId: pack.id,
      amountRub: pack.priceRub,
      psp: 'yookassa',
      ourStatus: 'pending',
    });
    return orderId;
  }

  it('refuses to grant when the provider does not know the payment', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    const orderId = await unboundPackOrder(u, pack);

    await expect(
      _internal.applyPaymentSucceeded('forged-1', orderId, { retrievePayment: async () => null }),
    ).rejects.toThrow(/not settleable/);

    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(row!.ourStatus).toBe('pending');
    expect(row!.pspPaymentId).toBeNull();
    expect((await svc.balanceFor(u)).available).toBe(0);
  });

  it('refuses to grant when the provider says the payment did not succeed', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    const orderId = await unboundPackOrder(u, pack);

    await expect(
      _internal.applyPaymentSucceeded('pending-1', orderId, {
        retrievePayment: async () => ({ status: 'canceled', amountRub: pack.priceRub }),
      }),
    ).rejects.toThrow(/not settleable/);
    expect((await svc.balanceFor(u)).available).toBe(0);
  });

  it('refuses to grant when the provider amount does not match the order', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    const orderId = await unboundPackOrder(u, pack);

    await expect(
      _internal.applyPaymentSucceeded('cheap-1', orderId, {
        retrievePayment: async () => ({ status: 'succeeded', amountRub: 1 }),
      }),
    ).rejects.toThrow(/not settleable/);
    expect((await svc.balanceFor(u)).available).toBe(0);
  });

  it('refuses to grant when the lookup itself fails — stranding beats a wrong grant', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    const orderId = await unboundPackOrder(u, pack);

    await expect(
      _internal.applyPaymentSucceeded('unreachable-1', orderId, {
        retrievePayment: async () => {
          throw new Error('ECONNRESET');
        },
      }),
    ).rejects.toThrow(/not settleable/);
    expect((await svc.balanceFor(u)).available).toBe(0);
  });

  it('grants once the provider confirms the payment and the amount', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    const orderId = await unboundPackOrder(u, pack);

    const out = await _internal.applyPaymentSucceeded('real-1', orderId, {
      retrievePayment: async () => ({ status: 'succeeded', amountRub: pack.priceRub }),
    });
    expect(out.granted).toBe(true);
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(row!.pspPaymentId).toBe('real-1');
    expect((await svc.balanceFor(u)).available).toBe(pack.credits);
  });

  it('never settles one payment against an order another payment already owns', async () => {
    // The binding race: the order was unbound when the event was resolved, and
    // a real payment bound itself before the settlement transaction ran.
    const u = await makeUser();
    const pack = await anActivePack();
    const orderId = await unboundPackOrder(u, pack);

    await expect(
      _internal.applyPaymentSucceeded('intruder-1', orderId, {
        retrievePayment: async () => {
          // Simulate the real payment binding in the gap between resolve and lock.
          await db
            .update(orders)
            .set({ pspPaymentId: 'the-real-payment' })
            .where(eq(orders.id, orderId));
          return { status: 'succeeded', amountRub: pack.priceRub };
        },
      }),
    ).rejects.toThrow(/not settleable/);

    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(row!.pspPaymentId).toBe('the-real-payment');
    expect(row!.ourStatus).toBe('pending');
    expect((await svc.balanceFor(u)).available).toBe(0);
  });

  it("a forged metadata.orderId pointing at someone else's order grants nothing", async () => {
    const victim = await makeUser();
    const pack = await anActivePack();
    const victimOrder = await unboundPackOrder(victim, pack);

    await expect(
      _internal.applyPaymentSucceeded('forged-2', victimOrder, {
        retrievePayment: async () => null,
      }),
    ).rejects.toThrow(/not settleable/);
    expect((await svc.balanceFor(victim)).available).toBe(0);
  });
});

describe('W1-0 — retention is bounded', () => {
  it('stops asking the provider to retry once the event is parked, but keeps the row', async () => {
    const u = await makeUser();
    const app = buildApp(u);
    const objectId = `ghost-${nid()}`;
    const payload = { event: 'payment.succeeded', object: { id: objectId, status: 'succeeded' } };

    const MAX_RETRIES = 6;
    expect(_internal.MAX_UNRESOLVED_RETRY_ATTEMPTS).toBe(MAX_RETRIES);

    const codes: number[] = [];
    for (let i = 0; i < MAX_RETRIES + 2; i++) {
      const res = await app.inject({ method: 'POST', url: '/v1/billing/webhook', payload });
      codes.push(res.statusCode);
    }
    // Non-2xx while a retry could still resolve the race, then acknowledged.
    expect(codes.slice(0, MAX_RETRIES)).toEqual(new Array(MAX_RETRIES).fill(500));
    expect(codes[codes.length - 1]).toBe(200);

    const [row] = await db
      .select()
      .from(billingUnresolvedEvents)
      .where(eq(billingUnresolvedEvents.objectId, objectId));
    expect(row).toBeDefined();
    expect(row!.attempts).toBe(MAX_RETRIES + 2);
  });
});

describe('W1-0 — a blocked subject is freed only by a provably dead payment', () => {
  /** Counts provider questions so "no network call" is an assertion, not a hope. */
  function probeSpy(answer: () => Promise<{ status: string } | null>) {
    const calls: string[] = [];
    const adapter: YooKassaAdapter = {
      mode: 'stub',
      async createPayment(input) {
        const sep = input.returnUrl.includes('?') ? '&' : '?';
        return {
          confirmationUrl: `${input.returnUrl}${sep}forceSuccess=1`,
          providerPaymentId: `stub-${input.orderId}`,
          status: 'pending',
        };
      },
      async retrievePayment(providerPaymentId) {
        calls.push(providerPaymentId);
        const out = await answer();
        return out && { providerPaymentId, status: out.status, amountRub: null };
      },
      verifyWebhook: () => ({ ok: true }),
    };
    return { adapter, calls };
  }

  /** A bound, abandoned pack order, old enough to be worth asking about. */
  async function abandonedOrder(
    userId: string,
    pack: { id: string; priceRub: number },
    ageMs = 60 * 60 * 1000,
  ): Promise<string> {
    const id = nid();
    await db.insert(orders).values({
      id,
      userId,
      kind: 'pack',
      tierOrPackId: pack.id,
      amountRub: pack.priceRub,
      psp: 'yookassa',
      pspPaymentId: `abandoned-${id}`,
      pspStatus: 'pending',
      ourStatus: 'pending',
      intentKey: `pack:${pack.id}`,
      createdAt: new Date(Date.now() - ageMs),
    });
    return id;
  }

  afterEach(() => _internal._setAdapter(null));

  it('a payment the provider has CANCELED releases the subject and the new checkout proceeds', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    const blockedId = await abandonedOrder(u, pack);
    const { adapter, calls } = probeSpy(async () => ({ status: 'canceled' }));
    _internal._setAdapter(adapter);

    const res = await buildApp(u).inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { packId: pack.id },
    });

    expect(res.statusCode).toBe(201);
    expect(calls).toEqual([`abandoned-${blockedId}`]);
    const [dead] = await db.select().from(orders).where(eq(orders.id, blockedId));
    expect(dead!.ourStatus).toBe('failed'); // tombstoned, which is what frees the index slot
    expect(res.json().orderId).not.toBe(blockedId);
    expect(await ordersFor(u)).toHaveLength(2);
  });

  it('a payment that is still PENDING at the provider keeps the subject held', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    const blockedId = await abandonedOrder(u, pack);
    const { adapter, calls } = probeSpy(async () => ({ status: 'pending' }));
    _internal._setAdapter(adapter);

    const res = await buildApp(u).inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { packId: pack.id },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'checkout_in_progress', orderId: blockedId });
    expect(calls).toHaveLength(1);
    const [held] = await db.select().from(orders).where(eq(orders.id, blockedId));
    expect(held!.ourStatus).toBe('pending');
    expect(await ordersFor(u)).toHaveLength(1);
  });

  it('a payment the provider says SUCCEEDED is never tombstoned', async () => {
    // Money we are about to be told about. Freeing the subject here would let a
    // second purchase run alongside one that is already paid.
    const u = await makeUser();
    const pack = await anActivePack();
    const blockedId = await abandonedOrder(u, pack);
    _internal._setAdapter(probeSpy(async () => ({ status: 'succeeded' })).adapter);

    const res = await buildApp(u).inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { packId: pack.id },
    });

    expect(res.statusCode).toBe(409);
    const [held] = await db.select().from(orders).where(eq(orders.id, blockedId));
    expect(held!.ourStatus).toBe('pending');
  });

  it('FAILS CLOSED: a retrieve that throws leaves the subject held', async () => {
    // The case that matters most. An ambiguous provider answer is never proof
    // that a payment is dead — same principle as the create classifier.
    const u = await makeUser();
    const pack = await anActivePack();
    const blockedId = await abandonedOrder(u, pack);
    const { adapter, calls } = probeSpy(async () => {
      throw new Error('ETIMEDOUT');
    });
    _internal._setAdapter(adapter);

    const res = await buildApp(u).inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { packId: pack.id },
    });

    expect(res.statusCode).toBe(409);
    expect(calls).toHaveLength(1);
    const [held] = await db.select().from(orders).where(eq(orders.id, blockedId));
    expect(held!.ourStatus).toBe('pending');
    expect(held!.intentKey).toBe(`pack:${pack.id}`);
    expect(await ordersFor(u)).toHaveLength(1);
  });

  it('FAILS CLOSED: a payment the provider does not know is not proof of death', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    const blockedId = await abandonedOrder(u, pack);
    _internal._setAdapter(probeSpy(async () => null).adapter);

    const res = await buildApp(u).inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { packId: pack.id },
    });

    expect(res.statusCode).toBe(409);
    const [held] = await db.select().from(orders).where(eq(orders.id, blockedId));
    expect(held!.ourStatus).toBe('pending');
  });

  it('a FRESH in-flight order is refused locally, with no PSP call at all', async () => {
    // The genuine concurrent double-submit. Asking the provider here would put a
    // network round-trip on the hot path for no possible benefit.
    const u = await makeUser();
    const pack = await anActivePack();
    await abandonedOrder(u, pack, 1_000); // one second old
    const { adapter, calls } = probeSpy(async () => ({ status: 'canceled' }));
    _internal._setAdapter(adapter);

    const res = await buildApp(u).inject({
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { packId: pack.id },
    });

    expect(res.statusCode).toBe(409);
    expect(calls).toEqual([]);
  });

  it('the cooldown stops repeated submits from re-asking the provider', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    await abandonedOrder(u, pack);
    const { adapter, calls } = probeSpy(async () => ({ status: 'pending' }));
    _internal._setAdapter(adapter);
    const app = buildApp(u);

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        payload: { packId: pack.id },
      });
      expect(res.statusCode).toBe(409);
    }
    expect(calls).toHaveLength(1);
  });

  it('the cooldown is stamped even when the provider call FAILS, so a sick provider is not hammered', async () => {
    const u = await makeUser();
    const pack = await anActivePack();
    const blockedId = await abandonedOrder(u, pack);
    const { adapter, calls } = probeSpy(async () => {
      throw new Error('ECONNREFUSED');
    });
    _internal._setAdapter(adapter);
    const app = buildApp(u);

    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        payload: { packId: pack.id },
      });
    }
    expect(calls).toHaveLength(1);
    const [probed] = await db.select().from(orders).where(eq(orders.id, blockedId));
    expect(probed!.intentProbedAt).not.toBeNull();
  });

  it('subscribe is freed by a dead payment too', async () => {
    const u = await makeUser();
    const start = await catalogTier('start');
    const blockedId = nid();
    await db.insert(orders).values({
      id: blockedId,
      userId: u,
      kind: 'subscription',
      tierOrPackId: 'start',
      amountRub: start.priceRub,
      psp: 'yookassa',
      pspPaymentId: `abandoned-${blockedId}`,
      pspStatus: 'pending',
      ourStatus: 'pending',
      metadata: { purpose: 'subscribe', tier: 'start' },
      intentKey: 'subscribe',
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    _internal._setAdapter(probeSpy(async () => ({ status: 'canceled' })).adapter);

    const res = await buildApp(u).inject({
      method: 'POST',
      url: '/v1/billing/subscribe',
      payload: { tier: 'start' },
    });

    expect(res.statusCode).toBe(201);
    const [dead] = await db.select().from(orders).where(eq(orders.id, blockedId));
    expect(dead!.ourStatus).toBe('failed');
  });
});
