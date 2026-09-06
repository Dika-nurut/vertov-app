import 'dotenv/config';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  billingRefunds,
  billingUnresolvedEvents,
  creditTransactions,
  db,
  galleryItems,
  nid,
  orders,
  pool,
  subscriptions,
  usersApp,
  usersPii,
} from '@seed/db';
import { CreditService } from '@seed/credits';
import type { TochkaPaymentProvider } from '@seed/provider-tochka';
import {
  extractTochkaRefundOperations,
  reconcileTochkaRefunds,
  startTochkaRefundReconciliation,
} from '../src/tochka-refund-reconciliation';

const credits = new CreditService();
const createdUsers: string[] = [];
const createdOrders: string[] = [];

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'TochkaReconciliationTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `tochka-reconciliation+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

beforeEach(() => {
  createdUsers.length = 0;
  createdOrders.length = 0;
});

afterEach(async () => {
  for (const orderId of createdOrders) {
    await db.delete(billingUnresolvedEvents).where(eq(billingUnresolvedEvents.orderRef, orderId));
    await db.delete(billingRefunds).where(eq(billingRefunds.orderId, orderId));
  }
  for (const userId of createdUsers) {
    await db.delete(galleryItems).where(eq(galleryItems.userId, userId));
    await db.delete(creditTransactions).where(eq(creditTransactions.userId, userId));
    await db.delete(subscriptions).where(eq(subscriptions.userId, userId));
    await db.delete(orders).where(eq(orders.userId, userId));
    await db.delete(usersPii).where(eq(usersPii.id, userId));
    await db.delete(usersApp).where(eq(usersApp.id, userId));
  }
});

afterAll(async () => {
  await pool.end();
});

describe('extractTochkaRefundOperations', () => {
  it('uses distinct provider refund order ids for multiple partial refunds', () => {
    const refunds = extractTochkaRefundOperations(
      {
        Data: {
          Operation: [
            {
              operationId: 'payment-1',
              status: 'REFUNDED_PARTIALLY',
              amount: 599,
              Order: [
                { orderId: 'approval-1', type: 'approval', amount: 599 },
                { orderId: 'refund-1', type: 'refund', amount: 100 },
                { orderId: 'refund-2', type: 'refund', amount: 499 },
              ],
            },
          ],
        },
      },
      'payment-1',
      599,
    );

    expect(refunds).toEqual([
      { id: 'refund-1', amountRub: 100 },
      { id: 'refund-2', amountRub: 499 },
    ]);
  });

  it('falls back to the payment id for a full-refund response without Order rows', () => {
    expect(
      extractTochkaRefundOperations(
        { Data: { Operation: [{ operationId: 'payment-2', status: 'REFUNDED' }] } },
        'payment-2',
        599,
      ),
    ).toEqual([{ id: 'payment-2', amountRub: 599 }]);
  });

  it('keeps equal partials separate when the provider repeats the parent operation id', () => {
    const refunds = extractTochkaRefundOperations(
      {
        Data: {
          Operation: [
            {
              operationId: 'payment-3',
              status: 'REFUNDED_PARTIALLY',
              Order: [
                { operationId: 'payment-3', type: 'refund', refundUid: 'uid-a', amount: 100 },
                { operationId: 'payment-3', type: 'refund', refundUid: 'uid-b', amount: 100 },
              ],
            },
          ],
        },
      },
      'payment-3',
      200,
    );

    expect(refunds).toEqual([
      { id: 'uid-a', amountRub: 100, refundUid: 'uid-a' },
      { id: 'uid-b', amountRub: 100, refundUid: 'uid-b' },
    ]);
  });
});

