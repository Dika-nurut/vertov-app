import 'dotenv/config';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  creditTransactions,
  db,
  nid,
  orders,
  pool,
  subscriptions,
  usersApp,
  usersPii,
} from '@seed/db';
import type { TochkaPaymentProvider } from '@seed/provider-tochka';
import { _internal, setupBillingRoutes } from '../src/billing';
import { setupSubscriptionRoutes } from '../src/subscriptions';
import { attachPspPayment } from '../src/billing-intent';

const createdUsers: string[] = [];

/** The real billing + subscription routes with a fixed session. */
function buildApp(userId: string): FastifyInstance {
  const app = Fastify();
  setupBillingRoutes(app, async () => ({ user: { id: userId } }));
  setupSubscriptionRoutes(app, async () => ({ user: { id: userId } }));
  return app;
}

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'ResumeTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `resume+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

function tochkaInfo(status: string, paymentId: string): Record<string, unknown> {
  return {
    Data: {
      Operation: [{ operationId: paymentId, status, amount: { amount: '490.00' } }],
    },
  };
}

function useTochkaProvider(liveStatus: string, paymentId: string) {
  const getPaymentInfo = vi.fn().mockResolvedValue(tochkaInfo(liveStatus, paymentId));
  vi.stubEnv('BILLING_PROVIDER', 'tochka');
  _internal._setTochkaAdapter({ getPaymentInfo } as unknown as TochkaPaymentProvider);
  return { getPaymentInfo };
}

beforeEach(() => {
  createdUsers.length = 0;
});

