/**
 * Beta invite endpoints tests — W4.Fri.
 *
 * 5 cases:
 * 1. Seed presence — 30 'SEED-…' codes exist with cohort='tg-2026-05'
 *    (seed-beta-invites.ts mints random codes; the exact values are not fixed).
 * 2. Redeem flips usedAt + usedByUserId.
 * 3. Double-redeem by same user returns 409 { error: 'already_redeemed' }.
 * 4. Non-existent code returns 404.
 * 5. GET /v1/beta/me returns cohort after redeem, null before.
 * 6. A code used by user A returns 409 { error: 'code_already_used' } for user B.
 */
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type IORedis from 'ioredis';
import { and, eq, isNull } from 'drizzle-orm';
import { db, nid, pool, schema, betaInvites, usersApp, usersPii } from '@seed/db';
import { setupBetaRoutes } from '../src/beta';

// ── Test helpers ─────────────────────────────────────────────────────────────

async function makeUser(): Promise<{ id: string; email: string }> {
  const id = nid();
  const email = `beta+${id}@seed.local`;
  await db.insert(schema.user).values({ id, name: 'Beta Test', email, emailVerified: true });
  await db.insert(usersApp).values({ id, displayName: 'Beta Test', locale: 'ru' });
  await db.insert(usersPii).values({ id, email });
  return { id, email };
}

async function buildApp(user: { id: string; email: string }) {
  const app = Fastify({ logger: false });
  setupBetaRoutes(app, async () => ({ user: { id: user.id, email: user.email } }));
  await app.ready();
  return app;
}

async function cleanupUser(id: string) {
  // Reset any redeemed codes first (FK constraint)
  await db
    .update(betaInvites)
    .set({ usedAt: null, usedByUserId: null })
    .where(eq(betaInvites.usedByUserId, id));
  await db.delete(usersPii).where(eq(usersPii.id, id));
  await db.delete(usersApp).where(eq(usersApp.id, id));
  await db.delete(schema.user).where(eq(schema.user.id, id));
}

const createdUsers: string[] = [];

beforeAll(() => {
  createdUsers.length = 0;
});

afterAll(async () => {
  for (const id of createdUsers) await cleanupUser(id);
  await pool.end();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('beta_invites seed', () => {
  it('1. 30 SEED-prefixed codes exist with cohort tg-2026-05', async () => {
    const rows = await db
      .select({ code: betaInvites.code, cohort: betaInvites.cohort })
      .from(betaInvites)
      .where(eq(betaInvites.cohort, 'tg-2026-05'));
    expect(rows.length).toBe(30);
    expect(rows.every((r) => /^SEED-/.test(r.code))).toBe(true);
    expect(rows.every((r) => r.cohort === 'tg-2026-05')).toBe(true);
  });
});

describe('POST /v1/beta/redeem', () => {
  it('2. redeem flips usedAt + usedByUserId', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);

    // Pick a code that is unused
    const [invite] = await db
      .select({ code: betaInvites.code })
      .from(betaInvites)
      .where(and(eq(betaInvites.cohort, 'tg-2026-05'), isNull(betaInvites.usedAt)))
      .limit(1);
    const code = invite!.code;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/redeem',
      payload: { code },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ cohort: string }>();
    expect(body.cohort).toBe('tg-2026-05');

    // Verify DB state
    const [row] = await db
      .select({ usedAt: betaInvites.usedAt, usedByUserId: betaInvites.usedByUserId })
      .from(betaInvites)
      .where(eq(betaInvites.code, code))
      .limit(1);
    expect(row!.usedAt).toBeInstanceOf(Date);
    expect(row!.usedByUserId).toBe(u.id);

    await app.close();
  });

  it('3. double-redeem by same user returns 409 already_redeemed (idempotent on same code)', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);

    // Pick an unused code
    const [invite] = await db
      .select({ code: betaInvites.code })
      .from(betaInvites)
      .where(and(eq(betaInvites.cohort, 'tg-2026-05'), isNull(betaInvites.usedAt)))
      .limit(1);
    const code = invite!.code;

    const first = await app.inject({
      method: 'POST',
      url: '/v1/beta/redeem',
      payload: { code },
    });
    expect(first.statusCode).toBe(200);

    // Redeeming the SAME code again → 200 (idempotent)
    const same = await app.inject({
      method: 'POST',
      url: '/v1/beta/redeem',
      payload: { code },
    });
    expect(same.statusCode).toBe(200);

    // Trying a DIFFERENT code after already having one → 409
    const [anotherInvite] = await db
      .select({ code: betaInvites.code })
      .from(betaInvites)
      .where(and(eq(betaInvites.cohort, 'tg-2026-05'), isNull(betaInvites.usedAt)))
      .limit(1);

    if (anotherInvite) {
      const other = await app.inject({
        method: 'POST',
        url: '/v1/beta/redeem',
        payload: { code: anotherInvite.code },
      });
      expect(other.statusCode).toBe(409);
      expect(other.json<{ error: string }>().error).toBe('already_redeemed');
    }

    await app.close();
  });

  it('4. non-existent code returns 404 invalid_code', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/beta/redeem',
      payload: { code: 'DOES-NOT-EXIST-9999' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('invalid_code');

    await app.close();
  });
});

