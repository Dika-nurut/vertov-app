import 'dotenv/config';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { db, nid, pool, schema, usersApp, usersPii } from '@seed/db';
import { setupMeAccountRoutes } from '../src/me-account';

async function makeUser(): Promise<{ id: string; email: string }> {
  const id = nid();
  const email = `acct+${id}@seed.local`;
  await db.insert(schema.user).values({ id, name: 'Test User', email, emailVerified: true });
  await db.insert(usersApp).values({ id, displayName: 'Test User', locale: 'ru' });
  await db.insert(usersPii).values({ id, email });
  return { id, email };
}

async function addAccount(userId: string, providerId: string, accountId: string, when: Date) {
  const id = nid();
  await db.insert(schema.account).values({
    id,
    accountId,
    providerId,
    userId,
    createdAt: when,
    updatedAt: when,
  });
  return id;
}

async function addSession(userId: string, opts: { id?: string; expiresAt?: Date; ua?: string }) {
  const id = opts.id ?? nid();
  await db.insert(schema.session).values({
    id,
    userId,
    token: `tok-${nid()}`,
    expiresAt: opts.expiresAt ?? new Date(Date.now() + 86_400_000),
    userAgent: opts.ua ?? null,
    updatedAt: new Date(),
  });
  return id;
}

/** Build the app with a stubbed resolver that reports a given current session. */
async function buildApp(user: { id: string; email: string }, currentSessionId?: string | null) {
  const app = Fastify({ logger: false });
  setupMeAccountRoutes(app, async () => ({
    user: { id: user.id, email: user.email },
    session: currentSessionId === undefined ? null : { id: currentSessionId },
  }));
  await app.ready();
  return app;
}

async function cleanupUser(id: string) {
  await db.delete(schema.account).where(eq(schema.account.userId, id));
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

describe('GET /v1/me/accounts', () => {
  it('lists the linked providers with labels, scoped to the user', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    await addAccount(u.id, 'yandex', 'ya-1', new Date(Date.now() - 2000));
    await addAccount(u.id, 'vk', 'vk-1', new Date(Date.now() - 1000));

    // Another user's account must not leak.
    const other = await makeUser();
    createdUsers.push(other.id);
    await addAccount(other.id, 'google', 'g-1', new Date());

    const app = await buildApp(u);
    const res = await app.inject({ method: 'GET', url: '/v1/me/accounts' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i: { provider: string }) => i.provider).sort()).toEqual([
      'vk',
      'yandex',
    ]);
    expect(body.items.find((i: { provider: string }) => i.provider === 'yandex').label).toBe(
      'Яндекс',
    );
    expect(body.canUnlink).toBe(true);
    await app.close();
  });
});

