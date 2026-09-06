/**
 * Beta invite endpoints — W4.Fri.
 *
 * POST /v1/beta/redeem { code }
 *   Auth-gated. Marks the invite as used by the calling user if:
 *   - the code exists
 *   - the code is still unused
 *   - the caller has not already redeemed a different code
 *   Returns 404 for unknown codes, 409 for double-redeem.
 *
 * GET /v1/beta/me
 *   Auth-gated. Returns { cohort: string | null } for the calling user.
 *
 * POST /v1/me/beta-email-capture { email }
 *   Auth-gated. Stores the email into users_pii.email (upsert) so
 *   the founder can reach the user when payment opens. This is the
 *   "no YooKassa creds yet" fallback on the pricing page.
 */
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, betaInvites, usersPii, pool } from '@seed/db';
import { checkRateLimit } from './rate-limit';

// SF-15: brute-force ceiling on code guessing (read at request time, env-tunable).
const betaRedeemRateMax = (): number => Number(process.env.BETA_REDEEM_RATE_MAX ?? 20);
const BETA_REDEEM_WINDOW_SECONDS = 60;

const redeemSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(64)
    .transform((s) => s.trim().toUpperCase()),
});

const betaEmailSchema = z.object({
  email: z.string().email().max(254),
});

type RequireSession = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string; email: string | null } } | null>;

export function setupBetaRoutes(
  app: FastifyInstance,
  requireSession: RequireSession,
  opts: { redis?: IORedis } = {},
): void {
  /**
   * POST /v1/beta/redeem
   * Body: { code: string }
   *
   * Success  → 200 { cohort }
   * Caller already has a code         → 409 { error: 'already_redeemed' }
   * Unknown OR already-used code      → 404 { error: 'invalid_code' }
   *
   * SF-15: unknown and used-by-other collapse to the SAME 404 so a single
   * attempt can't distinguish a real (used) code from a non-existent one; a
   * per-user throttle bounds brute-force enumeration.
   */
  app.post('/v1/beta/redeem', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    if (opts.redis) {
      const rl = await checkRateLimit(
        opts.redis,
        `seed:beta-redeem:${session.user.id}`,
        betaRedeemRateMax(),
        BETA_REDEEM_WINDOW_SECONDS,
      );
      if (!rl.allowed) return reply.status(429).send({ error: 'rate_limit_exceeded' });
    }

    const parsed = redeemSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    const { code } = parsed.data;
    const userId = session.user.id;

    // Use a raw Postgres transaction with advisory SELECT FOR UPDATE to
    // prevent the race condition where two concurrent requests from the same
    // user can each pass the "already redeemed?" check before either update
    // commits (TOCTOU). The FOR UPDATE lock serialises concurrent redemptions
    // for the same code row. The per-user check inside the txn prevents one
    // user from redeeming two different codes in parallel.
    type RedeemResult =
      | { ok: true; cohort: string }
      | { ok: false; status: 404 | 409; error: string };

    const result = await pool.connect().then(async (client) => {
      try {
        await client.query('BEGIN');

        // 1. Lock the target code row (or detect it's missing / already used).
        const { rows: lockRows } = await client.query<{
          cohort: string;
          used_by_user_id: string | null;
          used_at: Date | null;
        }>(
          `SELECT cohort, used_by_user_id, used_at
           FROM beta_invites
           WHERE code = $1
           FOR UPDATE`,
          [code],
        );

        if (lockRows.length === 0) {
          await client.query('ROLLBACK');
          // SF-15: same response as used-by-other (no existence oracle).
          return { ok: false, status: 404, error: 'invalid_code' } satisfies RedeemResult;
        }

        const row = lockRows[0]!;

        // Idempotent: caller already owns this exact code.
        if (row.used_by_user_id === userId) {
          await client.query('ROLLBACK');
          return { ok: true, cohort: row.cohort } satisfies RedeemResult;
        }

        // Someone else already claimed the code — SF-15: indistinguishable from
        // an unknown code so the endpoint isn't a validity oracle.
        if (row.used_at !== null) {
          await client.query('ROLLBACK');
          return { ok: false, status: 404, error: 'invalid_code' } satisfies RedeemResult;
        }

        // 2. Check if THIS user has already redeemed any code (different code race).
        const { rows: userRows } = await client.query<{ code: string }>(
          `SELECT code FROM beta_invites WHERE used_by_user_id = $1 LIMIT 1`,
          [userId],
        );
        if (userRows.length > 0) {
          await client.query('ROLLBACK');
          return { ok: false, status: 409, error: 'already_redeemed' } satisfies RedeemResult;
        }

        // 3. Claim the code.
        await client.query(
          `UPDATE beta_invites SET used_at = now(), used_by_user_id = $1 WHERE code = $2`,
          [userId, code],
        );

        await client.query('COMMIT');
        return { ok: true, cohort: row.cohort } satisfies RedeemResult;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    });

    if (!result.ok) {
      return reply.status(result.status).send({ error: result.error });
    }
    return { cohort: result.cohort };
  });

  /**
   * GET /v1/beta/me
   * Returns { cohort: string | null }
   */
  app.get('/v1/beta/me', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const rows = await db
      .select({ cohort: betaInvites.cohort })
      .from(betaInvites)
      .where(and(eq(betaInvites.usedByUserId, session.user.id), isNotNull(betaInvites.usedAt)))
      .limit(1);

    return { cohort: rows[0]?.cohort ?? null };
  });

  /**
   * POST /v1/me/beta-email-capture
   * Body: { email }
   *
   * Stores the email into users_pii.email (upsert) for the
   * "payment coming soon" beta capture flow on /pricing.
   * 152-ФЗ: users_pii is the PII tombstone-aware table.
   */
  app.post('/v1/me/beta-email-capture', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const parsed = betaEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    // INSERT ... ON CONFLICT: create a users_pii row if one doesn't exist
    // yet, otherwise only update email if the existing row has email IS NULL.
    // This prevents overwriting a user's confirmed email with a beta-capture
    // value and ensures the endpoint is idempotent. (#17 audit fix)
    const result = await pool.query<{ captured: boolean }>(
      `INSERT INTO users_pii (id, email)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE
         SET email = EXCLUDED.email
         WHERE users_pii.email IS NULL
       RETURNING (xmax = 0 OR users_pii.email = $2) AS captured`,
      [session.user.id, parsed.data.email],
    );

    // xmax=0 means INSERT (new row); xmax>0 means UPDATE.
    // If the WHERE clause blocked the update (email was already set),
    // no row is returned — captured = false.
    const captured = (result.rows[0]?.captured as boolean | undefined) ?? false;

    return { ok: true, captured };
  });
}
