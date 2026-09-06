import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { db, nid, pool, schema, usersApp, usersPii } from '@seed/db';
import { enforceAccountSessionGate, isAccountActive } from '../src/session-gate';

/**
 * Direct unit test for the `requireSession` deleted-status gate.
 * Exercising the real DB row through the actual helper closes the
 * gap left by the me-profile suite (which uses a mock requireSession).
 */

const createdUsers: string[] = [];

async function makeUser(status: 'active' | 'banned' | 'deleted' = 'active'): Promise<string> {
  const id = nid();
  const email = `gate+${id}@seed.local`;
  await db.insert(schema.user).values({ id, name: 'Gate', email, emailVerified: true });
  await db.insert(usersApp).values({ id, displayName: 'Gate', locale: 'ru' });
  await db.insert(usersPii).values({ id, email });
  if (status !== 'active') {
    await db
      .update(usersApp)
      .set({ status, deletedAt: status === 'deleted' ? sql`now()` : null })
      .where(eq(usersApp.id, id));
  }
  createdUsers.push(id);
  return id;
}

afterAll(async () => {
  for (const id of createdUsers) {
    await db.delete(usersPii).where(eq(usersPii.id, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
    await db.delete(schema.user).where(eq(schema.user.id, id));
  }
  await pool.end();
});

describe('isAccountActive', () => {
  it('returns true for an active account', async () => {
    const id = await makeUser('active');
    expect(await isAccountActive(id)).toBe(true);
  });

  it('returns false for a banned account', async () => {
    const id = await makeUser('banned');
    expect(await isAccountActive(id)).toBe(false);
  });

  it('returns false for a deleted account', async () => {
    const id = await makeUser('deleted');
    expect(await isAccountActive(id)).toBe(false);
  });

  it('returns true for an unknown user id (pre-upsert window during fresh signup)', async () => {
    expect(await isAccountActive(nid())).toBe(true);
  });

  it('refuses a banned user on an authenticated route and allows them again after unban', async () => {
    const id = await makeUser('active');
    const app = Fastify({ logger: false });
    app.get('/authenticated', async (_req, reply) => {
      if (!(await enforceAccountSessionGate(id, reply))) return;
      return { ok: true };
    });
    await app.ready();
    try {
      await db.update(usersApp).set({ status: 'banned' }).where(eq(usersApp.id, id));
      const banned = await app.inject({ method: 'GET', url: '/authenticated' });
      expect(banned.statusCode).toBe(403);
      expect(banned.json()).toEqual({ error: 'account_banned' });

      await db.update(usersApp).set({ status: 'active' }).where(eq(usersApp.id, id));
      const unbanned = await app.inject({ method: 'GET', url: '/authenticated' });
      expect(unbanned.statusCode).toBe(200);
      expect(unbanned.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});