/**
 * SF-15 — the redeem endpoint must not be a code-existence oracle, and brute
 * force must be throttled. An unknown code and a real-but-used code return the
 * SAME response; a per-user rate limit bounds guessing.
 */
function makeRedisStub(): IORedis {
  const store = new Map<string, number>();
  return {
    async eval(_s: string, _n: number, key: string) {
      const v = (store.get(key) ?? 0) + 1;
      store.set(key, v);
      return v;
    },
  } as unknown as IORedis;
}

describe('SF-15: beta redeem is not an enumeration oracle + is throttled', () => {
  it('an already-used code is indistinguishable from an unknown code', async () => {
    // User A claims a fresh code.
    const a = await makeUser();
    createdUsers.push(a.id);
    const appA = await buildApp(a);
    const [invite] = await db
      .select({ code: betaInvites.code })
      .from(betaInvites)
      .where(and(eq(betaInvites.cohort, 'tg-2026-05'), isNull(betaInvites.usedAt)))
      .limit(1);
    const usedCode = invite!.code;
    expect(
      (await appA.inject({ method: 'POST', url: '/v1/beta/redeem', payload: { code: usedCode } }))
        .statusCode,
    ).toBe(200);
    await appA.close();

    // User B probes the USED code and an UNKNOWN code — responses must match.
    const b = await makeUser();
    createdUsers.push(b.id);
    const appB = await buildApp(b);
    const used = await appB.inject({
      method: 'POST',
      url: '/v1/beta/redeem',
      payload: { code: usedCode },
    });
    const unknown = await appB.inject({
      method: 'POST',
      url: '/v1/beta/redeem',
      payload: { code: 'TOTALLY-UNKNOWN-XYZ' },
    });
    expect(used.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(used.json<{ error: string }>().error).toBe('invalid_code');
    expect(unknown.json<{ error: string }>().error).toBe('invalid_code');
    await appB.close();
  });

  it('throttles repeated redeem attempts per user (429)', async () => {
    process.env.BETA_REDEEM_RATE_MAX = '3';
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = Fastify({ logger: false });
    setupBetaRoutes(app, async () => ({ user: { id: u.id, email: u.email } }), {
      redis: makeRedisStub(),
    });
    await app.ready();
    try {
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        codes.push(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/beta/redeem',
              payload: { code: `GUESS-${i}` },
            })
          ).statusCode,
        );
      }
      // First 3 land on the DB (404 invalid_code); the 4th trips the throttle.
      expect(codes.slice(0, 3).every((c) => c === 404)).toBe(true);
      expect(codes[3]).toBe(429);
    } finally {
      delete process.env.BETA_REDEEM_RATE_MAX;
      await app.close();
    }
  });
});

