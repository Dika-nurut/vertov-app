import 'dotenv/config';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { consentRecords, db, nid, pool, usersApp } from '@seed/db';
import { CONSENT_DOCUMENTS, setupConsentRoutes } from '../src/consent';

const createdUsers: string[] = [];

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'ConsentTest', locale: 'ru' });
  createdUsers.push(id);
  return id;
}

function appFor(userId: string): ReturnType<typeof Fastify> {
  const app = Fastify({ logger: false });
  setupConsentRoutes(app, async () => ({ user: { id: userId } }));
  return app;
}

afterEach(async () => {
  for (const id of createdUsers) {
    await db.delete(consentRecords).where(eq(consentRecords.userId, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
  createdUsers.length = 0;
});
afterAll(async () => {
  await pool.end();
});

describe('M8: POST /v1/consent records 152-ФЗ consent server-side', () => {
  it('records the full current document set with server-stamped versions + ip/ua', async () => {
    const userId = await makeUser();
    const app = appFor(userId);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/consent',
      headers: { 'user-agent': 'jest-ua/1.0' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; recorded: Array<{ slug: string }> };
    expect(body.ok).toBe(true);
    expect(body.recorded).toHaveLength(CONSENT_DOCUMENTS.length);

    const rows = await db.select().from(consentRecords).where(eq(consentRecords.userId, userId));
    expect(rows).toHaveLength(CONSENT_DOCUMENTS.length);
    for (const doc of CONSENT_DOCUMENTS) {
      const row = rows.find((r) => r.documentSlug === doc.slug);
      expect(row?.documentVersion).toBe(doc.version); // server-stamped, not client-supplied
      expect(row?.ua).toBe('jest-ua/1.0');
      expect(row?.grantedAt).toBeTruthy();
    }
    await app.close();
  });

  it('is idempotent — a second call records nothing new (no duplicate rows)', async () => {
    const userId = await makeUser();
    const app = appFor(userId);
    await app.ready();

    await app.inject({ method: 'POST', url: '/v1/consent', payload: {} });
    const second = await app.inject({ method: 'POST', url: '/v1/consent', payload: {} });
    expect((second.json() as { recorded: unknown[] }).recorded).toHaveLength(0);

    const rows = await db.select().from(consentRecords).where(eq(consentRecords.userId, userId));
    expect(rows).toHaveLength(CONSENT_DOCUMENTS.length); // not doubled
    await app.close();
  });

  it('requires a session (no session → handled by requireSession)', async () => {
    const app = Fastify({ logger: false });
    let called = false;
    setupConsentRoutes(app, async (_req, reply) => {
      called = true;
      reply.status(401).send({ error: 'unauthorized' });
      return null;
    });
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/v1/consent', payload: {} });
    expect(called).toBe(true);
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
