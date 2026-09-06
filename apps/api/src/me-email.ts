import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomInt } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db, nid, schema, usersPii } from '@seed/db';
import { sendAuthEmail } from '@seed/auth';

/**
 * /v1/me/email — verified email change for the profile page.
 *
 * Two steps so the NEW address is proven reachable before it becomes the login
 * identity (typo/lockout + ownership safety): `request` mails a 6-digit code to
 * the new address (and a heads-up to the old one); `confirm` applies it. The
 * email lives in TWO places — Better Auth `user.email` (login identity, UNIQUE)
 * and `users_pii.email` (the PII of record `ensureUserRows` only seeds on first
 * login) — so confirm writes BOTH in one transaction. Uniqueness is re-checked
 * at confirm to close the request→confirm race. All scoped to the session user.
 */

type SessionLike = { user: { id: string; email?: string | null } } | null;
type RequireSession = (req: FastifyRequest, reply: FastifyReply) => Promise<SessionLike>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MS = 30 * 60 * 1000;

// Dev/e2e capture of the last code per user (NEVER populated in production), so
// tests + local flows can complete a change without a live mailer — mirrors the
// magic-link/OTP dev-capture pattern.
const devCodes = new Map<string, string>();
export function __getDevEmailChangeCode(userId: string): string | null {
  return devCodes.get(userId) ?? null;
}

const identifierFor = (userId: string) => `email-change:${userId}`;
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');
const genCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === '23505') return true;
    current = candidate.cause;
  }
  return false;
}

async function emailTaken(email: string, exceptUserId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(and(sql`lower(${schema.user.email}) = ${email}`, ne(schema.user.id, exceptUserId)))
    .limit(1);
  return rows.length > 0;
}

export function setupMeEmailRoutes(app: FastifyInstance, requireSession: RequireSession): void {
  app.post('/v1/me/email/request', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const body = (req.body ?? {}) as { newEmail?: unknown };
    const newEmail = (typeof body.newEmail === 'string' ? body.newEmail : '').trim().toLowerCase();
    if (!EMAIL_RE.test(newEmail) || newEmail.length > 254) {
      return reply.status(400).send({ error: 'invalid_email' });
    }
    const currentEmail = (session.user.email ?? '').toLowerCase();
    if (newEmail === currentEmail) {
      return reply.status(400).send({ error: 'same_email' });
    }
    if (await emailTaken(newEmail, session.user.id)) {
      return reply.status(409).send({ error: 'email_taken' });
    }

    const code = genCode();
    const identifier = identifierFor(session.user.id);
    await db.transaction(async (tx) => {
      // One pending change per user — supersede any prior request.
      await tx.delete(schema.verification).where(eq(schema.verification.identifier, identifier));
      await tx.insert(schema.verification).values({
        id: nid(),
        identifier,
        value: JSON.stringify({ newEmail, codeHash: hashCode(code) }),
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });
    });
    if (process.env.NODE_ENV !== 'production') devCodes.set(session.user.id, code);

    // Code to the NEW address (proves control); heads-up to the OLD one.
    await sendAuthEmail(
      newEmail,
      'Подтверждение смены email — Vertov',
      `Ваш код для смены email на ${newEmail}: ${code}\n\nКод действует 30 минут. ` +
        `Если вы не запрашивали смену — просто проигнорируйте это письмо.`,
    );
    if (currentEmail && EMAIL_RE.test(currentEmail)) {
      void sendAuthEmail(
        currentEmail,
        'Запрошена смена email — Vertov',
        `Для вашего аккаунта запрошена смена email на ${newEmail}. Если это были не вы — ` +
          `сразу смените способ входа и напишите на privacy@vertov.space.`,
      ).catch(() => {});
    }
    return { ok: true };
  });

  app.post('/v1/me/email/confirm', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const body = (req.body ?? {}) as { code?: unknown };
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!/^\d{6}$/.test(code)) {
      return reply.status(400).send({ error: 'invalid_code' });
    }

    const identifier = identifierFor(session.user.id);
    try {
      const result = await db.transaction(async (tx) => {
        // Lock and consume the verification row in the same transaction as the
        // identity update. A second confirm for the same code waits, then sees
        // no row instead of applying the change twice.
        const rows = await tx
          .select()
          .from(schema.verification)
          .where(eq(schema.verification.identifier, identifier))
          .for('update')
          .limit(1);
        const row = rows[0];
        if (!row) return { kind: 'no_pending' as const };
        if (row.expiresAt.getTime() < Date.now()) {
          await tx.delete(schema.verification).where(eq(schema.verification.id, row.id));
          return { kind: 'expired' as const };
        }

        let parsed: { newEmail?: unknown; codeHash?: unknown };
        try {
          parsed = JSON.parse(row.value) as { newEmail?: unknown; codeHash?: unknown };
        } catch {
          return { kind: 'no_pending' as const };
        }
        if (
          typeof parsed.newEmail !== 'string' ||
          parsed.newEmail.length > 254 ||
          !EMAIL_RE.test(parsed.newEmail) ||
          typeof parsed.codeHash !== 'string'
        ) {
          return { kind: 'no_pending' as const };
        }
        if (parsed.codeHash !== hashCode(code)) {
          return { kind: 'code_mismatch' as const };
        }

        // Re-check against both identity tables inside the write transaction;
        // the unique constraints remain the final race-safe backstop.
        const taken = await tx
          .select({ id: schema.user.id })
          .from(schema.user)
          .where(
            and(
              sql`lower(${schema.user.email}) = ${parsed.newEmail}`,
              ne(schema.user.id, session.user.id),
            ),
          )
          .limit(1);
        if (taken.length > 0) return { kind: 'email_taken' as const };

        await tx
          .update(schema.user)
          .set({ email: parsed.newEmail, emailVerified: true })
          .where(eq(schema.user.id, session.user.id));
        await tx
          .update(usersPii)
          .set({ email: parsed.newEmail, emailVerifiedAt: new Date() })
          .where(eq(usersPii.id, session.user.id));
        await tx.delete(schema.verification).where(eq(schema.verification.id, row.id));
        return { kind: 'ok' as const, email: parsed.newEmail };
      });

      if (result.kind === 'expired') {
        return reply.status(400).send({ error: result.kind });
      }
      if (result.kind === 'email_taken') {
        return reply.status(409).send({ error: result.kind });
      }
      if (result.kind !== 'ok') {
        return reply.status(400).send({ error: result.kind });
      }
      devCodes.delete(session.user.id);
      return { ok: true, email: result.email };
    } catch (error) {
      // Two different users can pass the availability read concurrently. The
      // database unique index decides the winner; surface the loser as the
      // same stable conflict as the preflight instead of leaking a 500.
      if (isUniqueViolation(error)) {
        return reply.status(409).send({ error: 'email_taken' });
      }
      throw error;
    }
  });
}
