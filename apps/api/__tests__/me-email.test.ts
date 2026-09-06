import 'dotenv/config';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { db, nid, pool, schema, usersApp, usersPii } from '@seed/db';
import { setupMeEmailRoutes, __getDevEmailChangeCode } from '../src/me-email';

async function makeUser(emailOverride?: string): Promise<{ id: string; email: string }> {
  const id = nid();
  const email = emailOverride ?? `mail+${id}@seed.local`;
  await db.insert(schema.user).values({ id, name: 'Test User', email, emailVerified: true });
  await db.insert(usersApp).values({ id, displayName: 'Test User', locale: 'ru' });
  await db.insert(usersPii).values({ id, email });
  return { id, email };
}

async function buildApp(user: { id: string; email: string }) {
  const app = Fastify({ logger: false });
  setupMeEmailRoutes(app, async () => ({ user: { id: user.id, email: user.email } }));
  await app.ready();
  return app;
}

async function cleanupUser(id: string) {
  await db
    .delete(schema.verification)
    .where(eq(schema.verification.identifier, `email-change:${id}`));
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

describe('email change', () => {
  it('request → confirm updates both user.email and users_pii.email', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);
    // The endpoint normalises to lowercase — assert against the normalised form.
    const newEmail = `new+${u.id}@seed.local`.toLowerCase();

    const req = await app.inject({
      method: 'POST',
      url: '/v1/me/email/request',
      payload: { newEmail },
    });
    expect(req.statusCode).toBe(200);

    const code = __getDevEmailChangeCode(u.id);
    expect(code).toMatch(/^\d{6}$/);

    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/me/email/confirm',
      payload: { code },
    });
    expect(confirm.statusCode).toBe(200);
    expect(JSON.parse(confirm.body).email).toBe(newEmail);

    const userRow = await db.select().from(schema.user).where(eq(schema.user.id, u.id)).limit(1);
    expect(userRow[0]?.email).toBe(newEmail);
    expect(userRow[0]?.emailVerified).toBe(true);
    const piiRow = await db.select().from(usersPii).where(eq(usersPii.id, u.id)).limit(1);
    expect(piiRow[0]?.email).toBe(newEmail);

    // Pending verification consumed.
    const pending = await db
      .select()
      .from(schema.verification)
      .where(eq(schema.verification.identifier, `email-change:${u.id}`));
    expect(pending).toHaveLength(0);
    await app.close();
  });

  it('rejects an email already used by another account (409)', async () => {
    const taken = await makeUser();
    createdUsers.push(taken.id);
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/email/request',
      payload: { newEmail: taken.email.toUpperCase() }, // case-insensitive
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe('email_taken');
    await app.close();
  });

  it('rejects a wrong code and leaves the email unchanged', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);
    await app.inject({
      method: 'POST',
      url: '/v1/me/email/request',
      payload: { newEmail: `nope+${u.id}@seed.local` },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/email/confirm',
      payload: { code: '000000' },
    });
    // 000000 is overwhelmingly unlikely to match the random code.
    expect(res.statusCode).toBe(400);
    const userRow = await db.select().from(schema.user).where(eq(schema.user.id, u.id)).limit(1);
    expect(userRow[0]?.email).toBe(u.email);
    await app.close();
  });

  it('rejects the current email (same_email)', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/email/request',
      payload: { newEmail: u.email },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('same_email');
    await app.close();
  });

  it('rejects an expired code', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);
    await app.inject({
      method: 'POST',
      url: '/v1/me/email/request',
      payload: { newEmail: `exp+${u.id}@seed.local` },
    });
    const code = __getDevEmailChangeCode(u.id)!;
    // Force-expire the pending row.
    await db
      .update(schema.verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.verification.identifier, `email-change:${u.id}`));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/email/confirm',
      payload: { code },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('expired');
    await app.close();
  });

  it('consumes a confirmation code once when two confirms race', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);
    const newEmail = `once+${u.id}@seed.local`.toLowerCase();
    await app.inject({
      method: 'POST',
      url: '/v1/me/email/request',
      payload: { newEmail },
    });
    const code = __getDevEmailChangeCode(u.id);
    expect(code).toMatch(/^\d{6}$/);

    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/me/email/confirm', payload: { code } }),
      app.inject({ method: 'POST', url: '/v1/me/email/confirm', payload: { code } }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 400]);
    const rejected = first.statusCode === 400 ? first : second;
    expect(JSON.parse(rejected.body).error).toBe('no_pending');
    const userRow = await db.select().from(schema.user).where(eq(schema.user.id, u.id)).limit(1);
    expect(userRow[0]?.email).toBe(newEmail);
    await app.close();
  });

  it('surfaces a concurrent same-email confirmation as email_taken', async () => {
    const firstUser = await makeUser();
    createdUsers.push(firstUser.id);
    const secondUser = await makeUser();
    createdUsers.push(secondUser.id);
    const firstApp = await buildApp(firstUser);
    const secondApp = await buildApp(secondUser);
    const newEmail = `race+${nid()}@seed.local`.toLowerCase();

    await Promise.all([
      firstApp.inject({
        method: 'POST',
        url: '/v1/me/email/request',
        payload: { newEmail },
      }),
      secondApp.inject({
        method: 'POST',
        url: '/v1/me/email/request',
        payload: { newEmail },
      }),
    ]);
    const firstCode = __getDevEmailChangeCode(firstUser.id);
    const secondCode = __getDevEmailChangeCode(secondUser.id);
    expect(firstCode).toMatch(/^\d{6}$/);
    expect(secondCode).toMatch(/^\d{6}$/);

    const [firstConfirm, secondConfirm] = await Promise.all([
      firstApp.inject({
        method: 'POST',
        url: '/v1/me/email/confirm',
        payload: { code: firstCode },
      }),
      secondApp.inject({
        method: 'POST',
        url: '/v1/me/email/confirm',
        payload: { code: secondCode },
      }),
    ]);
    expect([firstConfirm.statusCode, secondConfirm.statusCode].sort()).toEqual([200, 409]);
    const winner = firstConfirm.statusCode === 200 ? firstUser : secondUser;
    const loser = firstConfirm.statusCode === 200 ? secondUser : firstUser;
    const rejected = firstConfirm.statusCode === 409 ? firstConfirm : secondConfirm;
    expect(JSON.parse(rejected.body).error).toBe('email_taken');
    const winnerRow = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, winner.id))
      .limit(1);
    const loserRow = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, loser.id))
      .limit(1);
    expect(winnerRow[0]?.email).toBe(newEmail);
    expect(loserRow[0]?.email).toBe(loser.email);
    await firstApp.close();
    await secondApp.close();
  });
});