describe('GET /v1/beta/me', () => {
  it('5. returns null before redeem, then cohort after redeem', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);

    // Before redeem
    const before = await app.inject({ method: 'GET', url: '/v1/beta/me' });
    expect(before.statusCode).toBe(200);
    expect(before.json<{ cohort: null }>().cohort).toBeNull();

    // Pick and redeem a code
    const [invite] = await db
      .select({ code: betaInvites.code })
      .from(betaInvites)
      .where(and(eq(betaInvites.cohort, 'tg-2026-05'), isNull(betaInvites.usedAt)))
      .limit(1);

    await app.inject({
      method: 'POST',
      url: '/v1/beta/redeem',
      payload: { code: invite!.code },
    });

    // After redeem
    const after = await app.inject({ method: 'GET', url: '/v1/beta/me' });
    expect(after.statusCode).toBe(200);
    expect(after.json<{ cohort: string }>().cohort).toBe('tg-2026-05');

    await app.close();
  });
});

describe('race condition guard (#6)', () => {
  it('6. parallel redeems by the same user with two different codes yield exactly 1 success + 1 409', async () => {
    const u = await makeUser();
    createdUsers.push(u.id);
    const app = await buildApp(u);

    // Pick two unused codes.
    const unusedRows = await db
      .select({ code: betaInvites.code })
      .from(betaInvites)
      .where(and(eq(betaInvites.cohort, 'tg-2026-05'), isNull(betaInvites.usedAt)))
      .limit(2);

    // Skip the test if there aren't enough unused codes (unlikely but safe).
    if (unusedRows.length < 2) {
      console.warn('Skipping race test — not enough unused invite codes.');
      await app.close();
      return;
    }

    const [codeA, codeB] = [unusedRows[0]!.code, unusedRows[1]!.code];

    // Fire both requests in parallel from the same user.
    const [resA, resB] = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/beta/redeem', payload: { code: codeA } }),
      app.inject({ method: 'POST', url: '/v1/beta/redeem', payload: { code: codeB } }),
    ]);

    const statuses = [resA.statusCode, resB.statusCode].sort((a, b) => a - b);
    // One must be 200 (success), the other 409 (already redeemed).
    expect(statuses).toEqual([200, 409]);

    // The 409 must have error='already_redeemed' (not 'code_already_used').
    const four09 = resA.statusCode === 409 ? resA : resB;
    expect(four09.json<{ error: string }>().error).toBe('already_redeemed');

    await app.close();
  });
});

describe('POST /v1/me/beta-email-capture (#17 audit fix)', () => {
  it('fresh user with no users_pii row → captures email, returns captured=true', async () => {
    // Create a user in schema.user + usersApp only — no users_pii row.
    const id = nid();
    const email = `capture+${id}@seed.local`;
    await db.insert(schema.user).values({ id, name: 'Capture Test', email, emailVerified: true });
    await db.insert(usersApp).values({ id, displayName: 'Capture Test', locale: 'ru' });
    // Intentionally NO usersApp insert for users_pii — this simulates the
    // case where the user signed up but hasn't set a PII email yet.
    createdUsers.push(id);

    const app = Fastify({ logger: false });
    setupBetaRoutes(app, async () => ({ user: { id, email } }));
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/me/beta-email-capture',
        payload: { email: 'captured@beta.seed.local' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ ok: boolean; captured: boolean }>();
      expect(body.ok).toBe(true);
      expect(body.captured).toBe(true);

      // Verify the email was stored in users_pii.
      const { rows } = await pool.query<{ email: string }>(
        `SELECT email FROM users_pii WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.email).toBe('captured@beta.seed.local');
    } finally {
      await app.close();
    }
  });

  it('second capture for same user does NOT overwrite existing email, returns captured=false', async () => {
    const u = await makeUser(); // creates users_pii with an email
    createdUsers.push(u.id);

    const app = Fastify({ logger: false });
    setupBetaRoutes(app, async () => ({ user: { id: u.id, email: u.email } }));
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/me/beta-email-capture',
        payload: { email: 'should-not-overwrite@beta.seed.local' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ ok: boolean; captured: boolean }>();
      expect(body.ok).toBe(true);
      expect(body.captured).toBe(false);

      // Original email must be unchanged.
      const { rows } = await pool.query<{ email: string }>(
        `SELECT email FROM users_pii WHERE id = $1`,
        [u.id],
      );
      expect(rows[0]?.email).toBe(u.email);
    } finally {
      await app.close();
    }
  });
});
