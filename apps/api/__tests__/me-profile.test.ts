import 'dotenv/config';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import {
  boards,
  creditTransactions,
  db,
  freeClusters,
  freeGrantEvents,
  galleryItems,
  jobs,
  nid,
  pool,
  schema,
  studioRenders,
  subscriptions,
  usersApp,
  usersPii,
  workflows,
} from '@seed/db';
import { CreditService } from '@seed/credits';
import { setupMeProfileRoutes } from '../src/me-profile';

const svc = new CreditService();

async function makeUser(emailOverride?: string): Promise<{ id: string; email: string }> {
  const id = nid();
  const email = emailOverride ?? `me+${id}@seed.local`;
  // Insert the Better Auth `user` row first so session FK can resolve.
  await db.insert(schema.user).values({ id, name: 'Test User', email, emailVerified: true });
  await db.insert(usersApp).values({ id, displayName: 'Test User', locale: 'ru' });
  await db.insert(usersPii).values({ id, email });
  return { id, email };
}

async function buildApp(user: { id: string; email: string }) {
  const app = Fastify({ logger: false });
  setupMeProfileRoutes(app, async () => ({ user: { id: user.id, email: user.email } }), svc);
  await app.ready();
  return app;
}

async function cleanupUser(id: string) {
  await db.delete(creditTransactions).where(eq(creditTransactions.userId, id));
  await db.delete(jobs).where(eq(jobs.userId, id));
  await db.delete(workflows).where(eq(workflows.userId, id));
  await db.delete(subscriptions).where(eq(subscriptions.userId, id));
  await db.delete(schema.session).where(eq(schema.session.userId, id));
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

describe('GET /v1/me/profile', () => {
  it('returns the joined users_app + users_pii row', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);
    const res = await app.inject({ method: 'GET', url: '/v1/me/profile' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.email).toBe(u.email);
    expect(body.locale).toBe('ru');
    await app.close();
  });
});

