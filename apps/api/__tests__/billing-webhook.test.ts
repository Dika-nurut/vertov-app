import 'dotenv/config';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import {
  billingRefunds,
  billingUnresolvedEvents,
  creditPacks,
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
// The two L3 cases need free-grants ON. The shared free_grants_enabled app-
// settings row races the parallel packages/credits welcome suite (its own
// kill-switch cases flip it OFF mid-run), so a DB write cannot be trusted.
// Mock the settings module at its PHYSICAL path — that is what
// packages/credits/src/welcome.ts imports directly — for this process only.
vi.mock('../../../packages/credits/src/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../packages/credits/src/settings')>();
  return {
    ...actual,
    readBoolFlag: async (key: string, fallback = false) =>
      key === 'free_grants_enabled' ? true : fallback,
  };
});
import {
  clusterKeyFor,
  CreditService,
  WELCOME_GRANT_AMOUNTS,
  WelcomeGrantService,
} from '@seed/credits';
import type { TochkaPaymentProvider } from '@seed/provider-tochka';
import { _internal, setupBillingRoutes } from '../src/billing';
import { reconcileTochkaRefunds } from '../src/tochka-refund-reconciliation';

const svc = new CreditService();
const welcome = new WelcomeGrantService({ credits: svc });

const createdUsers: string[] = [];
const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'BillingTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `billing+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

async function makeOrder(userId: string, packId: string, paymentId: string): Promise<string> {
  const id = nid();
  await db.insert(orders).values({
    id,
    userId,
    kind: 'pack',
    tierOrPackId: packId,
    amountRub: 199,
    psp: 'yookassa-stub',
    pspPaymentId: paymentId,
    pspStatus: 'pending',
    ourStatus: 'pending',
  });
  return id;
}

beforeEach(async () => {
  createdUsers.length = 0;
});

