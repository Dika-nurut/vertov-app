import 'dotenv/config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { creditTransactions, db, nid, orders, pool, usersApp, usersPii } from '@seed/db';
import { CreditService } from '@seed/credits';
import { billingProviderLabel, setupBillingHistoryRoutes } from '../src/billing-history';

const createdUsers: string[] = [];

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'HistTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `hist+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

async function makePackOrder(
  userId: string,
  packId: string,
  amountRub: number,
  status: 'paid' | 'pending' = 'paid',
): Promise<string> {
  const id = nid();
  await db.insert(orders).values({
    id,
    userId,
    kind: 'pack',
    tierOrPackId: packId,
    amountRub,
    psp: 'yookassa-stub',
    pspPaymentId: `hist-${id}`,
    pspStatus: status,
    ourStatus: status,
    paidAt: status === 'paid' ? new Date() : null,
  });
  return id;
}

let app: ReturnType<typeof Fastify>;
let currentUser: string;
const credits = new CreditService();

beforeAll(async () => {
  app = Fastify({ logger: false });
  setupBillingHistoryRoutes(app, async () => ({ user: { id: currentUser } }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

beforeEach(() => {
  createdUsers.length = 0;
});

afterEach(async () => {
  for (const id of createdUsers) {
    await db.delete(creditTransactions).where(eq(creditTransactions.userId, id));
    await db.delete(orders).where(eq(orders.userId, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
});

describe('GET /v1/billing/history', () => {
  it('returns paid + pending rows for the caller, ordered desc', async () => {
    currentUser = await makeUser();
    await makePackOrder(currentUser, 'pack-200', 199, 'paid');
    await new Promise((r) => setTimeout(r, 30));
    await makePackOrder(currentUser, 'pack-1000', 899, 'pending');
    const res = await app.inject({ method: 'GET', url: '/v1/billing/history' });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ amountRub: number; status: string; title: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.amountRub).toBe(899);
    expect(rows[1]!.amountRub).toBe(199);
    expect(rows[0]!.title).toBe('Стандарт');
  });

  it('honours the limit query', async () => {
    currentUser = await makeUser();
    for (let i = 0; i < 5; i++) await makePackOrder(currentUser, 'pack-200', 199);
    const res = await app.inject({ method: 'GET', url: '/v1/billing/history?limit=2' });
    const rows = res.json() as unknown[];
    expect(rows).toHaveLength(2);
  });
});

describe('billing provider labels', () => {
  it('uses the active Tochka label while retaining legacy provider labels', () => {
    expect(billingProviderLabel('tochka')).toBe('Точка Банк');
    expect(billingProviderLabel('yookassa-stub')).toBe('ЮKassa');
    expect(billingProviderLabel('yookassa')).toBe('ЮKassa');
  });
});

describe('GET /v1/billing/credit-breakdown', () => {
  it('returns zero subscription grant + empty packs when ledger is empty', async () => {
    currentUser = await makeUser();
    const res = await app.inject({ method: 'GET', url: '/v1/billing/credit-breakdown' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      subscriptionGrant: { amount: number };
      packGrant: unknown[];
    };
    expect(body.subscriptionGrant.amount).toBe(0);
    expect(body.packGrant).toEqual([]);
  });

  it('lists the residual for each paid pack bucket', async () => {
    currentUser = await makeUser();
    const pack200Order = await makePackOrder(currentUser, 'pack-200', 199);
    const pack1000Order = await makePackOrder(currentUser, 'pack-1000', 899);
    await credits.grant({
      userId: currentUser,
      amount: 200,
      account: 'pack_grant',
      origin: 'pack',
      expiresAt: null,
      sourceOrderId: pack200Order,
      reason: 'test.pack-200',
      idempotencyKey: `breakdown-pack-200:${currentUser}`,
    });
    await credits.grant({
      userId: currentUser,
      amount: 1000,
      account: 'pack_grant',
      origin: 'pack',
      expiresAt: null,
      sourceOrderId: pack1000Order,
      reason: 'test.pack-1000',
      idempotencyKey: `breakdown-pack-1000:${currentUser}`,
    });
    const res = await app.inject({ method: 'GET', url: '/v1/billing/credit-breakdown' });
    const body = res.json() as { packGrant: { packId: string; amount: number }[] };
    expect(body.packGrant.map((p) => p.packId).sort()).toEqual(['pack-1000', 'pack-200']);
    const byPack = Object.fromEntries(body.packGrant.map((p) => [p.packId, p.amount]));
    expect(byPack['pack-200']).toBe(200);
    expect(byPack['pack-1000']).toBe(1000);
  });

  it('reports a pack bucket residual rather than its lifetime grant total', async () => {
    currentUser = await makeUser();
    const orderId = await makePackOrder(currentUser, 'pack-200', 199);
    await credits.grant({
      userId: currentUser,
      amount: 200,
      account: 'pack_grant',
      origin: 'pack',
      expiresAt: null,
      sourceOrderId: orderId,
      reason: 'test.pack-residual',
      idempotencyKey: `breakdown-pack-residual:${currentUser}`,
    });
    await credits.reserve({
      userId: currentUser,
      jobId: `breakdown-pack-job:${currentUser}`,
      amount: 50,
      reason: 'test.pack-residual',
      idempotencyKey: `breakdown-pack-reserve:${currentUser}`,
    });
    await credits.commit({
      userId: currentUser,
      jobId: `breakdown-pack-job:${currentUser}`,
      amount: 50,
      idempotencyKey: `breakdown-pack-commit:${currentUser}`,
    });

    const res = await app.inject({ method: 'GET', url: '/v1/billing/credit-breakdown' });
    const body = res.json() as {
      packGrant: {
        packId: string;
        amount: number;
        grantedAt: string | null;
        expiresAt: string | null;
      }[];
    };
    expect(body.packGrant).toEqual([
      {
        packId: 'pack-200',
        amount: 150,
        grantedAt: expect.any(String),
        expiresAt: null,
      },
    ]);
  });

  it('omits an expired subscription bucket from the subscription grant', async () => {
    currentUser = await makeUser();
    await credits.grant({
      userId: currentUser,
      amount: 100,
      account: 'subscription_grant',
      origin: 'subscription',
      expiresAt: new Date(Date.now() - 1_000),
      sourceSubscriptionId: `expired-subscription:${currentUser}`,
      cycleNumber: 1,
      reason: 'test.expired-subscription',
      idempotencyKey: `breakdown-expired-subscription:${currentUser}`,
    });

    const res = await app.inject({ method: 'GET', url: '/v1/billing/credit-breakdown' });
    const body = res.json() as { subscriptionGrant: { amount: number; expiresAt: string | null } };
    expect(body.subscriptionGrant).toEqual({ amount: 0, expiresAt: null });
  });
});

describe('GET /v1/billing/invoice/:orderId.pdf', () => {
  it('200 + application/pdf + non-empty body for own paid order', async () => {
    currentUser = await makeUser();
    const oId = await makePackOrder(currentUser, 'pack-200', 199);
    const res = await app.inject({ method: 'GET', url: `/v1/billing/invoice/${oId}.pdf` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.length).toBeGreaterThan(500);
    // PDF magic bytes.
    expect(res.rawPayload.slice(0, 4).toString()).toBe('%PDF');
  });

  it('404 when the order is pending (not paid)', async () => {
    currentUser = await makeUser();
    const oId = await makePackOrder(currentUser, 'pack-200', 199, 'pending');
    const res = await app.inject({ method: 'GET', url: `/v1/billing/invoice/${oId}.pdf` });
    expect(res.statusCode).toBe(404);
  });

  it('404 when the order belongs to someone else', async () => {
    const owner = await makeUser();
    const oId = await makePackOrder(owner, 'pack-200', 199);
    currentUser = await makeUser(); // unrelated caller
    const res = await app.inject({ method: 'GET', url: `/v1/billing/invoice/${oId}.pdf` });
    expect(res.statusCode).toBe(404);
  });

  it('404 for unknown order id', async () => {
    currentUser = await makeUser();
    const res = await app.inject({ method: 'GET', url: '/v1/billing/invoice/does-not-exist.pdf' });
    expect(res.statusCode).toBe(404);
  });
});