describe('POST /v1/me/accounts/unlink', () => {
  it('unlinks one provider when more than one remains', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    await addAccount(u.id, 'yandex', 'ya-1', new Date(Date.now() - 2000));
    await addAccount(u.id, 'vk', 'vk-1', new Date(Date.now() - 1000));

    const app = await buildApp(u);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/accounts/unlink',
      payload: { providerId: 'vk', accountId: 'vk-1' },
    });
    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(schema.account).where(eq(schema.account.userId, u.id));
    expect(rows.map((r) => r.providerId)).toEqual(['yandex']);
    await app.close();
  });

  it('refuses to unlink the LAST login method (lockout guard)', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    await addAccount(u.id, 'yandex', 'ya-1', new Date());

    const app = await buildApp(u);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/accounts/unlink',
      payload: { providerId: 'yandex', accountId: 'ya-1' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('last_login_method');
    // Still linked.
    const rows = await db.select().from(schema.account).where(eq(schema.account.userId, u.id));
    expect(rows).toHaveLength(1);
    await app.close();
  });

  it('serializes concurrent unlink requests so one login method remains', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    await addAccount(u.id, 'yandex', 'ya-1', new Date(Date.now() - 2000));
    await addAccount(u.id, 'vk', 'vk-1', new Date(Date.now() - 1000));

    const app = await buildApp(u);
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/me/accounts/unlink',
        payload: { providerId: 'yandex', accountId: 'ya-1' },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/me/accounts/unlink',
        payload: { providerId: 'vk', accountId: 'vk-1' },
      }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 400]);
    const rejected = first.statusCode === 400 ? first : second;
    expect(JSON.parse(rejected.body).error).toBe('last_login_method');
    const rows = await db.select().from(schema.account).where(eq(schema.account.userId, u.id));
    expect(rows).toHaveLength(1);
    await app.close();
  });

  it('refuses a provider-wide unlink that would remove multiple final methods', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    await addAccount(u.id, 'yandex', 'ya-1', new Date(Date.now() - 2000));
    await addAccount(u.id, 'yandex', 'ya-2', new Date(Date.now() - 1000));

    const app = await buildApp(u);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/accounts/unlink',
      payload: { providerId: 'yandex' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('last_login_method');
    const rows = await db.select().from(schema.account).where(eq(schema.account.userId, u.id));
    expect(rows).toHaveLength(2);
    await app.close();
  });

  it('cannot unlink another user’s account (IDOR-safe)', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    await addAccount(u.id, 'yandex', 'ya-1', new Date(Date.now() - 1000));
    await addAccount(u.id, 'vk', 'vk-1', new Date());

    const other = await makeUser();
    createdUsers.push(other.id);
    const otherAccId = await addAccount(other.id, 'google', 'g-1', new Date());

    const app = await buildApp(u);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/accounts/unlink',
      payload: { providerId: 'google', accountId: 'g-1' },
    });
    // Not found in the caller's scope; the other user's row is untouched.
    expect(res.statusCode).toBe(404);
    const stillThere = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.id, otherAccId));
    expect(stillThere).toHaveLength(1);
    await app.close();
  });
});

describe('GET /v1/me/sessions', () => {
  it('lists active sessions, marks the current one, hides expired', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const curId = nid();
    await addSession(u.id, { id: curId, ua: 'Mozilla/5.0 iPhone Safari' });
    await addSession(u.id, { ua: 'Mozilla/5.0 Windows Chrome' });
    await addSession(u.id, { expiresAt: new Date(Date.now() - 1000) }); // expired

    const app = await buildApp(u, curId);
    const res = await app.inject({ method: 'GET', url: '/v1/me/sessions' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.items).toHaveLength(2); // expired excluded
    const current = body.items.filter((s: { current: boolean }) => s.current);
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(curId);
    await app.close();
  });
});

describe('POST /v1/me/sessions/revoke', () => {
  it('revokes a specific session, scoped to the user', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const a = await addSession(u.id, {});
    const b = await addSession(u.id, {});

    const app = await buildApp(u, a);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/sessions/revoke',
      payload: { id: b },
    });
    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(schema.session).where(eq(schema.session.userId, u.id));
    expect(rows.map((r) => r.id)).toEqual([a]);
    await app.close();
  });

  it('cannot revoke another user’s session', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const other = await makeUser();
    createdUsers.push(other.id);
    const otherSession = await addSession(other.id, {});

    const app = await buildApp(u, nid());
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/sessions/revoke',
      payload: { id: otherSession },
    });
    expect(res.statusCode).toBe(404);
    const rows = await db.select().from(schema.session).where(eq(schema.session.id, otherSession));
    expect(rows).toHaveLength(1);
    await app.close();
  });
});

describe('POST /v1/me/sessions/revoke-others', () => {
  it('revokes every session except the current one', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const cur = await addSession(u.id, {});
    await addSession(u.id, {});
    await addSession(u.id, {});

    const app = await buildApp(u, cur);
    const res = await app.inject({ method: 'POST', url: '/v1/me/sessions/revoke-others' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).removed).toBe(2);
    const rows = await db.select().from(schema.session).where(eq(schema.session.userId, u.id));
    expect(rows.map((r) => r.id)).toEqual([cur]);
    await app.close();
  });
});