afterEach(async () => {
  _internal._setTochkaAdapter(null);
  vi.unstubAllEnvs();
  for (const id of createdUsers) {
    await db.delete(creditTransactions).where(eq(creditTransactions.userId, id));
    await db.delete(orders).where(eq(orders.userId, id));
    await db.delete(subscriptions).where(eq(subscriptions.userId, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
});

afterAll(async () => {
  await pool.end();
});

describe('payment-resume recovery — GET /v1/billing/return carries resumeUrl', () => {
  it('returns the stored confirmation URL for a pending order whose Tochka payment is still CREATED', async () => {
    const u = await makeUser();
    const orderId = nid();
    const paymentId = `tochka-resume-${nid()}`;
    const storedUrl = 'https://pay.tochka/resume-link-1';
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'pack',
      tierOrPackId: 'pack-200',
      amountRub: 490,
      psp: 'tochka',
      pspPaymentId: paymentId,
      pspStatus: 'CREATED',
      ourStatus: 'pending',
      metadata: { paymentLinkId: orderId, confirmationUrl: storedUrl },
    });
    const { getPaymentInfo } = useTochkaProvider('CREATED', paymentId);

    const res = await buildApp(u).inject({
      method: 'GET',
      url: `/v1/billing/return?orderId=${orderId}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orderId, status: 'pending', resumeUrl: storedUrl });
    // The already-fetched live status is reused — no second provider call.
    expect(getPaymentInfo).toHaveBeenCalledTimes(1);
    expect(getPaymentInfo).toHaveBeenCalledWith(paymentId);
  });

  it('falls back to the provider-contract payment URL when no confirmation URL was persisted', async () => {
    const u = await makeUser();
    const orderId = nid();
    const paymentId = `tochka-resume-${nid()}`;
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'pack',
      tierOrPackId: 'pack-200',
      amountRub: 490,
      psp: 'tochka',
      pspPaymentId: paymentId,
      pspStatus: 'CREATED',
      ourStatus: 'pending',
      metadata: { paymentLinkId: orderId },
    });
    // Lowercase live status — the allowlist compare is case-insensitive.
    useTochkaProvider('created', paymentId);

    const res = await buildApp(u).inject({
      method: 'GET',
      url: `/v1/billing/return?orderId=${orderId}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'pending',
      resumeUrl: `https://merch.securepaytb.ru/order/?uuid=${paymentId}`,
    });
  });

  it('returns no resumeUrl once the order is paid', async () => {
    const u = await makeUser();
    const orderId = nid();
    const paymentId = `tochka-resume-${nid()}`;
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'pack',
      tierOrPackId: 'pack-200',
      amountRub: 490,
      psp: 'tochka',
      pspPaymentId: paymentId,
      pspStatus: 'succeeded',
      ourStatus: 'paid',
      metadata: { paymentLinkId: orderId, confirmationUrl: 'https://pay.tochka/paid-link' },
    });
    const { getPaymentInfo } = useTochkaProvider('COMPLETED', paymentId);

    const res = await buildApp(u).inject({
      method: 'GET',
      url: `/v1/billing/return?orderId=${orderId}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'paid', resumeUrl: null });
    // A settled order is never re-asked about.
    expect(getPaymentInfo).not.toHaveBeenCalled();
  });

  it('returns no resumeUrl when the live payment is canceled', async () => {
    const u = await makeUser();
    const orderId = nid();
    const paymentId = `tochka-resume-${nid()}`;
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'pack',
      tierOrPackId: 'pack-200',
      amountRub: 490,
      psp: 'tochka',
      pspPaymentId: paymentId,
      pspStatus: 'CREATED',
      ourStatus: 'pending',
      metadata: { paymentLinkId: orderId, confirmationUrl: 'https://pay.tochka/dead-link' },
    });
    useTochkaProvider('CANCELED', paymentId);

    const res = await buildApp(u).inject({
      method: 'GET',
      url: `/v1/billing/return?orderId=${orderId}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'pending', resumeUrl: null });
  });

  it('never surfaces the URL to another user (404)', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const orderId = nid();
    const paymentId = `tochka-resume-${nid()}`;
    await db.insert(orders).values({
      id: orderId,
      userId: owner,
      kind: 'pack',
      tierOrPackId: 'pack-200',
      amountRub: 490,
      psp: 'tochka',
      pspPaymentId: paymentId,
      pspStatus: 'CREATED',
      ourStatus: 'pending',
      metadata: { paymentLinkId: orderId, confirmationUrl: 'https://pay.tochka/owner-link' },
    });
    useTochkaProvider('CREATED', paymentId);

    const res = await buildApp(stranger).inject({
      method: 'GET',
      url: `/v1/billing/return?orderId=${orderId}`,
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns no resumeUrl for a yookassa order without a stored URL', async () => {
    const u = await makeUser();
    const orderId = nid();
    const paymentId = `stub-${nid()}`;
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'pack',
      tierOrPackId: 'pack-200',
      amountRub: 199,
      psp: 'yookassa-stub',
      pspPaymentId: paymentId,
      pspStatus: 'pending',
      ourStatus: 'pending',
      metadata: null,
    });

    const res = await buildApp(u).inject({
      method: 'GET',
      url: `/v1/billing/return?orderId=${orderId}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'pending', resumeUrl: null });
  });
});

describe('payment-resume recovery — confirmation URL persistence', () => {
  it('attach merges the confirmation URL and keeps existing metadata keys', async () => {
    const u = await makeUser();
    const orderId = nid();
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'subscription',
      tierOrPackId: 'start',
      amountRub: 490,
      psp: 'tochka',
      pspPaymentId: null,
      pspStatus: null,
      ourStatus: 'pending',
      metadata: { purpose: 'subscribe', tier: 'start', paymentLinkId: orderId },
      intentKey: 'subscribe',
    });

    await attachPspPayment(orderId, {
      providerPaymentId: `tochka-resume-${nid()}`,
      status: 'CREATED',
      confirmationUrl: 'https://pay.tochka/merged-link',
    });

    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(row!.pspPaymentId).toContain('tochka-resume-');
    expect(row!.metadata).toMatchObject({
      purpose: 'subscribe',
      tier: 'start',
      paymentLinkId: orderId,
      confirmationUrl: 'https://pay.tochka/merged-link',
    });
  });

  it('attach without a confirmation URL leaves metadata untouched', async () => {
    const u = await makeUser();
    const orderId = nid();
    const before = { purpose: 'upgrade', subscriptionId: 'sub-1', toTier: 'pro' };
    await db.insert(orders).values({
      id: orderId,
      userId: u,
      kind: 'subscription',
      tierOrPackId: 'pro',
      amountRub: 500,
      psp: 'yookassa-stub',
      pspPaymentId: null,
      pspStatus: null,
      ourStatus: 'pending',
      metadata: before,
      intentKey: 'upgrade:sub-1',
    });

    await attachPspPayment(orderId, {
      providerPaymentId: `stub-${orderId}`,
      status: 'pending',
    });

    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    expect(row!.metadata).toEqual(before);
  });
});

describe('payment-resume recovery — 409 still refuses with the existing orderId', () => {
  it('a retried subscribe is refused with checkout_in_progress and the live orderId', async () => {
    const u = await makeUser();
    const app = buildApp(u);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/billing/subscribe',
      payload: { tier: 'start' },
    });
    expect(first.statusCode).toBe(201);
    const liveOrderId = first.json().orderId as string;

    const retry = await app.inject({
      method: 'POST',
      url: '/v1/billing/subscribe',
      payload: { tier: 'start' },
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({ error: 'checkout_in_progress', orderId: liveOrderId });
  });
});