describe('PATCH /v1/me/profile', () => {
  it('updates displayName + locale, leaves email untouched', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/profile',
      payload: { displayName: 'Новое Имя', locale: 'en' },
    });
    expect(res.statusCode).toBe(200);
    const row = await db.select().from(usersApp).where(eq(usersApp.id, u.id)).limit(1);
    expect(row[0]?.displayName).toBe('Новое Имя');
    expect(row[0]?.locale).toBe('en');
    const piiRow = await db.select().from(usersPii).where(eq(usersPii.id, u.id)).limit(1);
    expect(piiRow[0]?.email).toBe(u.email);
    await app.close();
  });

  it('rejects empty displayName with 400', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/profile',
      payload: { displayName: '', locale: 'ru' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects unknown locale with 400', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me/profile',
      payload: { displayName: 'OK', locale: 'fr' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /v1/me/export', () => {
  it("returns the user's profile + own records, scoped to their id, as a download", async () => {
    const u = await makeUser();
    createdUsers.push(u.id);

    // Seed owned data: a credit grant (→ ledger rows) + one job.
    await svc.grant({
      userId: u.id,
      amount: 100,
      account: 'pack_grant',
      origin: 'pack',
      expiresAt: null,
      reason: 'test.seed',
      idempotencyKey: `export-seed:${u.id}`,
    });
    const workflowId = nid();
    const jobId = nid();
    await db.insert(workflows).values({
      id: workflowId,
      userId: u.id,
      modelId: 'seedream-4-5',
      params: { prompt: 'mine' },
      referenceAssets: [],
    });
    await db.insert(jobs).values({
      id: jobId,
      userId: u.id,
      workflowId,
      modelId: 'seedream-4-5',
      status: 'succeeded',
      creditsReserved: 0,
      idempotencyKey: `idem:${jobId}`,
    });
    await svc.reserve({
      userId: u.id,
      jobId,
      amount: 10,
      reason: 'test.export-reserve',
      idempotencyKey: `export-reserve:${u.id}`,
    });
    await svc.refund({
      userId: u.id,
      jobId,
      amount: 10,
      reason: 'test.export-refund',
      idempotencyKey: `export-refund:${u.id}`,
    });
    await db
      .insert(freeClusters)
      .values({ clusterKey: 'export-own-cluster' })
      .onConflictDoNothing();
    await db.insert(freeGrantEvents).values({
      id: nid(),
      userId: u.id,
      clusterKey: 'export-own-cluster',
      level: 'DAILY:2026-07-29',
      amount: 70,
    });

    // A second user whose rows must NOT leak into u's export (INV-4 / IDOR).
    const other = await makeUser();
    createdUsers.push(other.id);
    const otherWorkflowId = nid();
    const otherJobId = nid();
    await db.insert(workflows).values({
      id: otherWorkflowId,
      userId: other.id,
      modelId: 'seedream-4-5',
      params: { prompt: 'theirs' },
      referenceAssets: [],
    });
    await db.insert(jobs).values({
      id: otherJobId,
      userId: other.id,
      workflowId: otherWorkflowId,
      modelId: 'seedream-4-5',
      status: 'succeeded',
      creditsReserved: 0,
      idempotencyKey: `idem:${otherJobId}`,
    });
    await svc.grant({
      userId: other.id,
      amount: 20,
      account: 'pack_grant',
      origin: 'pack',
      expiresAt: null,
      reason: 'test.other-credit',
      idempotencyKey: `export-other-credit:${other.id}`,
    });
    await svc.reserve({
      userId: other.id,
      jobId: otherJobId,
      amount: 10,
      reason: 'test.other-reserve',
      idempotencyKey: `export-other-reserve:${other.id}`,
    });
    await svc.refund({
      userId: other.id,
      jobId: otherJobId,
      amount: 10,
      reason: 'test.other-refund',
      idempotencyKey: `export-other-refund:${other.id}`,
    });
    await db
      .insert(freeClusters)
      .values({ clusterKey: 'export-other-cluster' })
      .onConflictDoNothing();
    await db.insert(freeGrantEvents).values({
      id: nid(),
      userId: other.id,
      clusterKey: 'export-other-cluster',
      level: 'DAILY:2026-07-29',
      amount: 70,
    });

    const app = await buildApp(u);
    const res = await app.inject({ method: 'GET', url: '/v1/me/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');

    const body = JSON.parse(res.body);
    expect(body.profile.email).toBe(u.email);
    expect(body.balance.available).toBe(100);

    // Own job present; the other user's job absent.
    const jobIds = body.records.jobs.map((j: { id: string }) => j.id);
    expect(jobIds).toContain(jobId);
    expect(jobIds).not.toContain(otherJobId);

    // Ledger rows for the grant are included, all belonging to this user.
    expect(body.records.creditTransactions.length).toBeGreaterThan(0);
    expect(
      body.records.creditTransactions.every((t: { userId: string }) => t.userId === u.id),
    ).toBe(true);
    expect(body.records.creditBuckets.length).toBeGreaterThan(0);
    expect(body.records.creditBuckets.every((b: { userId: string }) => b.userId === u.id)).toBe(
      true,
    );
    expect(body.records.creditBuckets.map((b: { userId: string }) => b.userId)).not.toContain(
      other.id,
    );
    expect(body.records.creditBucketAllocations.length).toBeGreaterThan(0);
    expect(
      body.records.creditBucketAllocations.every((a: { userId: string }) => a.userId === u.id),
    ).toBe(true);
    expect(
      body.records.creditBucketAllocations.map((a: { userId: string }) => a.userId),
    ).not.toContain(other.id);
    expect(body.records.freeGrantEvents).toEqual([
      expect.objectContaining({ userId: u.id, level: 'DAILY:2026-07-29' }),
    ]);
    await app.close();
  });
});

describe('DELETE /v1/me', () => {
  it('requires confirmEmail to match session email', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/me',
      payload: { confirmEmail: 'wrong@example.com' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('email_mismatch');
    // users_app still active.
    const row = await db.select().from(usersApp).where(eq(usersApp.id, u.id)).limit(1);
    expect(row[0]?.status).toBe('active');
    await app.close();
  });

  it('soft-deletes users_app, hard-deletes users_pii, refunds pendings, cancels subs, wipes sessions', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);

    // Grant 200 credits so we have something to reserve.
    await svc.grant({
      userId: u.id,
      amount: 200,
      account: 'pack_grant',
      reason: 'test.seed',
      idempotencyKey: `seed:${u.id}`,
    });

    // Set up an open job + workflow so the delete has a pending to refund.
    const workflowId = nid();
    const jobId = nid();
    await db.insert(workflows).values({
      id: workflowId,
      userId: u.id,
      modelId: 'seedream-4-5',
      params: { prompt: 'test' },
      referenceAssets: [],
    });
    await db.insert(jobs).values({
      id: jobId,
      userId: u.id,
      workflowId,
      modelId: 'seedream-4-5',
      status: 'queued',
      creditsReserved: 50,
      idempotencyKey: `idem:${jobId}`,
    });
    await svc.reserve({
      userId: u.id,
      jobId,
      amount: 50,
      reason: 'test.reserve',
      idempotencyKey: `job:${jobId}:reserve`,
    });

    // Live subscription.
    const subId = nid();
    await db.insert(subscriptions).values({
      id: subId,
      userId: u.id,
      tier: 'start',
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    });

    // A published/featured asset must disappear from every public surface as
    // part of erasure, before the asynchronous object reaper runs.
    const publicAssetId = nid();
    const publishedAt = new Date(Date.now() - 1_000);
    await db.insert(galleryItems).values({
      id: publicAssetId,
      userId: u.id,
      assetUrl: `https://assets.seed.test/${publicAssetId}.png`,
      kind: 'image',
      isPublic: true,
      publishedAt,
      publicSlug: `public-${publicAssetId}`,
      featuredAt: publishedAt,
      expiresAt: null,
    });

    const boardId = nid();
    await db.insert(boards).values({
      id: boardId,
      userId: u.id,
      state: {},
      shareToken: `share-${boardId}`,
    });
    const renderId = nid();
    await db.insert(studioRenders).values({
      id: renderId,
      userId: u.id,
      status: 'queued',
      spec: { clips: [], width: 640, height: 360 },
    });

    // Better Auth verification rows have no user FK. Seed the account's
    // email-change and email/phone identifiers plus one unrelated row; only
    // the owned identifiers may be removed by account erasure.
    const ownVerificationIds = [nid(), nid(), nid()];
    await db.insert(schema.verification).values([
      {
        id: ownVerificationIds[0]!,
        identifier: `email-change:${u.id}`,
        value: JSON.stringify({ newEmail: `pending+${u.id}@seed.local`, codeHash: 'hash' }),
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        id: ownVerificationIds[1]!,
        identifier: u.email,
        value: 'email-otp',
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        id: ownVerificationIds[2]!,
        identifier: '+79990000099',
        value: 'phone-otp',
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    await db.update(usersPii).set({ phone: '+79990000099' }).where(eq(usersPii.id, u.id));
    const other = await makeUser();
    createdUsers.push(other.id);
    const otherVerificationId = nid();
    await db.insert(schema.verification).values({
      id: otherVerificationId,
      identifier: other.email,
      value: 'other-user',
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Two active sessions.
    await db.insert(schema.session).values({
      id: nid(),
      userId: u.id,
      token: `tok-${nid()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await db.insert(schema.session).values({
      id: nid(),
      userId: u.id,
      token: `tok-${nid()}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const beforeBalance = await svc.balanceFor(u.id);
    expect(beforeBalance.available).toBe(150); // 200 grant - 50 reserve
    expect(beforeBalance.pending).toBe(50);

    const app = await buildApp(u);
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/me',
      payload: { confirmEmail: u.email },
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    // users_app soft-deleted.
    const appRow = await db.select().from(usersApp).where(eq(usersApp.id, u.id)).limit(1);
    expect(appRow[0]?.status).toBe('deleted');
    expect(appRow[0]?.displayName).toBeNull();
    expect(appRow[0]?.deletedAt).toBeInstanceOf(Date);

    // users_pii hard-deleted.
    const piiRow = await db.select().from(usersPii).where(eq(usersPii.id, u.id)).limit(1);
    expect(piiRow).toHaveLength(0);

    // Pending refunded.
    const afterBalance = await svc.balanceFor(u.id);
    expect(afterBalance.pending).toBe(0);
    // Job marked failed with USER_DELETED.
    const jobRow = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    expect(jobRow[0]?.status).toBe('failed');
    expect(jobRow[0]?.errorCode).toBe('USER_DELETED');

    // Subscription canceled.
    const subRow = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subId))
      .limit(1);
    expect(subRow[0]?.status).toBe('canceled');
    expect(subRow[0]?.cancelAtPeriodEnd).toBe(true);

    // Public publication is revoked atomically with account deletion. The
    // row remains as a short-lived erasure receipt for the gallery reaper.
    const assetRow = await db
      .select()
      .from(galleryItems)
      .where(eq(galleryItems.id, publicAssetId))
      .limit(1);
    expect(assetRow[0]?.isPublic).toBe(false);
    expect(assetRow[0]?.publishedAt).toBeNull();
    expect(assetRow[0]?.publicSlug).toBeNull();
    expect(assetRow[0]?.featuredAt).toBeNull();
    expect(assetRow[0]?.deletedAt).toBeInstanceOf(Date);
    expect(assetRow[0]?.expiresAt).toBeInstanceOf(Date);

    const boardRow = await db.select().from(boards).where(eq(boards.id, boardId)).limit(1);
    expect(boardRow[0]?.shareToken).toBeNull();
    const renderRow = await db
      .select()
      .from(studioRenders)
      .where(eq(studioRenders.id, renderId))
      .limit(1);
    expect(renderRow[0]?.status).toBe('canceled');
    expect(renderRow[0]?.errorMessage).toBe('Account deleted by user.');
    expect(renderRow[0]?.finishedAt).toBeInstanceOf(Date);

    // Sessions wiped (cascade from schema.user, but assert directly).
    const sessionRows = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.userId, u.id));
    expect(sessionRows).toHaveLength(0);

    // schema.user hard-deleted (the Better Auth row holds email + name
    // — both PII). Belt-and-braces alongside the cascade on session.
    const authUserRows = await db.select().from(schema.user).where(eq(schema.user.id, u.id));
    expect(authUserRows).toHaveLength(0);

    const ownedVerificationRows = await db
      .select()
      .from(schema.verification)
      .where(inArray(schema.verification.id, ownVerificationIds));
    expect(ownedVerificationRows).toHaveLength(0);
    const otherVerificationRows = await db
      .select()
      .from(schema.verification)
      .where(eq(schema.verification.id, otherVerificationId));
    expect(otherVerificationRows).toHaveLength(1);
    await db.delete(schema.verification).where(eq(schema.verification.id, otherVerificationId));
  });

  it('M9: an email-less account deletes via the confirmation phrase (not email)', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    // Session reports no usable email (anonymous / VK-without-email).
    const app = await buildApp({ id: u.id, email: '' });

    // Wrong phrase → rejected, account stays active.
    const bad = await app.inject({
      method: 'DELETE',
      url: '/v1/me',
      payload: { confirmPhrase: 'nope' },
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body).error).toBe('confirm_phrase_mismatch');
    expect(
      (await db.select().from(usersApp).where(eq(usersApp.id, u.id)).limit(1))[0]?.status,
    ).toBe('active');

    // Correct phrase (case-insensitive) → erased.
    const ok = await app.inject({
      method: 'DELETE',
      url: '/v1/me',
      payload: { confirmPhrase: 'удалить' },
    });
    expect(ok.statusCode).toBe(200);
    expect(
      (await db.select().from(usersApp).where(eq(usersApp.id, u.id)).limit(1))[0]?.status,
    ).toBe('deleted');
    await app.close();
  });

  it('M9: a phone-OTP sentinel email is treated as email-less (phrase, not email match)', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp({ id: u.id, email: `${u.id}@phone.vertov.local` });
    const ok = await app.inject({
      method: 'DELETE',
      url: '/v1/me',
      payload: { confirmPhrase: 'УДАЛИТЬ' },
    });
    expect(ok.statusCode).toBe(200);
    expect(
      (await db.select().from(usersApp).where(eq(usersApp.id, u.id)).limit(1))[0]?.status,
    ).toBe('deleted');
    await app.close();
  });
});