afterEach(async () => {
  for (const id of createdUsers) {
    const userOrders = await db.select({ id: orders.id }).from(orders).where(eq(orders.userId, id));
    for (const order of userOrders) {
      await db
        .delete(billingUnresolvedEvents)
        .where(eq(billingUnresolvedEvents.orderRef, order.id));
      await db.delete(billingRefunds).where(eq(billingRefunds.orderId, order.id));
    }
    await db.delete(creditTransactions).where(eq(creditTransactions.userId, id));
    await db.delete(orders).where(eq(orders.userId, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
});

afterAll(async () => {
  await pool.end();
});

describe('billing.applyPaymentSucceeded', () => {
  it('verifies a metadata-attributed Tochka payment with the Tochka adapter', async () => {
    const u = await makeUser();
    const orderId = nid();
    const paymentId = `tochka-${nid()}`;
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'pack',
      tierOrPackId: 'pack-200',
      amountRub: 199,
      psp: 'tochka',
      pspPaymentId: null,
      pspStatus: 'pending',
      ourStatus: 'pending',
      metadata: { orderId },
    });
    const getPaymentInfo = vi.fn().mockResolvedValue({
      Data: {
        Operation: [
          {
            operationId: paymentId,
            status: { value: 'COMPLETED' },
            amount: { amount: '199.00', currency: 'RUB' },
          },
        ],
      },
    });
    _internal._setTochkaAdapter({ getPaymentInfo } as unknown as TochkaPaymentProvider);
    try {
      const out = await _internal.applyPaymentSucceeded(paymentId, orderId);
      expect(out).toMatchObject({ granted: true, orderId, credits: 200, kind: 'pack' });
      expect(getPaymentInfo).toHaveBeenCalledWith(paymentId);
      const [settled] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(settled!.pspPaymentId).toBe(paymentId);
      expect(settled!.ourStatus).toBe('paid');
    } finally {
      _internal._setTochkaAdapter(null);
    }
  });

  it('parks a refund webhook without a PSP id for operation-list recovery', async () => {
    const u = await makeUser();
    const orderId = nid();
    const paymentId = `tochka-real-${nid()}`;
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'pack',
      tierOrPackId: 'pack-200',
      amountRub: 199,
      psp: 'tochka',
      pspPaymentId: null,
      pspStatus: 'PAID',
      ourStatus: 'paid',
      metadata: { paymentLinkId: orderId },
    });
    await svc.grant({
      userId: u,
      amount: 200,
      account: 'pack_grant',
      reason: 'pack.purchase',
      sourceOrderId: orderId,
      idempotencyKey: `pack:${orderId}`,
    });

    const webhookPayload = {
      event: 'acquiringInternetPayment',
      Data: {
        Operation: [
          {
            paymentLinkId: orderId,
            status: 'REFUNDED',
            Order: [{ orderId: 'refund-real', type: 'refund', amount: 199 }],
          },
        ],
      },
    };
    process.env.BILLING_PROVIDER = 'tochka';
    _internal._setTochkaAdapter({
      verifyWebhook: () => ({ ok: true, payload: webhookPayload }),
    } as unknown as TochkaPaymentProvider);
    const app = Fastify({ logger: false });
    setupBillingRoutes(app, async () => ({ user: { id: u } }));
    await app.ready();
    try {
      const parked = await app.inject({
        method: 'POST',
        url: '/v1/billing/webhook',
        payload: {},
      });
      expect(parked.statusCode).toBe(500);
      const [before] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(before!.pspPaymentId).toBeNull();
      expect(
        await db.select().from(billingRefunds).where(eq(billingRefunds.orderId, orderId)),
      ).toEqual([]);
      const [event] = await db
        .select()
        .from(billingUnresolvedEvents)
        .where(eq(billingUnresolvedEvents.orderRef, orderId));
      expect(event).toMatchObject({
        event: 'tochka.refund',
        pspPaymentId: null,
        objectId: _internal.tochkaUnboundRefundEventKey(orderId, 'REFUNDED'),
      });

      const provider = {
        getPaymentInfo: async () => {
          throw new Error('unbound recovery must use operation list');
        },
        getPaymentOperationList: async () => ({
          Data: {
            Operation: [
              {
                operationId: paymentId,
                paymentLinkId: orderId,
                status: 'REFUNDED',
                Order: [{ orderId: 'refund-real', type: 'refund', amount: 199 }],
              },
            ],
          },
        }),
        getSubscriptionStatus: async () => ({ Data: { status: 'Cancelled' } }),
        setSubscriptionStatus: async () => undefined,
      } satisfies Pick<
        TochkaPaymentProvider,
        | 'getPaymentInfo'
        | 'getPaymentOperationList'
        | 'getSubscriptionStatus'
        | 'setSubscriptionStatus'
      >;

      const result = await reconcileTochkaRefunds({ provider, batchSize: 1, log: silentLog });
      expect(result).toMatchObject({ checked: 1, refunded: 1, clawedBack: 200, failures: 0 });
      const [after] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(after!.pspPaymentId).toBe(paymentId);
      expect(after!.ourStatus).toBe('refunded');
      expect((await svc.balanceFor(u)).available).toBe(0);
      expect(
        await db
          .select()
          .from(billingUnresolvedEvents)
          .where(eq(billingUnresolvedEvents.orderRef, orderId)),
      ).toHaveLength(0);
    } finally {
      await app.close();
      _internal._setTochkaAdapter(null);
      delete process.env.BILLING_PROVIDER;
    }
  });

  it('uses distinct Tochka refund identifiers for separate partial refunds', () => {
    const first = {
      Data: {
        Operation: [
          {
            operationId: 'payment-1',
            status: 'REFUNDED_PARTIALLY',
            refundUid: 'refund-1',
            amount: '99.50',
          },
        ],
      },
    };
    const second = {
      Data: {
        Operation: [
          {
            operationId: 'payment-1',
            status: 'REFUNDED_PARTIALLY',
            refundUid: 'refund-2',
            amount: '99.50',
          },
        ],
      },
    };
    const firstOp = (first.Data.Operation[0] ?? {}) as Record<string, unknown>;
    const secondOp = (second.Data.Operation[0] ?? {}) as Record<string, unknown>;
    expect(_internal.tochkaRefundKey(first, firstOp, 'payment-1', 'REFUNDED_PARTIALLY')).not.toBe(
      _internal.tochkaRefundKey(second, secondOp, 'payment-1', 'REFUNDED_PARTIALLY'),
    );
  });

  it('expands one Tochka notification into every partial refund row', () => {
    const payload = {
      Data: {
        Operation: [
          {
            operationId: 'payment-1',
            status: 'REFUNDED_PARTIALLY',
            amount: '199.00',
            Order: [
              { orderId: 'refund-a', type: 'refund', amount: '99.50' },
              { orderId: 'refund-b', type: 'refund', amount: { amount: '99.50' } },
            ],
          },
        ],
      },
    };
    const operation = payload.Data.Operation[0] as Record<string, unknown>;
    expect(
      _internal.tochkaRefundEntries(payload, operation, 'REFUNDED_PARTIALLY', 'payment-1'),
    ).toEqual([
      { id: 'refund-a', amountRub: 99.5 },
      { id: 'refund-b', amountRub: 99.5 },
    ]);
  });

  it('prefers per-refund UIDs when rows repeat the parent operation id', () => {
    const payload = {
      Data: {
        Operation: [
          {
            operationId: 'payment-2',
            status: 'REFUNDED_PARTIALLY',
            Order: [
              {
                operationId: 'payment-2',
                type: 'refund',
                refundUid: 'refund-a',
                amount: '99.50',
              },
              {
                operationId: 'payment-2',
                type: 'refund',
                refundUid: 'refund-b',
                amount: '99.50',
              },
            ],
          },
        ],
      },
    };
    const operation = payload.Data.Operation[0] as Record<string, unknown>;
    expect(
      _internal.tochkaRefundEntries(payload, operation, 'REFUNDED_PARTIALLY', 'payment-2'),
    ).toEqual([
      { id: 'refund-a', refundUid: 'refund-a', amountRub: 99.5 },
      { id: 'refund-b', refundUid: 'refund-b', amountRub: 99.5 },
    ]);
  });

  it('grants credits on first call and flips order to paid', async () => {
    const u = await makeUser();
    const paymentId = `test-${nid()}`;
    const orderId = await makeOrder(u, 'pack-200', paymentId);

    const out = await _internal.applyPaymentSucceeded(paymentId);
    expect(out.granted).toBe(true);
    expect(out.orderId).toBe(orderId);
    expect(out.credits).toBe(200);

    const balance = await svc.balanceFor(u);
    expect(balance.available).toBe(200);

    const fresh = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(fresh[0]!.ourStatus).toBe('paid');
  });

  it('duplicate webhook is a no-op (idempotency on payment id)', async () => {
    const u = await makeUser();
    const paymentId = `test-${nid()}`;
    await makeOrder(u, 'pack-1000', paymentId);

    await _internal.applyPaymentSucceeded(paymentId);
    const after1 = await svc.balanceFor(u);
    expect(after1.available).toBe(1000);

    // Simulate ЮKassa retrying the exact same webhook payload.
    await _internal.applyPaymentSucceeded(paymentId);
    const after2 = await svc.balanceFor(u);
    expect(after2.available).toBe(1000);

    // And one more for good measure.
    await _internal.applyPaymentSucceeded(paymentId);
    const after3 = await svc.balanceFor(u);
    expect(after3.available).toBe(1000);
  });

  it('concurrent success webhooks grant a welcome L3 exactly once', async () => {
    const u = await makeUser();
    const paymentId = `test-concurrent-${nid()}`;
    const orderId = await makeOrder(u, 'pack-200', paymentId);
    await welcome.grantL0({ userId: u, clusterKey: clusterKeyFor(`device-${u}`, '203.0.113.9') });

    await Promise.all([
      _internal.applyPaymentSucceeded(paymentId),
      _internal.applyPaymentSucceeded(paymentId),
    ]);

    const grants = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, u));
    expect(grants.filter((row) => row.idempotencyKey === `yk:${paymentId}`)).toHaveLength(1);
    expect(grants.filter((row) => row.idempotencyKey === `welcome:${u}:L3`)).toHaveLength(1);
    expect((await svc.balanceFor(u)).available).toBe(200 + WELCOME_GRANT_AMOUNTS.L0 + 100); // pack + L0 + L3
    expect(
      (await db.select().from(orders).where(eq(orders.id, orderId)).limit(1))[0]!.ourStatus,
    ).toBe('paid');
  });

  it('throws UnknownPaymentError on unknown payment id', async () => {
    await expect(_internal.applyPaymentSucceeded(`missing-${nid()}`)).rejects.toBeInstanceOf(
      _internal.UnknownPaymentError,
    );
  });

  it('order paid + ledger grant land atomically (single tx)', async () => {
    const u = await makeUser();
    const paymentId = `test-${nid()}`;
    const orderId = await makeOrder(u, 'pack-200', paymentId);
    await _internal.applyPaymentSucceeded(paymentId);
    // Both must flip in the same transaction; we verify post-state here
    // (the atomicity is the absence of a window where one updates without
    // the other — replay safety is covered by the duplicate-webhook test).
    const balance = await svc.balanceFor(u);
    const fresh = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    expect(balance.available).toBe(200);
    expect(fresh[0]!.ourStatus).toBe('paid');
    expect(fresh[0]!.paidAt).toBeTruthy();
  });

  it('M2: a payment.succeeded replayed AFTER a refund does NOT re-grant', async () => {
    const u = await makeUser();
    const paymentId = `test-${nid()}`;
    await makeOrder(u, 'pack-200', paymentId);
    // Pay → grant 200.
    await _internal.applyPaymentSucceeded(paymentId);
    expect((await svc.balanceFor(u)).available).toBe(200);
    // Refund → clawback + order flips to 'refunded'.
    await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: `rev:${paymentId}`,
      newStatus: 'refunded',
    });
    expect((await svc.balanceFor(u)).available).toBe(0);
    expect(
      (await db.select().from(orders).where(eq(orders.userId, u)).limit(1))[0]!.ourStatus,
    ).toBe('refunded');
    // A late/replayed success webhook must be a no-op now — not a fresh grant.
    const out = await _internal.applyPaymentSucceeded(paymentId);
    expect(out.granted).toBe(false);
    expect((await svc.balanceFor(u)).available).toBe(0); // NOT re-granted
    expect(
      (await db.select().from(orders).where(eq(orders.userId, u)).limit(1))[0]!.ourStatus,
    ).toBe('refunded');
  });

  it('P0: a refund on a pending order tombstones it before a later success', async () => {
    const u = await makeUser();
    const paymentId = `test-refund-before-success-${nid()}`;
    const orderId = await makeOrder(u, 'pack-200', paymentId);

    await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: `clawback:refund-before-success:${paymentId}`,
      newStatus: 'refunded',
    });

    const tombstone = (await db.select().from(orders).where(eq(orders.id, orderId)).limit(1))[0]!;
    expect(tombstone.ourStatus).toBe('refunded');

    const out = await _internal.applyPaymentSucceeded(paymentId);
    expect(out.granted).toBe(false);
    expect((await svc.balanceFor(u)).available).toBe(0);
  });
});