describe('reconcileTochkaRefunds', () => {
  it('converges a manual refund into order, ledger, subscription, media, and provider state', async () => {
    const userId = await makeUser();
    const paymentId = `tochka-payment-${nid()}`;
    const orderId = nid();
    const subscriptionId = nid();
    const assetId = nid();
    const providerSubscriptionId = `tochka-subscription-${nid()}`;
    createdOrders.push(orderId);

    await db.insert(subscriptions).values({
      id: subscriptionId,
      userId,
      tier: 'start',
      status: 'active',
      currentPeriodStart: new Date(Date.now() - 60_000),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: true,
      cycleNumber: 1,
      priceRub: 599,
      creditsPerCycle: 1175,
      pspSubscriptionId: providerSubscriptionId,
    });
    await db.insert(orders).values({
      id: orderId,
      userId,
      kind: 'subscription',
      tierOrPackId: 'start',
      amountRub: 599,
      psp: 'tochka',
      pspPaymentId: paymentId,
      pspStatus: 'APPROVED',
      ourStatus: 'paid',
      paidAt: new Date(Date.now() - 60_000),
      metadata: { purpose: 'subscribe', subscriptionId },
    });
    await db.insert(galleryItems).values({
      id: assetId,
      userId,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
      expiresAt: null,
    });
    await credits.grant({
      userId,
      amount: 1175,
      account: 'subscription_grant',
      reason: 'subscription.subscribe',
      sourceOrderId: orderId,
      idempotencyKey: `sub:${subscriptionId}:cycle:1`,
    });
    await db.insert(billingUnresolvedEvents).values({
      id: nid(),
      event: 'acquiringInternetPayment',
      objectId: paymentId,
      pspPaymentId: paymentId,
      orderRef: orderId,
      payload: {},
    });

    const cancelled: Array<{ id: string; status: string }> = [];
    let providerSubscriptionStatus: 'Active' | 'Cancelled' = 'Active';
    const provider = {
      getPaymentInfo: async () => ({
        Data: {
          Operation: [
            {
              operationId: paymentId,
              paymentLinkId: orderId,
              status: 'REFUNDED',
              amount: 599,
              Order: [{ orderId: 'refund-1', type: 'refund', amount: 599 }],
            },
          ],
        },
      }),
      getSubscriptionStatus: async () => ({ Data: { status: providerSubscriptionStatus } }),
      setSubscriptionStatus: async (id: string, status: 'Active' | 'Cancelled') => {
        cancelled.push({ id, status });
        providerSubscriptionStatus = status;
      },
    } satisfies Pick<
      TochkaPaymentProvider,
      'getPaymentInfo' | 'getSubscriptionStatus' | 'setSubscriptionStatus'
    >;

    const first = await reconcileTochkaRefunds({
      provider,
      lookbackMs: 24 * 60 * 60 * 1000,
      batchSize: 10,
      log: silentLog,
    });
    expect(first).toMatchObject({
      checked: 1,
      refunded: 1,
      clawedBack: 1175,
      providerCancellations: 1,
      failures: 0,
    });

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    const [subscription] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId));
    const [asset] = await db.select().from(galleryItems).where(eq(galleryItems.id, assetId));
    const ledger = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.relatedOrderId, orderId));

    expect(order!.ourStatus).toBe('refunded');
    expect(order!.pspStatus).toBe('refunded');
    expect(order!.refundedAt).toBeTruthy();
    expect(subscription!.status).toBe('canceled');
    expect(asset!.expiresAt).toBeInstanceOf(Date);
    expect(ledger.filter((row) => row.amount === -1175)).toHaveLength(1);
    expect((await credits.balanceFor(userId)).available).toBe(0);
    expect(cancelled).toEqual([{ id: providerSubscriptionId, status: 'Cancelled' }]);
    expect(
      await db
        .select()
        .from(billingUnresolvedEvents)
        .where(eq(billingUnresolvedEvents.orderRef, orderId)),
    ).toHaveLength(0);

    const second = await reconcileTochkaRefunds({
      provider,
      lookbackMs: 24 * 60 * 60 * 1000,
      log: silentLog,
    });
    expect(second).toMatchObject({ checked: 0, refunded: 0, clawedBack: 0, failures: 0 });
    expect(cancelled).toHaveLength(1);
  });

  it('keeps partial refunds separate across ticks and only terminalizes at the full amount', async () => {
    const userId = await makeUser();
    const paymentId = `tochka-partial-${nid()}`;
    const orderId = nid();
    createdOrders.push(orderId);
    await db.insert(orders).values({
      id: orderId,
      userId,
      kind: 'pack',
      tierOrPackId: 'pack-1000',
      amountRub: 199,
      psp: 'tochka',
      pspPaymentId: paymentId,
      pspStatus: 'PAID',
      ourStatus: 'paid',
      paidAt: new Date(),
    });
    await credits.grant({
      userId,
      amount: 1000,
      account: 'pack_grant',
      reason: 'pack.purchase',
      sourceOrderId: orderId,
      idempotencyKey: `pack:${orderId}`,
    });

    let tick = 0;
    const provider = {
      getPaymentInfo: async () => ({
        Data: {
          Operation: [
            {
              operationId: paymentId,
              status: tick++ === 0 ? 'REFUNDED_PARTIALLY' : 'REFUNDED',
              Order:
                tick === 1
                  ? [
                      {
                        orderId: 'payment-parent',
                        type: 'refund',
                        refundUid: 'refund-a-uid',
                        amount: '99.50',
                      },
                    ]
                  : [
                      {
                        orderId: 'payment-parent',
                        type: 'refund',
                        refundUid: 'refund-a-uid',
                        amount: '99.50',
                      },
                      {
                        orderId: 'payment-parent',
                        type: 'refund',
                        refundUid: 'refund-b-uid',
                        amount: '99.50',
                      },
                    ],
            },
          ],
        },
      }),
      getSubscriptionStatus: async () => ({ Data: { status: 'Cancelled' } }),
      setSubscriptionStatus: async () => undefined,
    } satisfies Pick<
      TochkaPaymentProvider,
      'getPaymentInfo' | 'getSubscriptionStatus' | 'setSubscriptionStatus'
    >;

    const first = await reconcileTochkaRefunds({ provider, batchSize: 1, log: silentLog });
    expect(first).toMatchObject({ checked: 1, refunded: 1, clawedBack: 500, failures: 0 });
    expect((await credits.balanceFor(userId)).available).toBe(500);
    expect((await db.select().from(orders).where(eq(orders.id, orderId)))[0]!.ourStatus).toBe(
      'partially_refunded',
    );

    const second = await reconcileTochkaRefunds({ provider, batchSize: 1, log: silentLog });
    expect(second).toMatchObject({ checked: 1, refunded: 1, clawedBack: 500, failures: 0 });
    expect((await credits.balanceFor(userId)).available).toBe(0);
    expect((await db.select().from(orders).where(eq(orders.id, orderId)))[0]!.ourStatus).toBe(
      'refunded',
    );
    const refunds = await db
      .select()
      .from(billingRefunds)
      .where(eq(billingRefunds.orderId, orderId));
    expect(refunds).toHaveLength(2);
    expect(refunds.map((row) => row.status)).toEqual(['applied', 'applied']);
    expect(refunds.map((row) => row.refundUid)).toEqual(['refund-a-uid', 'refund-b-uid']);
    // Tochka repeated the parent operation id in both rows; it must not become
    // the unique providerRefundId and merge the equal partials.
    expect(refunds.map((row) => row.providerRefundId)).toEqual([null, null]);
  });

  it('moves an asynchronous WAITING refund to REJECTED without revoking access', async () => {
    const userId = await makeUser();
    const paymentId = `tochka-rejected-${nid()}`;
    const orderId = nid();
    const refundUid = `refund-rejected-${nid()}`;
    createdOrders.push(orderId);
    await db.insert(orders).values({
      id: orderId,
      userId,
      kind: 'pack',
      tierOrPackId: 'pack-1000',
      amountRub: 199,
      psp: 'tochka',
      pspPaymentId: paymentId,
      pspStatus: 'PAID',
      ourStatus: 'paid',
      paidAt: new Date(),
    });
    await credits.grant({
      userId,
      amount: 1000,
      account: 'pack_grant',
      reason: 'pack.purchase',
      sourceOrderId: orderId,
      idempotencyKey: `pack:${orderId}`,
    });
    await db.insert(billingRefunds).values({
      id: nid(),
      psp: 'tochka',
      orderId,
      pspPaymentId: paymentId,
      refundUid,
      amountRub: '99.50',
      status: 'pending',
    });

    let tick = 0;
    const provider = {
      getPaymentInfo: async () => ({
        Data: {
          Operation: [
            {
              operationId: paymentId,
              status: tick++ === 0 ? 'WAITING' : 'REJECTED',
              ...(tick === 1 ? { refundUid } : {}),
              amount: '99.50',
            },
          ],
        },
      }),
      getSubscriptionStatus: async () => ({ Data: { status: 'Cancelled' } }),
      setSubscriptionStatus: async () => undefined,
    } satisfies Pick<
      TochkaPaymentProvider,
      'getPaymentInfo' | 'getSubscriptionStatus' | 'setSubscriptionStatus'
    >;

    const first = await reconcileTochkaRefunds({ provider, batchSize: 1, log: silentLog });
    expect(first).toMatchObject({ checked: 1, refunded: 0, clawedBack: 0, failures: 0 });
    expect((await credits.balanceFor(userId)).available).toBe(1000);
    expect(
      (await db.select().from(billingRefunds).where(eq(billingRefunds.orderId, orderId)))[0]!
        .status,
    ).toBe('pending');

    const second = await reconcileTochkaRefunds({ provider, batchSize: 1, log: silentLog });
    expect(second).toMatchObject({ checked: 1, refunded: 0, clawedBack: 0, failures: 0 });
    const [refund] = await db
      .select()
      .from(billingRefunds)
      .where(eq(billingRefunds.orderId, orderId));
    expect(refund!.status).toBe('rejected');
    expect(refund!.providerStatus).toBe('REJECTED');
    expect((await db.select().from(orders).where(eq(orders.id, orderId)))[0]!.ourStatus).toBe(
      'paid',
    );
    expect((await credits.balanceFor(userId)).available).toBe(1000);
  });

  it('walks every candidate across pages instead of stopping at the first 25', async () => {
    const userId = await makeUser();
    const orderIds: string[] = [];
    for (let i = 0; i < 26; i++) {
      const orderId = nid();
      orderIds.push(orderId);
      createdOrders.push(orderId);
      await db.insert(orders).values({
        id: orderId,
        userId,
        kind: 'pack',
        tierOrPackId: 'pack-200',
        amountRub: 199,
        psp: 'tochka',
        pspPaymentId: `tochka-page-${i}-${nid()}`,
        pspStatus: 'PAID',
        ourStatus: 'paid',
        createdAt: new Date(Date.now() - (26 - i) * 1000),
      });
    }
    const calls: string[] = [];
    const provider = {
      getPaymentInfo: async (paymentId: string) => {
        calls.push(paymentId);
        return { Data: { Operation: [{ operationId: paymentId, status: 'PENDING' }] } };
      },
      getSubscriptionStatus: async () => ({ Data: { status: 'Cancelled' } }),
      setSubscriptionStatus: async () => undefined,
    } satisfies Pick<
      TochkaPaymentProvider,
      'getPaymentInfo' | 'getSubscriptionStatus' | 'setSubscriptionStatus'
    >;

    const result = await reconcileTochkaRefunds({ provider, batchSize: 5, log: silentLog });
    expect(result).toMatchObject({ checked: 26, refunded: 0, clawedBack: 0, failures: 0 });
    expect(new Set(calls)).toHaveLength(orderIds.length);
  });

  it('fences provider work when the reconciliation leader lease is lost', async () => {
    const userId = await makeUser();
    const orderId = nid();
    createdOrders.push(orderId);
    await db.insert(orders).values({
      id: orderId,
      userId,
      kind: 'pack',
      tierOrPackId: 'pack-200',
      amountRub: 199,
      psp: 'tochka',
      pspPaymentId: `tochka-lease-${nid()}`,
      pspStatus: 'PAID',
      ourStatus: 'paid',
    });
    let providerCalls = 0;
    let renewCalls = 0;
    const provider = {
      getPaymentInfo: async () => {
        providerCalls++;
        return { Data: { Operation: [{ status: 'PENDING' }] } };
      },
      getSubscriptionStatus: async () => ({ Data: { status: 'Cancelled' } }),
      setSubscriptionStatus: async () => undefined,
    } satisfies Pick<
      TochkaPaymentProvider,
      'getPaymentInfo' | 'getSubscriptionStatus' | 'setSubscriptionStatus'
    >;
    const redis = {
      set: async () => 'OK',
      eval: async () => {
        renewCalls++;
        return 0;
      },
    } as never;
    const handle = startTochkaRefundReconciliation({
      log: silentLog,
      redis,
      provider,
      intervalMs: 1_000,
      firstTickDelayMs: 60_000,
      batchSize: 1,
    });
    try {
      await expect(handle.tick()).rejects.toThrow('leader lease lost');
      expect(renewCalls).toBeGreaterThan(0);
      expect(providerCalls).toBe(0);
    } finally {
      handle.stop();
    }
  });

  it('recovers an old unbound payment through the operation list without a 30-day cutoff', async () => {
    const userId = await makeUser();
    const orderId = nid();
    const paymentId = `tochka-unbound-${nid()}`;
    createdOrders.push(orderId);
    await db.insert(orders).values({
      id: orderId,
      userId,
      kind: 'pack',
      tierOrPackId: 'pack-200',
      amountRub: 199,
      psp: 'tochka',
      pspPaymentId: null,
      pspStatus: 'PAID',
      ourStatus: 'paid',
      metadata: { paymentLinkId: orderId },
      createdAt: new Date(Date.parse('2026-09-02T00:00:00.000Z') - 45 * 24 * 60 * 60 * 1000),
    });
    await credits.grant({
      userId,
      amount: 200,
      account: 'pack_grant',
      reason: 'pack.purchase',
      sourceOrderId: orderId,
      idempotencyKey: `pack:${orderId}`,
    });
    const listCalls: string[][] = [];
    const provider = {
      getPaymentInfo: async () => {
        throw new Error('bound lookup should not be used for an unbound order');
      },
      getPaymentOperationList: async (from: string, to: string) => {
        listCalls.push([from, to]);
        return {
          Data: {
            Operation: [
              {
                operationId: paymentId,
                paymentLinkId: orderId,
                status: 'REFUNDED',
                Order: [{ orderId: 'old-refund', type: 'refund', amount: 199 }],
              },
            ],
          },
        };
      },
      getSubscriptionStatus: async () => ({ Data: { status: 'Cancelled' } }),
      setSubscriptionStatus: async () => undefined,
    } satisfies Pick<
      TochkaPaymentProvider,
      | 'getPaymentInfo'
      | 'getPaymentOperationList'
      | 'getSubscriptionStatus'
      | 'setSubscriptionStatus'
    >;

    const result = await reconcileTochkaRefunds({
      provider,
      now: new Date('2026-09-02T00:00:00.000Z'),
      batchSize: 1,
      log: silentLog,
    });
    expect(result).toMatchObject({ checked: 1, refunded: 1, clawedBack: 200, failures: 0 });
    expect(listCalls[0]).toEqual(['2026-07-19', '2026-09-02']);
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.pspPaymentId).toBe(paymentId);
    expect(order!.ourStatus).toBe('refunded');
  });

  it('retries provider agreement cancellation after a transient failure', async () => {
    const userId = await makeUser();
    const subscriptionId = nid();
    const providerSubscriptionId = `tochka-sub-${nid()}`;
    await db.insert(subscriptions).values({
      id: subscriptionId,
      userId,
      tier: 'start',
      status: 'canceled',
      currentPeriodStart: new Date(Date.now() - 60 * 60 * 1000),
      currentPeriodEnd: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: true,
      cycleNumber: 1,
      priceRub: 599,
      creditsPerCycle: 1175,
      pspSubscriptionId: providerSubscriptionId,
    });
    let attempts = 0;
    const provider = {
      getPaymentInfo: async () => ({ Data: { Operation: [{ status: 'PENDING' }] } }),
      getSubscriptionStatus: async () => ({ Data: { status: 'Active' } }),
      setSubscriptionStatus: async () => {
        attempts++;
        if (attempts === 1) throw new Error('temporary bank outage');
      },
    } satisfies Pick<
      TochkaPaymentProvider,
      'getPaymentInfo' | 'getSubscriptionStatus' | 'setSubscriptionStatus'
    >;

    const first = await reconcileTochkaRefunds({ provider, batchSize: 1, log: silentLog });
    expect(first).toMatchObject({ providerCancellations: 0, failures: 1 });
    const second = await reconcileTochkaRefunds({ provider, batchSize: 1, log: silentLog });
    expect(second).toMatchObject({ providerCancellations: 1, failures: 0 });
    expect(attempts).toBe(2);
  });
});