describe('BL-14: refund/cancel reverses the credit grant', () => {
  it('a full subscription refund revokes the delivered plan and media permanence', async () => {
    const u = await makeUser();
    const paymentId = `test-subscription-refund-${nid()}`;
    const orderId = nid();
    const assetId = nid();
    const originalExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.insert(galleryItems).values({
      id: assetId,
      userId: u,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
      expiresAt: originalExpiry,
    });
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'subscription',
      tierOrPackId: 'start',
      amountRub: 599,
      psp: 'yookassa-stub',
      pspPaymentId: paymentId,
      pspStatus: 'pending',
      ourStatus: 'pending',
      metadata: { purpose: 'subscribe', tier: 'start' },
    });

    await _internal.applyPaymentSucceeded(paymentId);
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, u));
    const paidAsset = (
      await db.select().from(galleryItems).where(eq(galleryItems.id, assetId))
    )[0]!;
    const paidOrder = (await db.select().from(orders).where(eq(orders.id, orderId)))[0]!;
    expect(sub!.status).toBe('active');
    expect(await resolveLivePlanSubscription(db, u)).not.toBeNull();
    expect(paidAsset.expiresAt).toBeNull();
    expect((paidOrder.metadata as Record<string, unknown>).subscriptionId).toBe(sub!.id);

    await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: `clawback:subscription-refund:${paymentId}`,
      newStatus: 'refunded',
    });

    const [revoked] = await db.select().from(subscriptions).where(eq(subscriptions.id, sub!.id));
    const refundedAsset = (
      await db.select().from(galleryItems).where(eq(galleryItems.id, assetId))
    )[0]!;
    expect(revoked!.status).toBe('canceled');
    expect(await resolveLivePlanSubscription(db, u)).toBeNull();
    expect(refundedAsset.expiresAt).toBeInstanceOf(Date);
    expect(refundedAsset.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('grants and revokes paid-media storage without escalating the subscription tier', async () => {
    const u = await makeUser();
    const paymentId = `test-media-entitlement-${nid()}`;
    const assetId = nid();
    const originalExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.insert(galleryItems).values({
      id: assetId,
      userId: u,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
      expiresAt: originalExpiry,
    });
    await makeOrder(u, 'pack-200', paymentId);

    await _internal.applyPaymentSucceeded(paymentId);
    const [paidUser] = await db.select().from(usersApp).where(eq(usersApp.id, u)).limit(1);
    const [promoted] = await db.select().from(galleryItems).where(eq(galleryItems.id, assetId));
    expect(paidUser!.tier).toBe('free');
    expect(await hasPaidMediaStorage(db, u)).toBe(true);
    expect(promoted!.expiresAt).toBeNull();

    await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: `clawback:media-entitlement:${paymentId}`,
      newStatus: 'refunded',
    });
    const [refundedUser] = await db.select().from(usersApp).where(eq(usersApp.id, u)).limit(1);
    const [demoted] = await db.select().from(galleryItems).where(eq(galleryItems.id, assetId));
    expect(refundedUser!.tier).toBe('free');
    expect(await hasPaidMediaStorage(db, u)).toBe(false);
    expect(demoted!.expiresAt).toBeInstanceOf(Date);
    expect(demoted!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('a full refund claws back exactly the granted credits, once (idempotent under retry)', async () => {
    const u = await makeUser();
    const paymentId = `test-${nid()}`;
    await makeOrder(u, 'pack-200', paymentId);
    await _internal.applyPaymentSucceeded(paymentId);
    expect((await svc.balanceFor(u)).available).toBe(200);

    const key = `clawback:order-payment:${paymentId}`;
    const out = await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: key,
      newStatus: 'refunded',
    });
    expect(out).toMatchObject({ clawedBack: 200 });
    expect((await svc.balanceFor(u)).available).toBe(0);

    // YooKassa retries the same refund webhook — must NOT double-claw.
    await _internal.reversePaymentGrant({ paymentId, reversalKey: key, newStatus: 'refunded' });
    await _internal.reversePaymentGrant({ paymentId, reversalKey: key, newStatus: 'refunded' });
    expect((await svc.balanceFor(u)).available).toBe(0);

    const [order] = await db.select().from(orders).where(eq(orders.userId, u)).limit(1);
    expect(order!.ourStatus).toBe('refunded');
    expect(order!.refundedAt).toBeTruthy();
  });

  it('a full refund claws back the order-linked L3 welcome grant too', async () => {
    const u = await makeUser();
    const paymentId = `test-l3-refund-${nid()}`;
    await makeOrder(u, 'pack-200', paymentId);
    await welcome.grantL0({ userId: u, clusterKey: clusterKeyFor(`device-${u}`, '203.0.113.10') });

    await _internal.applyPaymentSucceeded(paymentId);
    expect((await svc.balanceFor(u)).available).toBe(200 + WELCOME_GRANT_AMOUNTS.L0 + 100);

    await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: `clawback:order-payment:${paymentId}`,
      newStatus: 'refunded',
    });

    // Refund claws the pack (200) + the order-linked L3 (100); the L0 is not
    // tied to this order and survives.
    expect((await svc.balanceFor(u)).available).toBe(WELCOME_GRANT_AMOUNTS.L0);
  });

  it('balance goes negative when the refunded credits were already spent', async () => {
    const u = await makeUser();
    const paymentId = `test-${nid()}`;
    await makeOrder(u, 'pack-200', paymentId);
    await _internal.applyPaymentSucceeded(paymentId);
    // Spend 150 of the 200 (reserve + commit use distinct idempotency keys).
    const jobId = nid();
    await svc.reserve({
      userId: u,
      jobId,
      amount: 150,
      reason: 'job.reserve',
      idempotencyKey: `res:${jobId}`,
    });
    await svc.commit({ userId: u, jobId, amount: 150, idempotencyKey: `com:${jobId}` });
    expect((await svc.balanceFor(u)).available).toBe(50);

    await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: `clawback:order-payment:${paymentId}`,
      newStatus: 'refunded',
    });
    // 50 available − 200 clawback = −150 (the user no longer owns spending power).
    expect((await svc.balanceFor(u)).available).toBe(-150);
  });

  it('partial refunds reverse proportionally and never exceed the grant', async () => {
    const u = await makeUser();
    const paymentId = `test-${nid()}`;
    await makeOrder(u, 'pack-1000', paymentId); // amountRub 199, grants 1000
    await _internal.applyPaymentSucceeded(paymentId);
    expect((await svc.balanceFor(u)).available).toBe(1000);

    // Two 50% partial refunds (distinct refund ids).
    await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: 'clawback:refund:rf1',
      newStatus: 'refunded',
      refundedRub: 99.5,
    });
    expect((await svc.balanceFor(u)).available).toBe(500);
    await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: 'clawback:refund:rf2',
      newStatus: 'refunded',
      refundedRub: 99.5,
    });
    expect((await svc.balanceFor(u)).available).toBe(0);

    // A stray extra refund event can't claw below the grant (cap at granted).
    await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: 'clawback:refund:rf3',
      newStatus: 'refunded',
      refundedRub: 99.5,
    });
    expect((await svc.balanceFor(u)).available).toBe(0);
  });

  it('rejects a replay of one refund UID with a changed amount', async () => {
    const u = await makeUser();
    const paymentId = `test-${nid()}`;
    await makeOrder(u, 'pack-1000', paymentId);
    await _internal.applyPaymentSucceeded(paymentId);
    const refundUid = `refund-immutable-${nid()}`;
    await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: 'clawback:refund:immutable',
      refundUid,
      providerRefundId: 'provider-refund-immutable',
      newStatus: 'refunded',
      refundedRub: 99.5,
    });
    await expect(
      _internal.reversePaymentGrant({
        paymentId,
        reversalKey: 'clawback:refund:immutable-replay',
        refundUid,
        providerRefundId: 'provider-refund-immutable',
        newStatus: 'refunded',
        refundedRub: 50,
      }),
    ).rejects.toThrow('amount mismatch');
    expect((await svc.balanceFor(u)).available).toBe(500);
    const [refund] = await db
      .select()
      .from(billingRefunds)
      .where(eq(billingRefunds.refundUid, refundUid));
    expect(refund!.amountRub).toBe('99.50');
    expect(refund!.status).toBe('applied');
  });

  it('terminates a confirmed refund ledger row after a legacy failed cancellation', async () => {
    const u = await makeUser();
    const paymentId = `test-${nid()}`;
    const orderId = await makeOrder(u, 'pack-1000', paymentId);
    await _internal.applyPaymentSucceeded(paymentId);
    await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: 'cancel:legacy',
      newStatus: 'failed',
    });
    expect((await svc.balanceFor(u)).available).toBe(0);

    const out = await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: 'refund:after-failed-cancel',
      refundUid: `refund-${nid()}`,
      newStatus: 'refunded',
      refundedRub: 199,
    });
    expect(out).toEqual({ orderId, clawedBack: 0 });
    const [refund] = await db
      .select()
      .from(billingRefunds)
      .where(eq(billingRefunds.orderId, orderId));
    expect(refund!.status).toBe('applied');
  });

  it('admin refund retries WAITING and REJECTED without premature clawback', async () => {
    const u = await makeUser();
    const paymentId = `tochka-admin-refund-${nid()}`;
    const orderId = nid();
    const refundUid = `admin-refund-${nid().replace(/_/g, '-')}`;
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'pack',
      tierOrPackId: 'pack-1000',
      amountRub: 199,
      psp: 'tochka',
      pspPaymentId: paymentId,
      pspStatus: 'PAID',
      ourStatus: 'paid',
      paidAt: new Date(),
    });
    await svc.grant({
      userId: u,
      amount: 1000,
      account: 'pack_grant',
      reason: 'pack.purchase',
      sourceOrderId: orderId,
      idempotencyKey: `pack:${orderId}`,
    });

    let providerStatus = 'WAITING';
    const refundPayment = vi.fn(async () => ({
      Data: { Operation: [{ status: providerStatus, refundUid }] },
    }));
    process.env.BILLING_PROVIDER = 'tochka';
    process.env.ADMIN_USER_IDS = u;
    _internal._setTochkaAdapter({ refundPayment } as unknown as TochkaPaymentProvider);
    const app = Fastify({ logger: false });
    setupBillingRoutes(app, async () => ({ user: { id: u } }));
    await app.ready();
    try {
      const payload = { orderId, amountRub: 99.5, refundUid };
      const waiting = await app.inject({
        method: 'POST',
        url: '/v1/admin/billing/refund',
        payload,
      });
      expect(waiting.statusCode).toBe(200);
      expect(waiting.json()).toMatchObject({ ok: true, status: 'pending' });
      expect((await svc.balanceFor(u)).available).toBe(1000);
      expect(
        (await db.select().from(billingRefunds).where(eq(billingRefunds.orderId, orderId)))[0]!
          .status,
      ).toBe('pending');

      // An acknowledgement/payment-like status is not proof of a settled card
      // refund. It must remain pending until Tochka reports REFUNDED.
      providerStatus = 'ACCEPTED';
      const accepted = await app.inject({
        method: 'POST',
        url: '/v1/admin/billing/refund',
        payload,
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({ ok: true, status: 'pending' });
      expect((await svc.balanceFor(u)).available).toBe(1000);

      providerStatus = 'REJECTED';
      const rejected = await app.inject({
        method: 'POST',
        url: '/v1/admin/billing/refund',
        payload,
      });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json()).toMatchObject({ ok: false, status: 'rejected' });
      expect((await svc.balanceFor(u)).available).toBe(1000);
      expect(
        (await db.select().from(billingRefunds).where(eq(billingRefunds.orderId, orderId)))[0]!
          .status,
      ).toBe('rejected');
      expect(refundPayment).toHaveBeenCalledTimes(3);
    } finally {
      await app.close();
      _internal._setTochkaAdapter(null);
      delete process.env.BILLING_PROVIDER;
      delete process.env.ADMIN_USER_IDS;
    }
  });

  it('admin full-refund retry is an idempotent success after local apply', async () => {
    const u = await makeUser();
    const paymentId = `tochka-admin-full-refund-${nid()}`;
    const orderId = nid();
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'pack',
      tierOrPackId: 'pack-200',
      amountRub: 199,
      psp: 'tochka',
      pspPaymentId: paymentId,
      pspStatus: 'PAID',
      ourStatus: 'paid',
      paidAt: new Date(),
    });
    await svc.grant({
      userId: u,
      amount: 200,
      account: 'pack_grant',
      reason: 'pack.purchase',
      sourceOrderId: orderId,
      idempotencyKey: `pack:${orderId}`,
    });

    const refundPayment = vi.fn(async () => ({
      Data: { Operation: [{ status: 'REFUNDED', refundUid: 'provider-full-refund' }] },
    }));
    process.env.BILLING_PROVIDER = 'tochka';
    process.env.ADMIN_USER_IDS = u;
    _internal._setTochkaAdapter({ refundPayment } as unknown as TochkaPaymentProvider);
    const app = Fastify({ logger: false });
    setupBillingRoutes(app, async () => ({ user: { id: u } }));
    await app.ready();
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/v1/admin/billing/refund',
        payload: { orderId },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ ok: true, status: 'confirmed' });
      expect((await svc.balanceFor(u)).available).toBe(0);

      const retry = await app.inject({
        method: 'POST',
        url: '/v1/admin/billing/refund',
        payload: { orderId },
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ ok: true, status: 'confirmed' });
      expect(refundPayment).toHaveBeenCalledTimes(1);
      expect((await svc.balanceFor(u)).available).toBe(0);
    } finally {
      await app.close();
      _internal._setTochkaAdapter(null);
      delete process.env.BILLING_PROVIDER;
      delete process.env.ADMIN_USER_IDS;
    }
  });

  it('cancel after a full refund does not double-claw (capped at granted)', async () => {
    const u = await makeUser();
    const paymentId = `test-${nid()}`;
    await makeOrder(u, 'pack-200', paymentId);
    await _internal.applyPaymentSucceeded(paymentId);
    await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: 'clawback:refund:full',
      newStatus: 'refunded',
      refundedRub: 199,
    });
    expect((await svc.balanceFor(u)).available).toBe(0);
    // A late cancel for the same payment — granted already fully reversed.
    const out = await _internal.reversePaymentGrant({
      paymentId,
      reversalKey: `clawback:order-payment:${paymentId}`,
      newStatus: 'failed',
    });
    expect(out).toMatchObject({ clawedBack: 0 });
    expect((await svc.balanceFor(u)).available).toBe(0);
    const [order] = await db
      .select({ ourStatus: orders.ourStatus })
      .from(orders)
      .where(eq(orders.pspPaymentId, paymentId));
    expect(order!.ourStatus).toBe('refunded');
  });

  it('reversal for an unknown payment is ignored, not fatal', async () => {
    const out = await _internal.reversePaymentGrant({
      paymentId: `missing-${nid()}`,
      reversalKey: 'clawback:none',
      newStatus: 'refunded',
    });
    expect(out).toEqual({ ignored: 'unknown_payment' });
  });
});

// Touch creditPacks so the import is used (the test relies on the seed
// having populated the table; this assertion guards against running
// against an empty DB).
describe('credit_packs seeded', () => {
  it('has the five S–XXL packs plus the deactivated legacy rows', async () => {
    const rows = await db.select().from(creditPacks);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([
      'pack-1000',
      'pack-200',
      'pack-5000',
      'pack-l',
      'pack-m',
      'pack-s',
      'pack-xl',
      'pack-xxl',
    ]);
  });
});
